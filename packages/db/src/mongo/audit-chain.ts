import { createHash, randomBytes } from 'node:crypto';
import type { AnyBulkWriteOperation, ClientSession, Db, MongoClient } from 'mongodb';
import { canonicalJson } from './canonical';

export const AUDIT_EVENTS = 'audit_events';
export const AUDIT_HEADS = 'audit_heads';
/** Chain key for events outside any workspace (SAMPLEDGE Super Admin actions), as in the PostgreSQL schema. */
export const PLATFORM_CHAIN = '00000000-0000-0000-0000-000000000000';

export type AuditActorType = 'user' | 'platform_admin' | 'system' | 'ai_agent' | 'integration';
export const AUDIT_ACTION = /^[a-z_]+(\.[a-z_]+)+$/;

export interface AuditEventInput {
  tenant_id: string | null;
  actor_type: AuditActorType;
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  changes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
}

export interface AuditEventDoc extends AuditEventInput {
  _id: string;
  /** Null, with `pending: true`, until linkAuditChain gives the event its place in the chain. */
  chain_seq: number | null;
  prev_hash: string | null;
  hash: string | null;
  created_at: Date;
  pending?: true;
}

interface AuditHead {
  _id: string;
  seq: number;
  hash: string | null;
}

/** The hashed fields, in the same order and format as audit_event_payload() in the PostgreSQL schema. */
export function auditPayload(e: Pick<AuditEventDoc, 'tenant_id' | 'chain_seq' | 'actor_type' | 'actor_id' | 'action' | 'resource_type' | 'resource_id' | 'changes' | 'metadata' | 'created_at'>): string {
  return [
    e.tenant_id ?? '-',
    String(e.chain_seq),
    e.actor_type,
    e.actor_id ?? '-',
    e.action,
    e.resource_type,
    e.resource_id ?? '-',
    canonicalJson(e.changes),
    canonicalJson(e.metadata),
    e.created_at.toISOString(),
  ].join('|');
}

export function auditHash(prev_hash: string | null, payload: string): string {
  return createHash('sha256')
    .update(prev_hash ? Buffer.from(prev_hash, 'hex') : Buffer.alloc(0))
    .update(payload, 'utf8')
    .digest('hex');
}

/**
 * Records one audit event inside the caller's transaction, so it commits or rolls back with the change it describes.
 *
 * The event is written as pending: its place in the chain (chain_seq, prev_hash, hash) is given right after the
 * transaction commits, by linkAuditChain. Linking inside every write transaction made each one read and move the
 * workspace's chain head, and under snapshot isolation any other commit in the workspace meanwhile aborted it, so
 * busy workspaces ran their transactions again and again. Linking takes one short transaction per batch instead, and
 * events are linked in the order they were recorded.
 */
export async function appendAuditEvent(db: Db, session: ClientSession, input: AuditEventInput): Promise<AuditEventDoc> {
  if (!session.inTransaction()) throw new Error('appendAuditEvent must run inside a transaction');
  if (!AUDIT_ACTION.test(input.action)) throw new Error(`Invalid audit action "${input.action}"`);
  const event: AuditEventDoc = { _id: orderedUuid(), ...input, chain_seq: null, prev_hash: null, hash: null, created_at: new Date(), pending: true };
  await db.collection<AuditEventDoc>(AUDIT_EVENTS).insertOne(event, { session });
  return event;
}

const LINK_BATCH = 500;

let lastMs = 0;
let counter = 0;
/**
 * A UUIDv7: the first 48 bits are the time in milliseconds and the next 12 count up within a millisecond, so ids
 * sort in the order this process recorded the events (several in one transaction share a millisecond).
 */
export function orderedUuid(now = Date.now()): string {
  if (now <= lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1;
      counter = 0;
    }
  } else {
    lastMs = now;
    counter = 0;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(lastMs, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Gives every pending event of one chain (a workspace, or the platform with `null`) its place: the next sequence
 * number, the previous event's hash and its own hash, in the order the events were recorded. Each batch is one
 * transaction that also moves the chain head, so two linkers cannot both use one position: the second is aborted,
 * runs again and finds nothing left. Returns how many events it linked.
 */
export async function linkAuditChain(client: MongoClient, db: Db, tenant_id: string | null): Promise<number> {
  const key = tenant_id ?? PLATFORM_CHAIN;
  let linked = 0;
  for (;;) {
    const session = client.startSession();
    let n = 0;
    try {
      await session.withTransaction(
        async () => {
          n = 0;
          const events = db.collection<AuditEventDoc>(AUDIT_EVENTS);
          const pending = await events
            .find({ tenant_id: tenant_id ?? null, pending: true }, { session })
            .sort({ created_at: 1, _id: 1 })
            .limit(LINK_BATCH)
            .toArray();
          if (!pending.length) return;
          const heads = db.collection<AuditHead>(AUDIT_HEADS);
          await heads.updateOne({ _id: key }, { $setOnInsert: { seq: 0, hash: null } }, { upsert: true, session });
          const head = (await heads.findOne({ _id: key }, { session }))!;
          let seq = head.seq;
          let prev = head.hash;
          const ops: AnyBulkWriteOperation<AuditEventDoc>[] = [];
          for (const e of pending) {
            seq += 1;
            const hash = auditHash(prev, auditPayload({ ...e, chain_seq: seq }));
            ops.push({ updateOne: { filter: { _id: e._id, pending: true }, update: { $set: { chain_seq: seq, prev_hash: prev, hash }, $unset: { pending: '' } } } });
            prev = hash;
          }
          const done = await events.bulkWrite(ops, { session, ordered: true });
          if (done.modifiedCount !== pending.length) throw new Error(`Audit chain ${key}: events changed while being linked`);
          const moved = await heads.updateOne({ _id: key, seq: head.seq }, { $set: { seq, hash: prev } }, { session });
          if (moved.modifiedCount !== 1) throw new Error(`Audit chain ${key} moved while linking`);
          n = pending.length;
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' },
      );
    } finally {
      await session.endSession();
    }
    linked += n;
    if (n < LINK_BATCH) return linked;
  }
}

/** Links every chain that has pending events (after a crash between a commit and its linking). Returns how many. */
export async function linkPendingAuditEvents(client: MongoClient, db: Db): Promise<number> {
  const chains = (await db.collection(AUDIT_EVENTS).distinct('tenant_id', { pending: true })) as Array<string | null>;
  let n = 0;
  for (const tenant of chains) n += await linkAuditChain(client, db, tenant ?? null);
  return n;
}

/** Recomputes a chain. Returns how many events were checked and the first broken sequence number, if any. */
export async function verifyAuditChain(db: Db, tenant_id: string | null): Promise<{ checked: number; firstBrokenSeq: number | null }> {
  const cursor = db
    .collection<AuditEventDoc>(AUDIT_EVENTS)
    .find({ tenant_id: tenant_id ?? null, pending: { $exists: false } })
    .sort({ chain_seq: 1 });
  let expectedPrev: string | null = null;
  let n = 0;
  for await (const e of cursor) {
    n += 1;
    if (e.chain_seq !== n || e.prev_hash !== expectedPrev || e.hash !== auditHash(expectedPrev, auditPayload(e))) {
      return { checked: n, firstBrokenSeq: e.chain_seq };
    }
    expectedPrev = e.hash;
  }
  return { checked: n, firstBrokenSeq: null };
}

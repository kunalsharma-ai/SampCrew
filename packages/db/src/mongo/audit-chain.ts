import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession, Db } from 'mongodb';
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
  chain_seq: number;
  prev_hash: string | null;
  hash: string;
  created_at: Date;
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
 * Appends one event to its workspace's hash chain inside the caller's transaction.
 *
 * Each chain has a head document (last sequence number and hash). The event is linked to the head that this
 * transaction read, and the head is moved forward in the same transaction. Two transactions appending to one chain
 * both write that head, so MongoDB aborts one with a transient write conflict and the transaction is retried: the
 * chain stays linear without a lock. Call it last in the transaction (see deferUntilCommit) so the head is held
 * for as short a time as possible.
 */
export async function appendAuditEvent(db: Db, session: ClientSession, input: AuditEventInput): Promise<AuditEventDoc> {
  if (!session.inTransaction()) throw new Error('appendAuditEvent must run inside a transaction');
  if (!AUDIT_ACTION.test(input.action)) throw new Error(`Invalid audit action "${input.action}"`);
  const heads = db.collection<AuditHead>(AUDIT_HEADS);
  const key = input.tenant_id ?? PLATFORM_CHAIN;
  await heads.updateOne({ _id: key }, { $setOnInsert: { seq: 0, hash: null } }, { upsert: true, session });
  const head = (await heads.findOne({ _id: key }, { session }))!;
  const event: AuditEventDoc = {
    _id: randomUUID(),
    ...input,
    chain_seq: head.seq + 1,
    prev_hash: head.hash,
    created_at: new Date(),
    hash: '',
  };
  event.hash = auditHash(head.hash, auditPayload(event));
  const moved = await heads.updateOne({ _id: key, seq: head.seq }, { $set: { seq: event.chain_seq, hash: event.hash } }, { session });
  if (moved.modifiedCount !== 1) throw new Error(`Audit chain ${key} moved during the transaction`);
  await db.collection<AuditEventDoc>(AUDIT_EVENTS).insertOne(event, { session });
  return event;
}

/** Recomputes a chain. Returns how many events were checked and the first broken sequence number, if any. */
export async function verifyAuditChain(db: Db, tenant_id: string | null): Promise<{ checked: number; firstBrokenSeq: number | null }> {
  const cursor = db
    .collection<AuditEventDoc>(AUDIT_EVENTS)
    .find({ tenant_id: tenant_id ?? null })
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

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
  tenantId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  changes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface AuditEventDoc extends AuditEventInput {
  _id: string;
  chainSeq: number;
  prevHash: string | null;
  hash: string;
  createdAt: Date;
}

interface AuditHead {
  _id: string;
  seq: number;
  hash: string | null;
}

/** The hashed fields, in the same order and format as audit_event_payload() in the PostgreSQL schema. */
export function auditPayload(e: Pick<AuditEventDoc, 'tenantId' | 'chainSeq' | 'actorType' | 'actorId' | 'action' | 'resourceType' | 'resourceId' | 'changes' | 'metadata' | 'createdAt'>): string {
  return [
    e.tenantId ?? '-',
    String(e.chainSeq),
    e.actorType,
    e.actorId ?? '-',
    e.action,
    e.resourceType,
    e.resourceId ?? '-',
    canonicalJson(e.changes),
    canonicalJson(e.metadata),
    e.createdAt.toISOString(),
  ].join('|');
}

export function auditHash(prevHash: string | null, payload: string): string {
  return createHash('sha256')
    .update(prevHash ? Buffer.from(prevHash, 'hex') : Buffer.alloc(0))
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
  const key = input.tenantId ?? PLATFORM_CHAIN;
  await heads.updateOne({ _id: key }, { $setOnInsert: { seq: 0, hash: null } }, { upsert: true, session });
  const head = (await heads.findOne({ _id: key }, { session }))!;
  const event: AuditEventDoc = {
    _id: randomUUID(),
    ...input,
    chainSeq: head.seq + 1,
    prevHash: head.hash,
    createdAt: new Date(),
    hash: '',
  };
  event.hash = auditHash(head.hash, auditPayload(event));
  const moved = await heads.updateOne({ _id: key, seq: head.seq }, { $set: { seq: event.chainSeq, hash: event.hash } }, { session });
  if (moved.modifiedCount !== 1) throw new Error(`Audit chain ${key} moved during the transaction`);
  await db.collection<AuditEventDoc>(AUDIT_EVENTS).insertOne(event, { session });
  return event;
}

/** Recomputes a chain. Returns how many events were checked and the first broken sequence number, if any. */
export async function verifyAuditChain(db: Db, tenantId: string | null): Promise<{ checked: number; firstBrokenSeq: number | null }> {
  const cursor = db
    .collection<AuditEventDoc>(AUDIT_EVENTS)
    .find({ tenantId: tenantId ?? null })
    .sort({ chainSeq: 1 });
  let expectedPrev: string | null = null;
  let n = 0;
  for await (const e of cursor) {
    n += 1;
    if (e.chainSeq !== n || e.prevHash !== expectedPrev || e.hash !== auditHash(expectedPrev, auditPayload(e))) {
      return { checked: n, firstBrokenSeq: e.chainSeq };
    }
    expectedPrev = e.hash;
  }
  return { checked: n, firstBrokenSeq: null };
}

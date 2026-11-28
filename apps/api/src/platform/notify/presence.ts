import type { MongoService, TenantTx } from '../database/mongo.service';

/**
 * Who is online (28 November 2026, the corner chat): a member counts as online while one of their browsers holds the
 * live stream open. The stream stamps `member_presence.seen_at` when it opens and on every heartbeat (25 seconds),
 * so the stamp works across every API server; a member whose stamp is older than this window is shown offline.
 */
export const ONLINE_WINDOW_MS = 70_000;

/** Stamp the member as seen now. Never throws: presence is a hint, not a record. */
export async function touchPresence(db: MongoService, scope: { tenantId: string; userId: string }, membershipId: string): Promise<void> {
  try {
    const seen = { seen_at: new Date() };
    await db.tenant((tx) => tx.collection('member_presence').upsert({ membership_id: membershipId }, { membership_id: membershipId, ...seen }, { $set: seen }), scope);
  } catch {
    // A missed stamp only shows the member offline until the next heartbeat.
  }
}

/** The members of `ids` who are online now. */
export async function onlineMembers(tx: TenantTx, ids: (string | null | undefined)[], now = Date.now()): Promise<Set<string>> {
  const want = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (!want.length) return new Set();
  const rows = await tx.collection('member_presence').find({ membership_id: { $in: want }, seen_at: { $gte: new Date(now - ONLINE_WINDOW_MS) } }, { projection: { membership_id: 1 } });
  return new Set(rows.map((r) => r.membership_id as string));
}

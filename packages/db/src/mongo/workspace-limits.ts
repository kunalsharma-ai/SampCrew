import { UNLIMITED, WORKSPACE_LIMIT_KEY, workspaceLimitMessage, type WorkspaceLimitKind } from '@crew/contracts';
import type { ClientSession, Db, Document } from 'mongodb';
import { ConstraintError, LOCK_FIELD } from './engine';
import type { RowGuard } from './row-guards';

/**
 * The database's own check on the plan's workspace limits (see @crew/contracts workspace-limits.ts), like a
 * PostgreSQL trigger: a write that would make one more HR Workspace or Employee Workspace than the company's plan
 * allows aborts the transaction, whatever code made it. The API checks first and explains; this is the backstop that
 * a missed code path, a script or a race cannot get past.
 *
 * Concurrency: before counting, the guard writes to the company's subscription document, so two transactions adding
 * a workspace at the same time conflict, one is retried, and its count then sees the other's workspace.
 */

/** What each limit counts: the documents of one table that hold a place. */
export const WORKSPACE_LIMIT_COUNTED: Record<WorkspaceLimitKind, { table: string; filter: Document; holds: (doc: Document) => boolean }> = {
  hr: { table: 'hr_workspaces', filter: { archived_at: null }, holds: (d) => d.archived_at === null || d.archived_at === undefined },
  employee: { table: 'memberships', filter: { status: { $ne: 'suspended' } }, holds: (d) => d.status !== 'suspended' },
};

export interface WorkspaceLimitBreakdown {
  /** null: no limit. */
  limit: number | null;
  plan: number | null;
  addons: number;
  override: number | null;
}

/**
 * The company's limit as the entitlement chain computes it (apps/api loadEntitlements): the plan's figure, plus active
 * limit add-ons, replaced by a per-company figure SAMPLEDGE set (subscriptions.feature_overrides). A cancelled or
 * suspended subscription has no limits (it is read-only instead), and -1 means unlimited.
 */
export async function workspaceLimitFor(db: Db, session: ClientSession | undefined, tenantId: string, kind: WorkspaceLimitKind): Promise<WorkspaceLimitBreakdown> {
  const key = WORKSPACE_LIMIT_KEY[kind];
  const none = { limit: null, plan: null, addons: 0, override: null };
  const sub = await db.collection('subscriptions').findOne({ tenant_id: tenantId }, { session });
  if (!sub || sub.status === 'cancelled' || sub.status === 'suspended') return none;
  const pf = await db.collection('plan_features').findOne({ plan_id: sub.plan_id, feature_key: key }, { session });
  const planValue = typeof pf?.limit_value === 'number' ? (pf.limit_value as number) : null;
  let limit: number | undefined = planValue === null ? undefined : planValue;
  let addons = 0;
  const bought = await db.collection('subscription_addons').find({ tenant_id: tenantId, status: 'active' }, { session }).toArray();
  if (bought.length) {
    const defs = new Map((await db.collection('addons').find({ _id: { $in: bought.map((b) => b.addon_id) }, kind: 'limit', feature_key: key }, { session }).toArray()).map((a) => [String(a._id), a]));
    for (const b of bought) {
      const d = defs.get(String(b.addon_id));
      if (!d) continue;
      const more = Number(d.unit_quantity) * Number(b.quantity);
      addons += more;
      if (limit !== UNLIMITED) limit = (limit ?? 0) + more;
    }
  }
  const o = (sub.feature_overrides ?? {})[key];
  const override = typeof o === 'number' ? o : null;
  if (override !== null) limit = override;
  return { limit: limit === undefined || limit === UNLIMITED ? null : limit, plan: planValue === UNLIMITED ? null : planValue, addons, override: override === UNLIMITED ? null : override };
}

export async function countWorkspaces(db: Db, session: ClientSession | undefined, tenantId: string, kind: WorkspaceLimitKind): Promise<number> {
  const c = WORKSPACE_LIMIT_COUNTED[kind];
  return db.collection(c.table).countDocuments({ tenant_id: tenantId, ...c.filter }, { session });
}

/** Raised by the guard; the API renders it as 402 workspace_limit_reached with this message. */
export class WorkspaceLimitError extends ConstraintError {
  constructor(readonly kind: WorkspaceLimitKind, readonly used: number, readonly limit: number, table: string) {
    super('P0402', workspaceLimitMessage(kind, used, limit), `workspace_limit:${WORKSPACE_LIMIT_KEY[kind]}`, table);
  }
}

function guard(kind: WorkspaceLimitKind): RowGuard {
  const counted = WORKSPACE_LIMIT_COUNTED[kind];
  return async (ctx, op, before, after) => {
    if (op === 'delete' || !after) return;
    // Only a document that starts to hold a place: a new one, or one coming back (unarchived, unsuspended).
    if (!counted.holds(after) || (before && counted.holds(before))) return;
    const tenantId = after.tenant_id as string | undefined;
    if (!tenantId) return;
    await ctx.db.collection('subscriptions').updateOne({ tenant_id: tenantId }, { $inc: { [LOCK_FIELD]: 1 } }, { session: ctx.session });
    const { limit } = await workspaceLimitFor(ctx.db, ctx.session, tenantId, kind);
    if (limit === null) return;
    const existing = await countWorkspaces(ctx.db, ctx.session, tenantId, kind);
    // Inserts are checked before they are written (and a batch shares one count); updates after, so they are counted.
    const pendingKey = `workspace_limit:${kind}:${tenantId}`;
    const pending = op === 'insert' ? (ctx.pending.get(pendingKey) ?? 0) + 1 : 0;
    if (op === 'insert') ctx.pending.set(pendingKey, pending);
    const used = existing + pending;
    if (used > limit) throw new WorkspaceLimitError(kind, used - 1, limit, ctx.table);
  };
}

export const WORKSPACE_LIMIT_GUARDS: Record<string, RowGuard> = {
  workspace_limit_hr: guard('hr'),
  workspace_limit_employee: guard('employee'),
};

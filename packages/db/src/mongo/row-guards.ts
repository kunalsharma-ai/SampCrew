import type { ClientSession, Db, Document } from 'mongodb';
import { ConstraintError } from './engine';

export type GuardOp = 'insert' | 'update' | 'delete';

export interface GuardContext {
  db: Db;
  session: ClientSession;
  table: string;
  /** Flags the caller set on the table (e.g. `erasure` for a privacy erasure that may blank frozen text). */
  flags: ReadonlySet<string>;
}

/**
 * A PostgreSQL row trigger that protected data whatever code wrote it, as a check on each changed document.
 * `before` is null for an insert and `after` is null for a delete. Throwing aborts the transaction.
 * Cascaded deletes (a whole workspace being removed) do not run guards, as pg_trigger_depth() > 1 skipped them.
 */
export type RowGuard = (ctx: GuardContext, op: GuardOp, before: Document | null, after: Document | null) => Promise<void>;

const frozenError = (message: string, table: string) => new ConstraintError('P0001', message, undefined, table);

/** payroll_frozen: once a run is finalised its figures, items and adjustments cannot change. */
const payrollFrozen: RowGuard = async (ctx, op, before, after) => {
  const message = 'A finalised payroll run cannot be changed';
  if (ctx.table === 'payroll_runs') {
    if (op !== 'insert' && before?.status === 'finalised') throw frozenError(message, ctx.table);
    return;
  }
  const runIds = [...new Set([before?.run_id, after?.run_id].filter(Boolean))];
  if (!runIds.length) return;
  const finalised = await ctx.db.collection('payroll_runs').findOne({ _id: { $in: runIds }, status: 'finalised' }, { session: ctx.session, projection: { _id: 1 } });
  if (finalised) throw frozenError(message, ctx.table);
};

/** Whether two stored values are the same (dates by time, decimals and ids by their text). */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (v === undefined ? null : v instanceof Date ? v.getTime() : v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
  return norm(a) === norm(b);
}

const changed = (before: Document, after: Document, cols: string[]) => cols.some((c) => !sameValue(before[c], after[c]));

/** helpdesk_cases_guard: cases are never deleted, a closed case is final and the original request never changes. */
const helpdeskCasesGuard: RowGuard = async (ctx, op, before, after) => {
  const fail = (m: string) => frozenError(m, ctx.table);
  if (op === 'delete') throw fail('helpdesk cases cannot be deleted');
  if (op !== 'update' || !before || !after) return;
  if (ctx.flags.has('erasure')) {
    if (after.subject !== '[erased]' || after.description !== '[erased] (personal details removed on request)' || changed(before, after, ['number', 'employee_id', 'status'])) {
      throw fail('erasure may only blank the text of a helpdesk case');
    }
    return;
  }
  if (before.status === 'closed') throw fail('closed helpdesk cases cannot be changed');
  if (changed(before, after, ['number', 'employee_id', 'raised_by_membership_id', 'description', 'created_at'])) throw fail('the original request of a helpdesk case cannot be changed');
};

/** announcements_guard: a published announcement keeps its wording and audience, and is archived, never deleted. */
const announcementsGuard: RowGuard = async (ctx, op, before, after) => {
  const fail = (m: string) => frozenError(m, ctx.table);
  if (op === 'delete') {
    if (before?.status !== 'draft') throw fail('published announcements cannot be deleted; archive them instead');
    return;
  }
  if (op !== 'update' || !before || !after) return;
  if (before.status !== 'draft' && changed(before, after, ['title', 'body', 'requires_ack', 'legal_entity_id', 'department_id', 'location_id', 'published_at'])) {
    throw fail('a published announcement cannot be reworded or readdressed');
  }
  if (before.status === 'archived' && after.status !== 'archived') throw fail('archived announcements cannot be republished');
};

/** announcement_receipts_guard: the first read stays, and an acknowledgement once given stays. */
const announcementReceiptsGuard: RowGuard = async (ctx, op, before, after) => {
  const fail = (m: string) => frozenError(m, ctx.table);
  if (op === 'delete') throw fail('announcement receipts cannot be deleted');
  if (op !== 'update' || !before || !after) return;
  if (before.acknowledged_at && !sameValue(before.acknowledged_at, after.acknowledged_at)) throw fail('an acknowledgement cannot be changed');
  if (!sameValue(before.read_at, after.read_at)) throw fail('the first read time cannot be changed');
};

/** Guards by trigger name (TableSpec.triggers). Triggers without one here are enforced in the owning service. */
export const ROW_GUARDS: Record<string, RowGuard> = {
  payroll_frozen: payrollFrozen,
  helpdesk_cases_guard: helpdeskCasesGuard,
  announcements_guard: announcementsGuard,
  announcement_receipts_guard: announcementReceiptsGuard,
};

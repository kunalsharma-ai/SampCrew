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

/** Guards by trigger name (TableSpec.triggers). Triggers without one here are enforced in the owning service. */
export const ROW_GUARDS: Record<string, RowGuard> = {
  payroll_frozen: payrollFrozen,
};

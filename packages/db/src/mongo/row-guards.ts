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

/** ai_interactions_guard: kept for audit; only the prompt and answer text may be removed (retention). */
const aiInteractionsGuard: RowGuard = async (ctx, op, before, after) => {
  const fail = (m: string) => frozenError(m, ctx.table);
  if (op === 'delete') throw fail('AI interactions are kept for audit and cannot be deleted');
  if (op !== 'update' || !before || !after) return;
  const fixed = ['tenant_id', 'membership_id', 'feature', 'status', 'provider', 'model', 'prompt_version', 'subject_type', 'subject_id', 'evidence', 'redactions',
    'input_tokens', 'output_tokens', 'credits', 'latency_ms', 'error', 'created_at'];
  if (changed(before, after, fixed)) throw fail('an AI interaction cannot be changed');
  for (const c of ['request', 'response']) {
    if (!sameValue(before[c], after[c]) && after[c] !== null && after[c] !== undefined) throw fail("an AI interaction's prompt and answer can only be removed");
  }
};

/** privacy_requests_guard: a closed request is final, except recording that its export file was deleted. */
const privacyRequestsGuard: RowGuard = async (ctx, op, before, after) => {
  if (op !== 'update' || !before || !after || before.status === 'open') return;
  const exportRemoved = before.export_storage_key && !after.export_storage_key && after.export_deleted_at && !before.export_deleted_at;
  const others = Object.keys({ ...before, ...after }).filter((k) => !['export_storage_key', 'export_deleted_at', 'updated_at', '_lock'].includes(k));
  if (exportRemoved && !changed(before, after, others)) return;
  throw frozenError('privacy request is closed', ctx.table);
};

/** The columns of a document other than `except` (and the internal lock counter). */
const otherColumns = (before: Document, after: Document, except: string[]) =>
  Object.keys({ ...before, ...after }).filter((k) => !except.includes(k) && k !== '_lock');

const ERASED = { erased: true };

/** reviews_guard: a released review is final apart from the employee's acknowledgement; submitted parts stay as submitted. */
const reviewsGuard: RowGuard = async (ctx, op, before, after) => {
  const fail = (m: string) => frozenError(m, ctx.table);
  if (op === 'insert' || !before) return;
  if (op === 'delete') {
    if (before.released_at) throw fail('A released review cannot be deleted');
    return;
  }
  if (!after) return;
  if (ctx.flags.has('erasure')) {
    const text = ['self_answers', 'manager_answers', 'employee_comment', 'excluded_reason', 'updated_at'];
    if (changed(before, after, otherColumns(before, after, text)) || !sameValue(after.self_answers, ERASED) || !sameValue(after.manager_answers, ERASED)
      || (after.employee_comment ?? null) !== null || (after.excluded_reason ?? null) !== null) {
      throw fail('erasure may only blank the text of a review');
    }
    return;
  }
  if (before.released_at) {
    if (changed(before, after, otherColumns(before, after, ['acknowledged_at', 'employee_comment', 'updated_at'])) || before.acknowledged_at) throw fail('A released review cannot be changed');
    return;
  }
  if (before.self_status === 'submitted' && changed(before, after, ['self_answers', 'self_rating', 'self_status', 'self_submitted_at'])) throw fail('A submitted self review cannot be changed');
  if (before.manager_status === 'submitted' && changed(before, after, ['manager_answers', 'manager_rating', 'manager_status', 'manager_submitted_at'])) {
    throw fail('A submitted manager review cannot be changed');
  }
};

/** review_feedback_guard: feedback that was submitted or declined is final. */
const reviewFeedbackGuard: RowGuard = async (ctx, op, before, after) => {
  const fail = (m: string) => frozenError(m, ctx.table);
  if (op === 'insert' || !before) return;
  if (op === 'update' && after && ctx.flags.has('erasure')) {
    if (changed(before, after, otherColumns(before, after, ['answers'])) || !sameValue(after.answers, ERASED)) throw fail('erasure may only blank the text of feedback');
    return;
  }
  if (before.status === 'submitted' || before.status === 'declined') throw fail('Feedback that was submitted or declined cannot be changed');
};

/** course_assignments_guard: a completed course is a fact and cannot be changed or removed. */
const courseAssignmentsGuard: RowGuard = async (ctx, op, before, after) => {
  const fail = (m: string) => frozenError(m, ctx.table);
  if (op === 'insert' || !before) return;
  if (op === 'update' && after && ctx.flags.has('erasure')) {
    if (changed(before, after, otherColumns(before, after, ['completion_note', 'cancelled_reason', 'updated_at'])) || (after.completion_note ?? null) !== null || (after.cancelled_reason ?? null) !== null) {
      throw fail('erasure may only blank the notes of a course assignment');
    }
    return;
  }
  if (before.status === 'completed') throw fail('A completed course cannot be changed');
};

/** survey_responses_anonymous: a response to an anonymous survey never names the respondent. */
const surveyResponsesAnonymous: RowGuard = async (ctx, op, _before, after) => {
  if (op !== 'insert' || !after?.employee_id) return;
  const survey = await ctx.db.collection('surveys').findOne({ _id: after.survey_id }, { session: ctx.session, projection: { anonymous: 1 } });
  if (survey?.anonymous) throw frozenError('Responses to an anonymous survey cannot name the respondent', ctx.table);
};

/** Guards by trigger name (TableSpec.triggers). Triggers without one here are enforced in the owning service. */
export const ROW_GUARDS: Record<string, RowGuard> = {
  payroll_frozen: payrollFrozen,
  helpdesk_cases_guard: helpdeskCasesGuard,
  announcements_guard: announcementsGuard,
  announcement_receipts_guard: announcementReceiptsGuard,
  ai_interactions_guard: aiInteractionsGuard,
  privacy_requests_guard: privacyRequestsGuard,
  reviews_guard: reviewsGuard,
  review_feedback_guard: reviewFeedbackGuard,
  course_assignments_guard: courseAssignmentsGuard,
  survey_responses_anonymous: surveyResponsesAnonymous,
};

/**
 * Helpdesk rules shared by the API, the Web Portal and the mobile app: case statuses, who may move a case
 * where, and response-target (SLA) states. Targets are in calendar hours; business hours and holidays are
 * not taken into account (documented as a known limit).
 */

export const CASE_STATUSES = ['open', 'in_progress', 'waiting_on_employee', 'resolved', 'closed'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type CasePriority = (typeof CASE_PRIORITIES)[number];

/** Response and resolution targets are multiplied by this factor per priority (urgent halves them). */
export const PRIORITY_FACTOR: Record<CasePriority, number> = { low: 2, normal: 1, high: 0.75, urgent: 0.5 };

/** Statuses a handler can set from each status. Closing is final. */
const HANDLER_MOVES: Record<CaseStatus, readonly CaseStatus[]> = {
  open: ['in_progress', 'waiting_on_employee', 'resolved'],
  in_progress: ['waiting_on_employee', 'resolved'],
  waiting_on_employee: ['in_progress', 'resolved'],
  resolved: ['in_progress', 'closed'],
  closed: [],
};

/** The person who raised the case can confirm a resolution (close) or reopen it. */
const REQUESTER_MOVES: Record<CaseStatus, readonly CaseStatus[]> = {
  open: [],
  in_progress: [],
  waiting_on_employee: [],
  resolved: ['closed', 'open'],
  closed: [],
};

export function allowedMoves(status: CaseStatus, role: 'handler' | 'requester'): readonly CaseStatus[] {
  return (role === 'handler' ? HANDLER_MOVES : REQUESTER_MOVES)[status];
}

export function canMove(from: CaseStatus, to: CaseStatus, role: 'handler' | 'requester'): boolean {
  return allowedMoves(from, role).includes(to);
}

/** How many days after resolution an unconfirmed case closes on its own. */
export const AUTO_CLOSE_DAYS = 7;

const HOUR = 3_600_000;

/** Due time for a target in hours, adjusted for priority. Null when the category sets no target. */
export function dueAt(startMs: number, targetHours: number | null | undefined, priority: CasePriority): number | null {
  if (targetHours === null || targetHours === undefined || targetHours <= 0) return null;
  return startMs + Math.round(targetHours * PRIORITY_FACTOR[priority] * HOUR);
}

export type TargetState = 'none' | 'on_time' | 'due_soon' | 'overdue' | 'met' | 'missed';

/**
 * State of one target. "Due soon" is the last fifth of the window (at least one hour).
 * A target met after its due time counts as missed, and stays missed.
 */
export function targetState(t: { startMs: number; dueMs: number | null; doneMs: number | null; nowMs: number }): TargetState {
  if (t.dueMs === null) return 'none';
  if (t.doneMs !== null) return t.doneMs <= t.dueMs ? 'met' : 'missed';
  if (t.nowMs > t.dueMs) return 'overdue';
  const warn = Math.max(HOUR, (t.dueMs - t.startMs) / 5);
  return t.dueMs - t.nowMs <= warn ? 'due_soon' : 'on_time';
}

/** Case reference shown to people, such as HR-0042. */
export function caseRef(number: number): string {
  return `HR-${String(number).padStart(4, '0')}`;
}

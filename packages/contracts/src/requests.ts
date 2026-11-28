import { z } from 'zod';

/**
 * Requests (28 November 2026, Kunal's written spec): one place where anyone at any level raises a request (work from
 * home, leave, early leave, late arrival, comp off, attendance regularization, other), sends it to a primary approver
 * and additional approvers, and loops in CC participants who are told but do not decide. Approvers approve, reject
 * (with a reason) or ask for changes (with what to correct); anyone on the request can comment. A leave application is
 * itself a request: it goes straight to the approvers, and the leave is booked (balance and attendance) only once it is
 * fully approved. The Super Workspace manages the categories and how each is approved (one approver, all of them, or
 * one after another) in Settings.
 */

export const REQUEST_KINDS = ['wfh', 'leave', 'early_leave', 'late_coming', 'comp_off', 'attendance_regularization', 'on_duty', 'shift_change', 'other', 'leave_cancellation'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
/** Kinds a person picks on the Create Request form (cancelling approved leave starts from the leave itself). */
export const RAISABLE_KINDS = REQUEST_KINDS.filter((k) => k !== 'leave_cancellation');

export interface RequestKindDef {
  key: RequestKind;
  label: string;
  /** One line under the label on the request type card. */
  description: string;
  /** Lucide icon name (the web maps it). */
  icon: string;
  /** Accent colour of the card and badges. */
  color: string;
  /** How the dates and times are asked: a range of days, one day with a time, or one day with a time range. */
  timing: 'days' | 'day_time' | 'day_time_range';
  /** Label of the time field(s) for this type. */
  timeLabels?: { start?: string; end?: string };
  /** Filed on the Apply for Leave form (leave type, full or half day or hours, balance). */
  isLeave?: boolean;
  /** Example reason shown as the placeholder. */
  placeholder: string;
  /** Switched on for a new workspace (the Super Workspace changes it in Settings). */
  enabledByDefault: boolean;
}

export const REQUEST_KIND_DEFS: Record<RequestKind, RequestKindDef> = {
  wfh: { key: 'wfh', label: 'Work from home', description: 'Work remotely for one or more days', icon: 'house', color: '#7c3aed', timing: 'days', timeLabels: { start: 'From (time)', end: 'To (time)' }, placeholder: 'For example: personal commitment, I will be online for all meetings.', enabledByDefault: true },
  leave: { key: 'leave', label: 'Leave', description: 'Casual, sick, earned or unpaid leave, full day, half day or hours', icon: 'plane', color: '#2563eb', timing: 'days', isLeave: true, placeholder: 'For example: family function out of town.', enabledByDefault: true },
  early_leave: { key: 'early_leave', label: 'Early leave', description: 'Leave before your shift ends', icon: 'log-out', color: '#ea580c', timing: 'day_time', timeLabels: { start: 'Leaving at' }, placeholder: 'For example: a doctor’s appointment at 5 PM.', enabledByDefault: true },
  late_coming: { key: 'late_coming', label: 'Late arrival', description: 'Arrive after your shift starts', icon: 'alarm-clock', color: '#d97706', timing: 'day_time', timeLabels: { start: 'Arriving at' }, placeholder: 'For example: dropping my child at school, I will reach by 11 AM.', enabledByDefault: true },
  comp_off: { key: 'comp_off', label: 'Comp off', description: 'A day off for working on a weekly off or holiday', icon: 'calendar-plus', color: '#0d9488', timing: 'days', placeholder: 'For example: worked on Sunday 22 November for the release.', enabledByDefault: true },
  attendance_regularization: { key: 'attendance_regularization', label: 'Attendance regularization', description: 'Fix a missed or wrong check-in or check-out', icon: 'clock', color: '#0891b2', timing: 'day_time_range', timeLabels: { start: 'Check-in', end: 'Check-out' }, placeholder: 'For example: forgot to check out, I left at 6:30 PM.', enabledByDefault: true },
  on_duty: { key: 'on_duty', label: 'On duty / client visit', description: 'Working away from the office for work', icon: 'briefcase', color: '#4f46e5', timing: 'days', timeLabels: { start: 'From (time)', end: 'To (time)' }, placeholder: 'For example: client workshop at their office.', enabledByDefault: false },
  shift_change: { key: 'shift_change', label: 'Shift change', description: 'Work different hours for some days', icon: 'repeat', color: '#be185d', timing: 'days', timeLabels: { start: 'New start time', end: 'New end time' }, placeholder: 'For example: evening classes this week, I will work 8 AM to 5 PM.', enabledByDefault: false },
  other: { key: 'other', label: 'Other request', description: 'Anything else, in your own words', icon: 'message-square-plus', color: '#475569', timing: 'days', timeLabels: { start: 'From (time)', end: 'To (time)' }, placeholder: 'Say what you need and why.', enabledByDefault: true },
  leave_cancellation: { key: 'leave_cancellation', label: 'Leave cancellation', description: 'Cancel leave that was already approved', icon: 'calendar-x', color: '#dc2626', timing: 'days', placeholder: 'For example: the trip was called off, I will be at work.', enabledByDefault: true },
};

export const REQUEST_STATUSES = ['pending', 'changes_requested', 'approved', 'rejected', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** How a request's approvers decide: any one of them, all of them at once, or one after another in order. */
export const REQUEST_WORKFLOWS = ['any', 'all', 'sequential'] as const;
export type RequestWorkflow = (typeof REQUEST_WORKFLOWS)[number];
export const REQUEST_WORKFLOW_LABELS: Record<RequestWorkflow, string> = {
  any: 'One approver is enough',
  all: 'All approvers, at the same time',
  sequential: 'All approvers, one after another',
};

/** Most approvers and CC participants on one request. */
export const REQUEST_MAX_APPROVERS = 6;
export const REQUEST_MAX_CC = 10;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30');
const date = z.iso.date('Use a date in YYYY-MM-DD format');
const reason = z.string().trim().min(5, 'Write the reason in at least 5 characters').max(1000);
const people = {
  /** The primary approver (the reporting manager, usually). */
  primaryApproverId: z.uuid('Choose the primary approver'),
  /** Other people who must approve (HR, a Super Workspace administrator ...). */
  additionalApproverIds: z.array(z.uuid()).max(REQUEST_MAX_APPROVERS - 1, `At most ${REQUEST_MAX_APPROVERS} approvers in all`).default([]),
  /** People who are told about the request and its decisions, but do not decide. */
  ccIds: z.array(z.uuid()).max(REQUEST_MAX_CC, `At most ${REQUEST_MAX_CC} CC participants`).default([]),
  /** Supporting documents uploaded first (POST /requests/files). */
  attachmentIds: z.array(z.uuid()).max(5).default([]),
};
const peopleOk = (v: { primaryApproverId: string; additionalApproverIds: string[]; ccIds: string[] }, ctx: z.RefinementCtx) => {
  const approvers = [v.primaryApproverId, ...v.additionalApproverIds];
  if (new Set(approvers).size !== approvers.length) ctx.addIssue({ code: 'custom', path: ['additionalApproverIds'], message: 'Each approver can be added once' });
  if (v.ccIds.some((c) => approvers.includes(c))) ctx.addIssue({ code: 'custom', path: ['ccIds'], message: 'A person is either an approver or a CC participant, not both' });
  if (new Set(v.ccIds).size !== v.ccIds.length) ctx.addIssue({ code: 'custom', path: ['ccIds'], message: 'Each CC participant can be added once' });
};

/** A request other than leave (leave goes on the Apply for Leave form: requestLeaveInput). */
export const requestInput = z.object({
  kind: z.enum(RAISABLE_KINDS as [RequestKind, ...RequestKind[]]),
  /** A category the Super Workspace added (it behaves like "Other request", under its own name). */
  categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional(),
  /** Needed for "Other request"; optional otherwise. */
  title: z.string().trim().max(120).optional(),
  reason,
  startDate: date,
  endDate: date.optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  /** Comp off: the weekly off or holiday you worked on. */
  workedOn: date.optional(),
  ...people,
}).strict().superRefine((v, ctx) => {
  peopleOk(v, ctx);
  if (v.kind === 'leave') ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Apply for leave on the leave form' });
  const def = REQUEST_KIND_DEFS[v.kind];
  const end = v.endDate ?? v.startDate;
  if (end < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date is before the start date' });
  if (def.timing !== 'days' && end !== v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: `${def.label} is for one day` });
  if (def.timing !== 'days' && !v.startTime) ctx.addIssue({ code: 'custom', path: ['startTime'], message: `Give the time (${def.timeLabels?.start ?? 'time'})` });
  if (def.timing === 'day_time_range' && !v.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: `Give the time (${def.timeLabels?.end ?? 'end time'})` });
  if (v.startTime && v.endTime && end === v.startDate && v.endTime <= v.startTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'The end time is before the start time' });
  if (v.kind === 'other' && !v.categoryKey && !(v.title ?? '').trim()) ctx.addIssue({ code: 'custom', path: ['title'], message: 'Give the request a title' });
  if (v.kind === 'comp_off' && !v.workedOn) ctx.addIssue({ code: 'custom', path: ['workedOn'], message: 'Say which weekly off or holiday you worked on' });
  if (v.workedOn && v.workedOn > v.startDate) ctx.addIssue({ code: 'custom', path: ['workedOn'], message: 'The day you worked must be before the day off' });
});
export type RequestInput = z.infer<typeof requestInput>;

/** Full day, half day (first or second half) or a few hours. */
export const LEAVE_DURATIONS = ['full', 'half', 'hours'] as const;
export type LeaveDuration = (typeof LEAVE_DURATIONS)[number];

/** The Apply for Leave form: it is a request, and goes straight to the approvers. */
export const requestLeaveInput = z.object({
  leaveTypeId: z.uuid('Choose the leave type'),
  startDate: date,
  endDate: date,
  duration: z.enum(LEAVE_DURATIONS).default('full'),
  /** Half day: which half (one day), or several days that start in the second half or end in the first. */
  startHalf: z.enum(['full', 'first_half', 'second_half']).default('full'),
  endHalf: z.enum(['full', 'first_half']).default('full'),
  /** Hourly leave: the hours away, on one day. */
  startTime: time.optional(),
  endTime: time.optional(),
  reason,
  /** A contact while away and who covers the work (shown on the form and in the email). */
  contactDuringLeave: z.string().trim().max(120).optional(),
  handoverTo: z.string().trim().max(120).optional(),
  ...people,
}).strict().superRefine((v, ctx) => {
  peopleOk(v, ctx);
  if (v.endDate < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date is before the start date' });
  if (v.duration !== 'full' && v.duration !== 'half' && v.startDate !== v.endDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Hourly leave is for one day' });
  if (v.duration === 'half' && v.startDate === v.endDate && v.startHalf === 'full') ctx.addIssue({ code: 'custom', path: ['startHalf'], message: 'Choose the first or the second half' });
  if (v.duration === 'hours') {
    if (!v.startTime) ctx.addIssue({ code: 'custom', path: ['startTime'], message: 'Give the time you leave' });
    if (!v.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Give the time you are back' });
    if (v.startTime && v.endTime && v.endTime <= v.startTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'The end time is before the start time' });
  }
});
export type RequestLeaveInput = z.infer<typeof requestLeaveInput>;

/** Correcting a request after an approver asked for changes: the same fields, sent again to the same approvers. */
export const requestResubmitInput = z.object({
  reason,
  startDate: date,
  endDate: date.optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  workedOn: date.optional(),
  title: z.string().trim().max(120).optional(),
  /** Leave: the leave details again. */
  leaveTypeId: z.uuid().optional(),
  duration: z.enum(LEAVE_DURATIONS).optional(),
  startHalf: z.enum(['full', 'first_half', 'second_half']).optional(),
  endHalf: z.enum(['full', 'first_half']).optional(),
  attachmentIds: z.array(z.uuid()).max(5).optional(),
  /** What was changed, for the approvers. */
  note: z.string().trim().max(500).optional(),
}).strict();
export type RequestResubmitInput = z.infer<typeof requestResubmitInput>;

/** An approver's decision on a request: approve (comment optional), reject (reason) or ask for changes (what to fix). */
export const requestDecisionInput = z.object({
  decision: z.enum(['approve', 'reject', 'changes']),
  comment: z.string().trim().max(1000).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.decision === 'reject' && !(v.comment ?? '').trim()) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Write the reason for rejecting, so the person knows why' });
  if (v.decision === 'changes' && !(v.comment ?? '').trim()) ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Say what needs to be corrected' });
});
export type RequestDecisionInput = z.infer<typeof requestDecisionInput>;

export const requestCommentInput = z.object({ body: z.string().trim().min(1, 'Write a comment').max(1000) }).strict();

export const requestListQuery = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  kind: z.enum(REQUEST_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** My Approvals: requests the caller decides (or decided), with filters. */
export const requestApprovalsQuery = z.object({
  view: z.enum(['pending', 'all', 'approved', 'rejected', 'cancelled', 'changes_requested']).default('pending'),
  kind: z.enum(REQUEST_KINDS).optional(),
  employee: z.string().trim().max(80).optional(),
  from: date.optional(),
  to: date.optional(),
  workspace: z.enum(['super', 'hr', 'employee']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const requestCancelInput = z.object({ reason: z.string().trim().max(500).optional() }).strict();

/** Cancelling approved leave (a request of its own when the policy asks for approval). */
export const leaveCancellationInput = z.object({ reason }).strict();

/** One category on the Request settings page. */
export const requestCategoryInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  label: z.string().trim().min(2).max(60),
  description: z.string().trim().max(160).default(''),
  enabled: z.boolean(),
  workflow: z.enum(REQUEST_WORKFLOWS),
  attachments: z.enum(['none', 'optional', 'required']).default('optional'),
  /** Which levels may raise it. */
  levels: z.array(z.enum(['super', 'hr', 'employee'])).min(1).default(['super', 'hr', 'employee']),
  /** A category the Super Workspace added (not built in). */
  custom: z.boolean().default(false),
});
export type RequestCategoryInput = z.infer<typeof requestCategoryInput>;

export const requestSettingsInput = z.object({
  categories: z.array(requestCategoryInput).min(1).max(40),
  /** Cancelling approved leave: straight away before it starts, or always through the approvers. */
  approvedLeaveCancellation: z.enum(['approval', 'before_start']).default('approval'),
  /** Approvers are reminded this many days before a pending request starts (0: no reminder). */
  reminderDaysBefore: z.number().int().min(0).max(14).default(1),
  /** Primary approver suggested on a new request. */
  defaultPrimary: z.enum(['manager', 'hr']).default('manager'),
  /** Add the person's HR manager as an approver to start with. */
  hrAsApprover: z.boolean().default(true),
}).strict();
export type RequestSettingsInput = z.infer<typeof requestSettingsInput>;
export interface RequestCategory extends RequestCategoryInput { kind: RequestKind; icon: string; color: string; timing: RequestKindDef['timing'] }
export interface RequestSettings extends Omit<RequestSettingsInput, 'categories'> { categories: RequestCategory[] }

/** The categories a new workspace starts with: the built-in kinds as they come. */
export function defaultRequestCategories(): RequestCategory[] {
  return RAISABLE_KINDS.map((k) => {
    const d = REQUEST_KIND_DEFS[k];
    return { key: k, kind: k, label: d.label, description: d.description, enabled: d.enabledByDefault, workflow: 'all', attachments: k === 'leave' ? 'optional' : 'optional', levels: ['super', 'hr', 'employee'], custom: false, icon: d.icon, color: d.color, timing: d.timing };
  });
}

/** A person who can be put on a request, with their level so the right one is picked. */
export interface RequestPerson {
  membershipId: string;
  name: string;
  level: 'super' | 'hr' | 'employee';
  levelLabel: string;
  workspace: string | null;
  designation: string | null;
  department: string | null;
  employeeCode: string | null;
  /** Why they are suggested: your reporting manager, your HR, Super Workspace. */
  role?: 'manager' | 'hr' | 'super' | null;
  roleLabel?: string | null;
}

export type RequestApproverStatus = 'pending' | 'waiting' | 'approved' | 'rejected' | 'changes_requested' | 'cancelled' | 'not_needed';
export interface RequestApproverView extends RequestPerson {
  /** primary or additional approver. */
  part: 'primary' | 'additional';
  status: RequestApproverStatus;
  comment: string | null;
  decidedAt: string | null;
}

/** One line of the request's history: submitted, each decision, changes asked, corrected, comments, cancelled. */
export interface RequestEventView {
  id: string;
  action: 'submitted' | 'approved' | 'rejected' | 'changes_requested' | 'resubmitted' | 'commented' | 'cancelled' | 'completed' | 'reminded' | 'cancellation_requested';
  by: string | null;
  byLevel: string | null;
  comment: string | null;
  at: string;
}

export interface RequestView {
  id: string;
  ref: string;
  kind: RequestKind;
  kindLabel: string;
  categoryKey: string;
  title: string;
  reason: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  workedOn: string | null;
  days: number;
  when: string;
  status: RequestStatus;
  statusMessage: string;
  workflow: RequestWorkflow;
  round: number;
  approvalId: string | null;
  requester: RequestPerson & { dateOfJoining?: string | null };
  approvers: RequestApproverView[];
  cc: RequestPerson[];
  /** Who it waits for now (names), when pending. */
  pendingWith: string | null;
  attachments: { id: string; name: string; href: string }[];
  events: RequestEventView[];
  /** Leave: the leave booked with it. */
  leave: { id: string; ref: string; status: string; leaveTypeId: string; leaveTypeName: string; days: string; duration: LeaveDuration; startHalf: string; endHalf: string; startTime: string | null; endTime: string | null; contactDuringLeave: string | null; handoverTo: string | null } | null;
  /** Leave cancellation: the leave it cancels. */
  cancelsLeave: { id: string; ref: string; when: string } | null;
  /** What the caller may do now. */
  can: { cancel: boolean; resubmit: boolean; comment: boolean; decide: boolean; cancelApprovedLeave: boolean };
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  cancelReason: string | null;
}

/** "REQ-3F9A21": a short reference that comes from the id (leave: "LV-3F9A21"). */
export function requestRef(id: string, kind?: RequestKind): string {
  return `${kind === 'leave' ? 'LV' : 'REQ'}-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

/** Calendar days a request covers (inclusive). */
export function requestDays(startDate: string, endDate?: string | null): number {
  const a = Date.parse(`${startDate}T00:00:00Z`);
  const b = Date.parse(`${endDate ?? startDate}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "28 Nov 2026" */
export function requestDateLabel(d: string): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return `${day} ${MONTHS[m - 1]} ${y}`;
}
/** "09:30" -> "9:30 AM" */
export function requestTimeLabel(t: string): string {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * When a request is for, in words: "28 Nov 2026 to 30 Nov 2026 (3 days)", "1 Dec 2026, leaving at 4:30 PM",
 * "2 Dec 2026, 10:00 AM to 12:00 PM".
 */
export function requestWhen(v: { kind: RequestKind; startDate: string; endDate?: string | null; startTime?: string | null; endTime?: string | null }): string {
  const def = REQUEST_KIND_DEFS[v.kind];
  const end = v.endDate ?? v.startDate;
  const n = requestDays(v.startDate, end);
  const days = end === v.startDate ? requestDateLabel(v.startDate) : `${requestDateLabel(v.startDate)} to ${requestDateLabel(end)} (${n} days)`;
  if (def.timing === 'day_time' && v.startTime) return `${days}, ${(def.timeLabels?.start ?? 'at').toLowerCase()} ${requestTimeLabel(v.startTime)}`;
  if (v.startTime && v.endTime) return `${days}, ${requestTimeLabel(v.startTime)} to ${requestTimeLabel(v.endTime)}`;
  if (v.startTime) return `${days}, from ${requestTimeLabel(v.startTime)}`;
  return days;
}

/** The request's title: its own for "Other request", else the category's label. */
export function requestTitle(kind: RequestKind, title?: string | null, categoryLabel?: string | null): string {
  const label = categoryLabel ?? REQUEST_KIND_DEFS[kind].label;
  if (kind === 'other' && title?.trim()) return title.trim();
  return title?.trim() ? `${label}: ${title.trim()}` : label;
}

/** What the person who asked sees on the request, worded once for every screen. */
export function requestStatusMessage(status: RequestStatus, waiting: { approved: number; total: number; waitingOn?: string | null; workflow?: RequestWorkflow }, by?: string | null): string {
  if (status === 'approved') return waiting.workflow === 'any' && waiting.total > 1 ? `Approved${by ? ` by ${by}` : ''}.` : 'Approved by every approver.';
  if (status === 'rejected') return `Rejected${by ? ` by ${by}` : ''}. Read the reason below.`;
  if (status === 'changes_requested') return `${by ?? 'An approver'} asked for changes. Correct the request and send it again.`;
  if (status === 'cancelled') return 'This request was cancelled.';
  if (waiting.workflow === 'any') return `Waiting for any one of ${waiting.total} ${waiting.total === 1 ? 'approver' : 'approvers'}${waiting.waitingOn ? ` (${waiting.waitingOn})` : ''}.`;
  const left = waiting.total - waiting.approved;
  return `Waiting for ${left} of ${waiting.total} ${waiting.total === 1 ? 'approver' : 'approvers'}${waiting.waitingOn ? ` (${waiting.waitingOn})` : ''}.`;
}

/** Hours between two HH:MM times on one day. */
export function hoursBetween(start: string, end: string): number {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return Math.max(0, m(end) - m(start)) / 60;
}

export type RequestApprovalsQuery = z.infer<typeof requestApprovalsQuery>;

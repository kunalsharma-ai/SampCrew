import { z } from 'zod';

/**
 * Requests (28 November 2026): anyone at any level (Super Workspace, HR Workspace, Employee Workspace) raises a
 * request for work from home, early leave, late coming, comp off, leave and so on, with a reason, the dates and times
 * it covers, and the people it goes to ("looped" approvers: their HR, their reporting manager, anyone else). Every
 * approver gets it in their Approvals and decides with a comment; a rejection needs a reason. When a leave request is
 * approved, the person is asked to apply for the leave on a pre-filled leave application form.
 */

export const REQUEST_KINDS = ['wfh', 'early_leave', 'late_coming', 'comp_off', 'leave', 'half_day', 'on_duty', 'shift_change', 'other'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

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
  /** Leads to a leave application once approved. */
  leadsToLeave?: boolean;
  /** Example reason shown as the placeholder. */
  placeholder: string;
}

export const REQUEST_KIND_DEFS: Record<RequestKind, RequestKindDef> = {
  wfh: { key: 'wfh', label: 'Work from home', description: 'Work remotely for one or more days', icon: 'house', color: '#7c3aed', timing: 'days', timeLabels: { start: 'From (time)', end: 'To (time)' }, placeholder: 'For example: plumbing work at home, I will be online for all meetings.' },
  early_leave: { key: 'early_leave', label: 'Early leave', description: 'Leave the office before your shift ends', icon: 'log-out', color: '#ea580c', timing: 'day_time', timeLabels: { start: 'Leaving at' }, placeholder: 'For example: a doctor’s appointment at 5 PM.' },
  late_coming: { key: 'late_coming', label: 'Late coming', description: 'Arrive after your shift starts', icon: 'alarm-clock', color: '#d97706', timing: 'day_time', timeLabels: { start: 'Arriving at' }, placeholder: 'For example: dropping my child at school, I will reach by 11 AM.' },
  comp_off: { key: 'comp_off', label: 'Comp off', description: 'A day off for working on a weekly off or holiday', icon: 'calendar-plus', color: '#0d9488', timing: 'days', placeholder: 'For example: worked on Sunday 22 November for the release.' },
  leave: { key: 'leave', label: 'Leave', description: 'Ask first, then apply on the leave form', icon: 'plane', color: '#2563eb', timing: 'days', leadsToLeave: true, placeholder: 'For example: family function out of town.' },
  half_day: { key: 'half_day', label: 'Half day', description: 'Take the first or second half of a day off', icon: 'clock', color: '#0891b2', timing: 'day_time_range', timeLabels: { start: 'From', end: 'To' }, leadsToLeave: true, placeholder: 'For example: bank work in the afternoon.' },
  on_duty: { key: 'on_duty', label: 'On duty / client visit', description: 'Working away from the office for work', icon: 'briefcase', color: '#4f46e5', timing: 'days', timeLabels: { start: 'From (time)', end: 'To (time)' }, placeholder: 'For example: client workshop at their office.' },
  shift_change: { key: 'shift_change', label: 'Shift change', description: 'Work different hours for some days', icon: 'repeat', color: '#be185d', timing: 'days', timeLabels: { start: 'New start time', end: 'New end time' }, placeholder: 'For example: evening classes this week, I will work 8 AM to 5 PM.' },
  other: { key: 'other', label: 'Other request', description: 'Anything else, in your own words', icon: 'message-square-plus', color: '#475569', timing: 'days', timeLabels: { start: 'From (time)', end: 'To (time)' }, placeholder: 'Say what you need and why.' },
};

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Most people a request can loop in. */
export const REQUEST_MAX_APPROVERS = 6;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 09:30');
const date = z.iso.date('Use a date in YYYY-MM-DD format');

export const requestInput = z.object({
  kind: z.enum(REQUEST_KINDS),
  /** Needed for "Other request"; optional otherwise. */
  title: z.string().trim().max(120).optional(),
  reason: z.string().trim().min(5, 'Write the reason in at least 5 characters').max(1000),
  startDate: date,
  endDate: date.optional(),
  startTime: time.optional(),
  endTime: time.optional(),
  /** Comp off: the weekly off or holiday you worked on. */
  workedOn: date.optional(),
  /** Leave and half day: the leave type you mean to use (it fills the leave form later). */
  leaveTypeId: z.uuid().optional(),
  approverMembershipIds: z.array(z.uuid()).min(1, 'Loop in at least one person').max(REQUEST_MAX_APPROVERS, `Loop in at most ${REQUEST_MAX_APPROVERS} people`),
}).strict().superRefine((v, ctx) => {
  const def = REQUEST_KIND_DEFS[v.kind];
  const end = v.endDate ?? v.startDate;
  if (end < v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date is before the start date' });
  if (def.timing !== 'days' && end !== v.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: `${def.label} is for one day` });
  if (def.timing !== 'days' && !v.startTime) ctx.addIssue({ code: 'custom', path: ['startTime'], message: `Give the time (${def.timeLabels?.start ?? 'time'})` });
  if (def.timing === 'day_time_range' && !v.endTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'Give the end time' });
  if (v.startTime && v.endTime && end === v.startDate && v.endTime <= v.startTime) ctx.addIssue({ code: 'custom', path: ['endTime'], message: 'The end time is before the start time' });
  if (v.kind === 'other' && !(v.title ?? '').trim()) ctx.addIssue({ code: 'custom', path: ['title'], message: 'Give the request a title' });
  if (v.kind === 'comp_off' && !v.workedOn) ctx.addIssue({ code: 'custom', path: ['workedOn'], message: 'Say which weekly off or holiday you worked on' });
  if (v.workedOn && v.workedOn > v.startDate) ctx.addIssue({ code: 'custom', path: ['workedOn'], message: 'The day you worked must be before the day off' });
  if (new Set(v.approverMembershipIds).size !== v.approverMembershipIds.length) ctx.addIssue({ code: 'custom', path: ['approverMembershipIds'], message: 'Each person can be looped in once' });
});
export type RequestInput = z.infer<typeof requestInput>;

export const requestListQuery = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  kind: z.enum(REQUEST_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const requestCancelInput = z.object({ reason: z.string().trim().max(500).optional() }).strict();

/** The leave application made from an approved request: the leave type, the days, and the reason (pre-filled). */
export const requestLeaveApplicationInput = z.object({
  leaveTypeId: z.uuid(),
  startDate: date,
  endDate: date,
  startHalf: z.enum(['full', 'second_half']).default('full'),
  endHalf: z.enum(['full', 'first_half']).default('full'),
  reason: z.string().trim().min(5, 'Write the reason in at least 5 characters').max(1000),
  /** A contact while away and who covers the work (shown on the form and in the email). */
  contactDuringLeave: z.string().trim().max(120).optional(),
  handoverTo: z.string().trim().max(120).optional(),
}).strict().refine((v) => v.endDate >= v.startDate, { path: ['endDate'], message: 'The end date is before the start date' });
export type RequestLeaveApplicationInput = z.infer<typeof requestLeaveApplicationInput>;

/** A person who can be looped into a request, with their level so the right one is picked. */
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

export interface RequestApproverView extends RequestPerson {
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'waiting';
  comment: string | null;
  decidedAt: string | null;
}

export interface RequestView {
  id: string;
  ref: string;
  kind: RequestKind;
  kindLabel: string;
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
  approvalId: string | null;
  requester: RequestPerson;
  approvers: RequestApproverView[];
  leaveTypeId: string | null;
  leaveTypeName: string | null;
  /** The leave application made from it, once applied. */
  leaveApplication: { id: string; status: string; ref: string; days: string; leaveTypeName: string } | null;
  /** The person may apply for leave from it now (approved leave or half day, not applied yet). */
  canApplyLeave: boolean;
  canCancel: boolean;
  createdAt: string;
  decidedAt: string | null;
  cancelReason: string | null;
}

/** "REQ-3F9A21": a short reference that comes from the id. */
export function requestRef(id: string): string {
  return `REQ-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
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
 * When a request is for, in words: "28 Nov 2026 to 30 Nov 2026 (3 days), 10:00 AM to 6:00 PM", "1 Dec 2026, leaving
 * at 4:30 PM".
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

/** The request's title: its own for "Other request", else the type's label. */
export function requestTitle(kind: RequestKind, title?: string | null): string {
  return (kind === 'other' && title?.trim()) || (title?.trim() ? `${REQUEST_KIND_DEFS[kind].label}: ${title.trim()}` : REQUEST_KIND_DEFS[kind].label);
}

/** What the person who asked sees on the request, worded once for every screen. */
export function requestStatusMessage(status: RequestStatus, waiting: { approved: number; total: number; waitingOn?: string | null }, leave?: { applied: boolean; leadsToLeave: boolean }): string {
  if (status === 'approved') {
    if (leave?.leadsToLeave && !leave.applied) return 'Approved by everyone you looped in. Apply for the leave now: the form is filled in for you.';
    if (leave?.leadsToLeave && leave.applied) return 'Approved, and your leave application has been sent.';
    return 'Approved by everyone you looped in.';
  }
  if (status === 'rejected') return 'Rejected. Read the reason in the comments below.';
  if (status === 'cancelled') return 'You cancelled this request.';
  const left = waiting.total - waiting.approved;
  return `Waiting for ${left} of ${waiting.total} ${waiting.total === 1 ? 'approver' : 'approvers'}${waiting.waitingOn ? ` (${waiting.waitingOn})` : ''}.`;
}

/** The half-day choice a half-day request maps to on the leave form: a start before 1 PM is the first half. */
export function halfFromTimes(startTime?: string | null): 'first_half' | 'second_half' {
  return startTime && startTime < '13:00' ? 'first_half' : 'second_half';
}

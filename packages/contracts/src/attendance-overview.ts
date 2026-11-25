import { z } from 'zod';
import { DAY_STATUSES, type DayStatus } from './attendance-engine';

/**
 * The attendance overview shared by Super Workspace, HR Workspace and Employee Workspace: how a stored day counts
 * (present, absent, leave...), how the attendance percentage is worked out, who may see what, and the switches the
 * Super Workspace sets for each HR Workspace. The API, the screens and the Excel export all use these, so the numbers
 * on screen and in the file are always the same.
 */

/** The statuses people see and filter by. Each stored day status maps to one of them. */
export const ATTENDANCE_BUCKETS = ['present', 'half_day', 'absent', 'leave', 'holiday', 'weekend', 'unmarked'] as const;
export type AttendanceBucket = (typeof ATTENDANCE_BUCKETS)[number];

export const ATTENDANCE_BUCKET_LABEL: Record<AttendanceBucket, string> = {
  present: 'Present', half_day: 'Half day', absent: 'Absent', leave: 'Leave', holiday: 'Holiday', weekend: 'Weekend', unmarked: 'Not counted yet',
};

/** Stored day status (attendance engine) to the bucket shown. A half day of leave counts as half present, half leave. */
export function bucketOf(status: string | null | undefined): AttendanceBucket {
  switch (status as DayStatus | undefined) {
    case 'present':
    case 'in_progress':
      return 'present';
    case 'half_day':
    case 'half_day_leave':
      return 'half_day';
    case 'absent':
    case 'missing_punch':
      return 'absent';
    case 'on_leave':
      return 'leave';
    case 'holiday':
      return 'holiday';
    case 'weekly_off':
      return 'weekend';
    default:
      return 'unmarked';
  }
}

/** The stored statuses behind a bucket (for filtering stored days by what people pick). */
export function statusesOf(bucket: AttendanceBucket): DayStatus[] {
  return DAY_STATUSES.filter((s) => s !== 'not_joined' && bucketOf(s) === bucket);
}

/** Counts of stored days by stored status, as the database groups them. */
export type StatusCounts = Partial<Record<DayStatus | string, number>>;

export interface AttendanceTotals {
  /** Days that should have been worked: every counted day except weekends and holidays. */
  workingDays: number;
  /** Present days; a half day counts 0.5. */
  present: number;
  /** Absent days, including days with a missing punch; the absent half of a half day counts 0.5. */
  absent: number;
  /** Leave days; a half day of leave counts 0.5. */
  leave: number;
  /** Half days (worked or leave), as a count of days. */
  halfDays: number;
  holidays: number;
  weekends: number;
  /** Days in the period, inside the person's employment and not in the future, that have not been counted yet. */
  unmarked: number;
  /** Days with a late arrival. */
  late: number;
  /** Present / working days, 0-100 with one decimal, or null when there are no working days. */
  percent: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Totals and the attendance percentage from counted days. Attendance % = present days / working days x 100, where
 * working days are all counted days except weekends and holidays (leave is a working day not worked). Days not
 * counted yet are shown apart and never lower the percentage.
 */
export function attendanceTotals(counts: StatusCounts, extra: { unmarked?: number; late?: number } = {}): AttendanceTotals {
  const n = (s: string) => counts[s] ?? 0;
  const halfDay = n('half_day');
  const halfLeave = n('half_day_leave');
  const present = n('present') + n('in_progress') + 0.5 * halfDay + 0.5 * halfLeave;
  const absent = n('absent') + n('missing_punch') + 0.5 * halfDay;
  const leave = n('on_leave') + 0.5 * halfLeave;
  const workingDays = present + absent + leave;
  return {
    workingDays: round1(workingDays),
    present: round1(present),
    absent: round1(absent),
    leave: round1(leave),
    halfDays: halfDay + halfLeave,
    holidays: n('holiday'),
    weekends: n('weekly_off'),
    unmarked: extra.unmarked ?? 0,
    late: extra.late ?? 0,
    percent: workingDays > 0 ? round1((present / workingDays) * 100) : null,
  };
}

/** Adds totals (for a group of people or a whole company). The percentage is worked out again from the sums. */
export function sumTotals(list: AttendanceTotals[]): AttendanceTotals {
  const s = (k: keyof AttendanceTotals) => round1(list.reduce((t, x) => t + ((x[k] as number | null) ?? 0), 0));
  const workingDays = s('workingDays');
  const present = s('present');
  return {
    workingDays, present, absent: s('absent'), leave: s('leave'), halfDays: s('halfDays'), holidays: s('holidays'), weekends: s('weekends'),
    unmarked: s('unmarked'), late: s('late'), percent: workingDays > 0 ? round1((present / workingDays) * 100) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Who may see what
// ---------------------------------------------------------------------------------------------------------------

/**
 * Permissions the Super Workspace sets for each HR Workspace (and for company-wide HR, the "central" row). New ones
 * are added here and read with levelPermission(); nothing else in the attendance system changes. `locked` ones are
 * shown but follow from the access level itself.
 */
export const HR_LEVEL_PERMISSIONS = [
  { key: 'attendance.view_own', label: 'View own attendance', description: 'Every HR Workspace person always sees their own attendance.', default: true, locked: true },
  { key: 'attendance.view_employees', label: 'View Employee Workspace attendance', description: 'The employees this HR Workspace looks after, as set by its HR Workspace access.', default: true, locked: true },
  { key: 'attendance.view_other_hr', label: 'View other HR Workspace attendance', description: 'Also see the attendance of the other HR Workspaces chosen below (their HR Workspace people and employees). Never the Super Workspace.', default: false, locked: false },
  { key: 'attendance.export', label: 'Export accessible attendance', description: 'Download the attendance this HR Workspace can see as an Excel file.', default: true, locked: false },
] as const;
export type HrLevelPermissionKey = (typeof HR_LEVEL_PERMISSIONS)[number]['key'];

/** Permissions the Super Workspace sets for every Employee Workspace. */
export const EMPLOYEE_LEVEL_PERMISSIONS = [
  { key: 'attendance.export_own', label: 'Employees can export their own attendance', description: 'Each employee can download their own attendance as an Excel file. Never anyone else.', default: true, locked: false },
] as const;
export type EmployeeLevelPermissionKey = (typeof EMPLOYEE_LEVEL_PERMISSIONS)[number]['key'];

/** The value of a permission from what is saved, falling back to its default. Locked ones are always their default. */
export function levelPermission(defs: readonly { key: string; default: boolean; locked: boolean }[], saved: Record<string, boolean> | null | undefined, key: string): boolean {
  const def = defs.find((d) => d.key === key);
  if (!def) return false;
  if (def.locked) return def.default;
  return typeof saved?.[key] === 'boolean' ? saved[key]! : def.default;
}

/** "central" stands for the company-wide group: employees in no HR Workspace and HR people not limited to one. */
export const CENTRAL_GROUP = 'central';
const groupId = z.union([z.literal(CENTRAL_GROUP), z.uuid()]);

export const hrAttendanceAccessInput = z.object({
  /** The HR Workspace (or "central") the settings are for. */
  hrWorkspaceId: groupId,
  permissions: z.record(z.string().regex(/^attendance\.[a-z_]+$/).max(60), z.boolean()).refine(
    (p) => Object.keys(p).every((k) => HR_LEVEL_PERMISSIONS.some((d) => d.key === k && !d.locked)),
    { message: 'Unknown or fixed permission' },
  ),
  /** With view_other_hr on: the other HR Workspaces (or "central") it may see; null means all of them. */
  otherHrWorkspaceIds: z.array(groupId).max(500).nullable(),
});
export type HrAttendanceAccessInput = z.infer<typeof hrAttendanceAccessInput>;

export const employeeAttendanceAccessInput = z.object({
  permissions: z.record(z.string().max(60), z.boolean()).refine(
    (p) => Object.keys(p).every((k) => EMPLOYEE_LEVEL_PERMISSIONS.some((d) => d.key === k)),
    { message: 'Unknown permission' },
  ),
});

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date (YYYY-MM-DD)');
const period = z
  .object({ from: day, to: day })
  .refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: 'Ask for at most a year at a time', path: ['to'] });

export const attendanceOverviewQuery = period;

const filters = {
  hrWorkspaceId: groupId.optional(),
  employeeId: z.uuid().optional(),
  status: z.enum(ATTENDANCE_BUCKETS).optional(),
  level: z.enum(['super', 'hr', 'employee']).optional(),
  q: z.string().trim().max(100).optional(),
};

export const attendancePeopleQuery = z.object({
  from: day, to: day, ...filters,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(25),
  sort: z.enum(['name', 'percent', 'absent', 'present']).default('name'),
}).refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: 'Ask for at most a year at a time', path: ['to'] });

export const attendanceRecordsQuery = z.object({
  from: day, to: day, ...filters,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(5).max(200).default(50),
}).refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: 'Ask for at most a year at a time', path: ['to'] });

export const ATTENDANCE_EXPORT_FORMATS = ['xlsx', 'csv', 'docx', 'pdf'] as const;
export type AttendanceExportFormat = (typeof ATTENDANCE_EXPORT_FORMATS)[number];
/** A Word or PDF report is for reading and printing: it holds at most this many date-wise rows. */
export const ATTENDANCE_REPORT_MAX_ROWS = 5_000;

export const attendanceExportQuery = z.object({
  from: day, to: day, ...filters,
  /** What goes in the workbook: everything visible, or one part. */
  include: z.enum(['all', 'people', 'records', 'hr_workspaces']).default('all'),
  /** Excel (every sheet), CSV (one table), Word or PDF (a printable report). */
  format: z.enum(ATTENDANCE_EXPORT_FORMATS).default('xlsx'),
  /** Only these people (comma-separated ids in the query); everyone visible when left out. */
  employeeIds: z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v),
    z.array(z.uuid()).max(500).optional(),
  ),
}).refine((v) => v.to >= v.from, { message: 'to is before from', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 366, { message: 'Ask for at most a year at a time', path: ['to'] });

export type AttendancePeopleQuery = z.infer<typeof attendancePeopleQuery>;
export type AttendanceRecordsQuery = z.infer<typeof attendanceRecordsQuery>;
export type AttendanceExportQuery = z.infer<typeof attendanceExportQuery>;

/** At most this many date-wise rows go into one Excel file; narrow the filters for more. */
export const ATTENDANCE_EXPORT_MAX_ROWS = 100_000;

// ---------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------

export type AttendanceViewerLevel = 'super' | 'hr' | 'employee';

export interface AttendanceCapabilities {
  level: AttendanceViewerLevel;
  /** The viewer's own employee record (null for a login without one). */
  employeeId: string | null;
  /** The HR Workspace section (all for Super Workspace; for HR Workspace only with view_other_hr). */
  hrWorkspaces: boolean;
  /** The Employee Workspace section (Super and HR Workspace). */
  employees: boolean;
  export: boolean;
  /** Super Workspace only: may change the HR Workspace attendance permissions. */
  managePermissions: boolean;
}

export interface AttendanceTrendPoint {
  date: string;
  present: number;
  absent: number;
  leave: number;
  percent: number | null;
}

export interface AttendanceOverview {
  capabilities: AttendanceCapabilities;
  from: string;
  to: string;
  today: string;
  /** The viewer's own attendance in the period (null for a login without an employee record). */
  me: { employeeId: string; name: string; totals: AttendanceTotals; today: AttendanceBucket | null } | null;
  /** Only with the Employee or HR Workspace section. */
  cards: {
    hrWorkspaces: number | null;
    employees: number;
    presentToday: number;
    absentToday: number;
    onLeaveToday: number;
    notCountedToday: number;
    totals: AttendanceTotals;
  } | null;
  trend: AttendanceTrendPoint[];
}

export interface AttendancePersonRow {
  employeeId: string;
  name: string;
  code: string;
  level: AttendanceViewerLevel;
  hrWorkspaceId: string | null;
  hrWorkspaceName: string;
  department: string | null;
  today: AttendanceBucket | null;
  totals: AttendanceTotals;
}

export interface AttendanceHrWorkspaceRow {
  id: string;
  name: string;
  code: string | null;
  status: string;
  /** HR Workspace people (its admins) the viewer can see. */
  hrPeople: number;
  employees: number;
  presentToday: number;
  absentToday: number;
  onLeaveToday: number;
  totals: AttendanceTotals;
}

export interface AttendanceRecordRow {
  employeeId: string;
  name: string;
  code: string;
  hrWorkspaceName: string;
  level: AttendanceViewerLevel;
  date: string;
  status: AttendanceBucket;
  detail: string;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  lateMinutes: number;
  timeZone: string;
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Each stored day status in words (the same words the attendance screens use). */
export const DAY_STATUS_LABEL: Record<string, string> = {
  present: 'Present', half_day: 'Half day', absent: 'Absent', missing_punch: 'Missing punch', on_leave: 'On leave', half_day_leave: 'Half-day leave',
  holiday: 'Holiday', weekly_off: 'Weekly off', in_progress: 'In progress', not_joined: 'Not employed', unmarked: 'Not counted yet',
};

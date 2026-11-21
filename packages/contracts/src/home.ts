import { z } from 'zod';

/**
 * Home dashboards, one per level: Console (platform), Super Workspace (the whole company and its HR Workspaces), HR
 * Workspace (the people one HR person looks after) and Employee Workspace (the person's own day). Every number is
 * computed by the API from live records and limited to what the signed-in person may see; the screens only arrange it.
 *
 * Routes (web and phone use the same ones):
 *   GET /home/employee?month=YYYY-MM     the person's attendance month, leave, learning, announcements, actions, activity
 *   GET /home/workforce?date&...filters  today's workforce for HR and the Super Workspace (scoped to who they may see)
 *   GET /home/workforce/trend?days=7|30  daily attendance, late, absence, leave and missing punches
 *   GET /home/organization               Super Workspace only: every HR Workspace's health, alerts and learning
 *   GET /platform/home                   Console only: customers, workspaces, users, system alerts and activity
 */

/** How loudly a dashboard item asks for attention. Shown with an icon and a label, never by colour alone. */
export const ATTENTION_LEVELS = ['normal', 'info', 'attention', 'warning', 'critical'] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];
export const ATTENTION_LABEL: Record<AttentionLevel, string> = {
  normal: 'Normal', info: 'For your information', attention: 'Action required', warning: 'Warning', critical: 'Critical',
};
export const ATTENTION_RANK: Record<AttentionLevel, number> = { normal: 0, info: 1, attention: 2, warning: 3, critical: 4 };

/** Something that needs the person, with the page that resolves it. */
export interface HomeAction {
  key: string;
  level: AttentionLevel;
  title: string;
  detail: string | null;
  count: number | null;
  href: string;
  cta: string;
}

/** A number on a dashboard card; `href` opens the list behind it with the same filter applied. */
export interface HomeStat {
  key: string;
  label: string;
  value: number | null;
  unit?: 'percent';
  level?: AttentionLevel;
  hint?: string;
  href?: string;
}

export const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const employeeHomeQuery = z.object({ month: monthParam.optional() });

/** Extra views of the team attendance list, beyond the stored day status. */
export const ATTENDANCE_VIEW_FILTERS = ['late', 'early_leave', 'working_now', 'wfh', 'not_in_yet'] as const;
export type AttendanceViewFilter = (typeof ATTENDANCE_VIEW_FILTERS)[number];
export const ATTENDANCE_VIEW_LABEL: Record<AttendanceViewFilter, string> = {
  late: 'Late today', early_leave: 'Left early', working_now: 'Working now', wfh: 'Working from home', not_in_yet: 'Not in yet',
};

export const workforceHomeQuery = z.object({
  date: isoDay.optional(),
  departmentId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  /** Super Workspace (or an HR person over several): one HR Workspace, or 'central' for the central group. */
  hrWorkspaceId: z.union([z.uuid(), z.literal('central')]).optional(),
});
export type WorkforceHomeQuery = z.infer<typeof workforceHomeQuery>;

export const trendQuery = workforceHomeQuery.omit({ date: true }).extend({ days: z.coerce.number().int().refine((n) => n === 7 || n === 14 || n === 30, 'Use 7, 14 or 30').default(14) });

// Employee Workspace ---------------------------------------------------------------------------------------------------

export interface HomeCalendarDay {
  date: string;
  /** The stored day status (present, absent, late is a flag ...); null for days not counted yet or in the future. */
  status: string | null;
  dayType: 'working' | 'weekly_off' | 'holiday';
  holidayName: string | null;
  firstIn: string | null;
  lastOut: string | null;
  workedMinutes: number;
  breakMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  remote: boolean;
  leaveName: string | null;
  /** A correction for the day waits for approval. */
  correctionPending: boolean;
}

export interface EmployeeHome {
  generatedAt: string;
  today: string;
  month: string;
  timeZone: string;
  attendance: {
    days: HomeCalendarDay[];
    summary: { present: number; absent: number; late: number; onLeave: number; halfDay: number; missingPunch: number; wfh: number; holidays: number; workedMinutes: number; workingDays: number };
    expectedMinutes: number;
  } | null;
  leave: {
    pending: { id: string; type: string; startDate: string; endDate: string; days: number }[];
    upcoming: { id: string; type: string; startDate: string; endDate: string; days: number }[];
  } | null;
  learning: {
    assigned: number; inProgress: number; completed: number; overdue: number;
    /** Completed out of everything assigned, 0 to 100. */
    completion: number | null;
    items: { id: string; title: string; status: string; dueOn: string | null; overdue: boolean; /** 0 to 100 where the course tracks it. */ progress: number | null }[];
  } | null;
  announcements: {
    unread: number;
    items: { id: string; title: string; priority: string; category: string | null; publishedAt: string | null; author: string | null; authorLevel: string | null; read: boolean; needsAck: boolean }[];
  } | null;
  actions: HomeAction[];
  activity: { at: string; kind: string; title: string; href: string | null }[];
}

// HR Workspace and Super Workspace: the workforce ----------------------------------------------------------------------

export interface WorkforceHome {
  generatedAt: string;
  date: string;
  /** Whose people these are: the whole company, one HR Workspace, several, or a manager's team. */
  scope: { label: string; employees: number };
  filters: {
    departments: { id: string; name: string }[];
    locations: { id: string; name: string }[];
    hrWorkspaces: { id: string; name: string }[];
    applied: { departmentId: string | null; locationId: string | null; hrWorkspaceId: string | null };
  };
  today: {
    employees: number; expected: number; present: number; workingNow: number; notInYet: number; absent: number; late: number;
    onLeave: number; missingPunch: number; wfh: number; earlyLeave: number; holidayOrOff: number; rate: number | null;
  } | null;
  actions: HomeAction[];
  leave: {
    pending: number; approvedThisMonth: number; rejectedThisMonth: number; onLeaveToday: { employeeId: string; name: string; type: string; until: string }[];
    upcoming: { id: string; employeeId: string; name: string; type: string; startDate: string; endDate: string; days: number }[];
  } | null;
  people: {
    newJoiners: { id: string; name: string; joinedOn: string; department: string | null }[];
    attendanceIssues: { id: string; name: string; late: number; absent: number; missing: number }[];
    absentToday: { id: string; name: string; department: string | null }[];
    incompleteProfiles: number;
    pendingProfileUpdates: number;
  };
  learning: { assigned: number; completed: number; inProgress: number; overdue: number; completion: number | null; /** Mean of scored assessments, where courses score them. */ averageScore: number | null; canManage: boolean } | null;
  communication: { unreadChats: number; awaitingHr: number | null; announcements: { id: string; title: string; publishedAt: string | null; priority: string }[] } | null;
}

export interface WorkforceTrend {
  days: { date: string; expected: number; present: number; absent: number; late: number; onLeave: number; missingPunch: number; rate: number | null }[];
}

// Super Workspace: the organisation ------------------------------------------------------------------------------------

export interface WorkspaceHealth {
  /** 'central' for people not placed in any HR Workspace. */
  id: string;
  name: string;
  status: string;
  employees: number;
  hrUsers: number;
  expected: number;
  present: number;
  presentRate: number | null;
  absentRate: number | null;
  late: number;
  missingPunch: number;
  onLeave: number;
  pendingActions: number;
  learningCompletion: number | null;
  /** Chat messages and announcements in the last 7 days. */
  communication: number;
  health: 'good' | 'watch' | 'attention';
}

export interface OrganizationHome {
  generatedAt: string;
  date: string;
  overview: {
    hrWorkspaces: number; employeeWorkspaces: number; employees: number; hrUsers: number;
    present: number; absent: number; onLeave: number; late: number; missingPunch: number; wfh: number; expected: number; rate: number | null;
    activeLearning: number; pendingActions: number;
  };
  workspaces: WorkspaceHealth[];
  alerts: HomeAction[];
  learning: { active: number; assigned: number; completed: number; overdue: number; completion: number | null; byWorkspace: { id: string; name: string; completion: number | null; overdue: number }[] };
  communication: { unreadChats: number; announcements: { id: string; title: string; publishedAt: string | null; priority: string }[]; recentHrActivity: { at: string; title: string; actor: string | null }[] };
  /** Below this attendance rate an HR Workspace is flagged. */
  targetRate: number;
}

// Console --------------------------------------------------------------------------------------------------------------

export interface PlatformHome {
  generatedAt: string;
  overview: {
    customers: number; superWorkspaces: number; hrWorkspaces: number; employeeWorkspaces: number;
    activeUsers: number; activeToday: number; newWorkspaces: number; suspended: number; demo: number; pendingActions: number;
  };
  health: {
    active: number; inactive: number; trialing: number; pastDue: number;
    recent: { id: string; name: string; createdAt: string; status: string }[];
    attention: { id: string; name: string; reason: string; level: AttentionLevel }[];
    integrations: { key: string; name: string; on: boolean }[];
  };
  alerts: HomeAction[];
  activity: { at: string; action: string; title: string; workspace: string | null; actor: string | null; level: AttentionLevel }[];
  signups: { day: string; count: number }[];
}

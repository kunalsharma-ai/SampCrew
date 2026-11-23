import { Injectable } from '@nestjs/common';
import {
  ATTENTION_RANK, PLATFORM_LEVEL_LABEL, zonedTime,
  type EmployeeHome, type HomeAction, type HomeCalendarDay, type OrganizationHome, type WorkforceHome, type WorkforceHomeQuery, type WorkforceTrend, type WorkspaceHealth,
} from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, hasPermission, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { ChatService } from '../communication/chat.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { accessLevels, displayName, fieldById } from '../employees/employee-view';
import { AnnouncementsService } from '../helpdesk/announcements.service';
import { HelpdeskService } from '../helpdesk/helpdesk.service';
import { TasksService } from '../tasks/tasks.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const { localToday } = zonedTime;
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? String(d) : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const shortDate = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const byLevel = (a: HomeAction, b: HomeAction) => ATTENTION_RANK[b.level] - ATTENTION_RANK[a.level];
/** Working from home shows in the computed day's explanation (the engine counts it as worked time). */
const isRemote = (explanation: unknown) => Array.isArray(explanation) && explanation.some((x) => /from home/i.test(String(x)));
/** A day where nobody is expected at work. */
const OFF = new Set(['holiday', 'weekly_off', 'not_joined']);

/** Beyond the member's own record: a manager, HR or Super Workspace view rather than self-service. */
const wide = (s: Subject, permission: string) => grantsFor(s, permission).some((g) => g.scope !== 'own');
const isSuper = (s: Subject) => s.grants.some((g) => g.roleKey === 'super_workspace');
/** Super Workspace or HR Workspace: the levels that look after a workforce. A manager at the Employee Workspace level does not. */
const hrLevel = (s: Subject) => s.grants.some((g) => g.roleKey === 'super_workspace' || g.roleKey === 'hr_workspace');
/**
 * HR Workspaces named on the subject's grants; null when a grant covers the whole company (or a legal entity) with no
 * HR Workspace limit. A manager's team or department grant covers no HR Workspace, so it adds none.
 */
function hrWorkspacesOf(s: Subject, permission: string): string[] | null {
  // A person's grant over their own record (every employee has one) says nothing about whom they look after.
  const grants = grantsFor(s, permission).filter((g) => g.scope !== 'own');
  if (grants.some((g) => (g.scope === 'tenant' || g.scope === 'entity') && !g.constraints.hrWorkspaceIds?.length)) return null;
  return [...new Set(grants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))];
}
/** How a person without HR Workspace grants is told whom the workforce view covers. */
const narrowLabel = (s: Subject, permission: string) => (grantsFor(s, permission).some((g) => g.scope === 'department') ? 'Your department' : 'Your team');

/** Audit actions an employee sees in Recent activity, with how they read. */
const ACTIVITY: [RegExp, string, string | null][] = [
  [/^leave_request\.created$/, 'Applied for leave', '/leave'],
  [/^leave_request\.(modified|changed)/, 'Changed a leave request', '/leave'],
  [/^leave_request\.cancelled$/, 'Cancelled a leave request', '/leave'],
  [/^attendance_correction\.requested$|^attendance_correction\.created$/, 'Asked for an attendance correction', '/attendance'],
  [/^learning\.enrolled$/, 'Started a course', '/learning'],
  [/^learning\.completed$/, 'Completed a course', '/learning'],
  [/^profile_update\./, 'Sent a profile update to HR', '/profile'],
  [/^task\.(submitted|completed)/, 'Completed a task', '/tasks'],
  [/^expense_claim\.submitted/, 'Submitted an expense claim', '/expenses'],
  [/^announcement\.acknowledged/, 'Acknowledged an announcement', '/announcements'],
  [/^appraisal\.(self_submitted|submitted)/, 'Submitted a self-appraisal', '/appraisal'],
];

/**
 * The data behind each level's Home. Each method checks who is asking and reads only what they may see: the same
 * scope rules as the list each number links to, applied again here on the server, so a changed URL, workspace id or
 * request never widens what comes back.
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
    private readonly attendance: AttendanceService,
    private readonly approvals: ApprovalsService,
    private readonly announcements: AnnouncementsService,
    private readonly chat: ChatService,
    private readonly helpdesk: HelpdeskService,
    private readonly tasks: TasksService,
  ) {}

  // Employee Workspace -----------------------------------------------------------------------------------------------

  async employee(month?: string): Promise<EmployeeHome> {
    const actor = requestContext.tenantActor();
    const base = await this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) throw Errors.notFound('Employee record');
      const { features } = await this.entitlements.current(tx);
      const e = (await tx.collection('employees').findOne({ id: s.employeeId }))!;
      const tz = await this.timeZoneOf(tx, e);
      return { s, features, e, tz };
    });
    const { s, features, e, tz } = base;
    const today = localToday(tz);
    const m = month ?? today.slice(0, 7);
    const from = `${m}-01`;
    const to = monthEnd(m);
    const may = (feature: string, permission: string) => features.has(feature) && hasPermission(s, permission).allowed;

    // Attendance first: it is the top of the page. Missing days are computed by the attendance module itself.
    const attendance = may('attendance_basic', 'attendance:read') ? await this.attendance.employeeDays(undefined, from, to) : null;

    const [rest, feed, taskCounts, inbox] = await Promise.all([
      this.db.tenant(async (tx) => {
        const leaveRows = may('leave', 'leave:read')
          ? await tx.collection('leave_requests').find({ employee_id: e.id, status: { $in: ['pending', 'approved'] }, end_date: { $gte: addDays(today, -1) } }, { sort: { start_date: 1 }, limit: 50 })
          : null;
        const monthLeave = attendance ? await tx.collection('leave_requests').find({ employee_id: e.id, status: 'approved', end_date: { $gte: from }, start_date: { $lte: to } }) : [];
        const typeNames = await fieldById(tx, 'leave_types', [...(leaveRows ?? []), ...monthLeave].map((r) => r.leave_type_id));
        const corrections = attendance ? new Set(await tx.collection('attendance_corrections').distinct<string>('work_date', { employee_id: e.id, status: 'pending', work_date: { $gte: from, $lte: to } })) : new Set<string>();
        const learning = may('learning', 'learning:read')
          ? await tx.collection('course_assignments').find({ employee_id: e.id, status: { $ne: 'cancelled' } }, { sort: { due_on: 1 } })
          : null;
        const courses = learning ? await fieldById(tx, 'courses', learning.map((a) => a.course_id), 'title') : new Map<string, string>();
        const profileAsks = await tx.collection('profile_change_requests').count({ employee_id: e.id, status: 'info_requested' });
        const events = await tx.collection('audit_events').find({ actor_id: actor.userId, created_at: { $gte: new Date(Date.now() - 30 * DAY) } }, { sort: { created_at: -1 }, limit: 80, projection: { action: 1, created_at: 1 } });
        const punches = await tx.collection('attendance_events').find({ employee_id: e.id, captured_at: { $gte: new Date(Date.now() - 7 * DAY) } }, { sort: { captured_at: -1 }, limit: 12, projection: { captured_at: 1, direction: 1, source: 1 } });
        return { leaveRows, monthLeave, typeNames, corrections, learning, courses, profileAsks, events, punches };
      }),
      may('announcements', 'announcements:read') ? this.announcements.feed({}, 5) : Promise.resolve(null),
      features.has('core_hr') ? this.tasks.counts() : Promise.resolve(null),
      this.approvals.inbox(),
    ]);
    const ann = feed ? await this.withAuthors(feed as Doc[]) : null;

    // Leave days in this month, by date, for the calendar.
    const leaveByDate = new Map<string, string>();
    for (const r of rest.monthLeave) for (let d = r.start_date as string; d <= r.end_date; d = addDays(d, 1)) leaveByDate.set(d, rest.typeNames.get(r.leave_type_id) ?? 'Leave');

    let home: EmployeeHome['attendance'] = null;
    const actions: HomeAction[] = [];
    if (attendance) {
      const stored = new Map((attendance.days as Doc[]).map((d) => [d.workDate as string, d]));
      const days: HomeCalendarDay[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const r = stored.get(d);
        const holiday = r && Array.isArray(r.explanation) ? /^Holiday: (.+)\.$/.exec(String(r.explanation[0] ?? ''))?.[1] ?? null : null;
        days.push({
          date: d,
          status: r && d <= today ? (r.status as string) : null,
          dayType: (r?.dayType as HomeCalendarDay['dayType']) ?? 'working',
          holidayName: holiday,
          firstIn: iso(r?.firstIn), lastOut: iso(r?.lastOut),
          workedMinutes: r?.workedMinutes ?? 0, breakMinutes: r?.breakMinutes ?? 0, lateMinutes: r?.lateMinutes ?? 0, earlyLeaveMinutes: r?.earlyLeaveMinutes ?? 0,
          remote: isRemote(r?.explanation),
          leaveName: leaveByDate.get(d) ?? null,
          correctionPending: rest.corrections.has(d),
        });
      }
      const past = days.filter((d) => d.status);
      const count = (st: string) => past.filter((d) => d.status === st).length;
      const shifts = (attendance.days as Doc[]).filter((d) => d.shiftStart && d.shiftEnd);
      const lastShift = shifts.at(-1);
      const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const expected = lastShift ? ((toMin(lastShift.shiftEnd) - toMin(lastShift.shiftStart) + 1440) % 1440 || 1440) : 480;
      home = {
        days,
        summary: {
          present: count('present'), absent: count('absent'), late: past.filter((d) => d.lateMinutes > 0).length, onLeave: count('on_leave'),
          halfDay: count('half_day') + count('half_day_leave'), missingPunch: count('missing_punch'), wfh: past.filter((d) => d.remote).length,
          holidays: days.filter((d) => d.dayType === 'holiday').length,
          workedMinutes: past.reduce((t, d) => t + d.workedMinutes, 0),
          workingDays: days.filter((d) => d.dayType === 'working').length,
        },
        expectedMinutes: expected,
      };
      // Missed punches that nobody has asked to correct yet, newest first.
      const missing = past.filter((d) => d.status === 'missing_punch' && !d.correctionPending && d.date < today).reverse();
      if (missing.length) {
        actions.push({
          key: 'missing-punch', level: 'warning', count: missing.length,
          title: missing.length === 1 ? `Missing punch on ${shortDate(missing[0]!.date)}` : `${missing.length} days with a missing punch`,
          detail: 'Ask for a correction so the day counts.', href: `/attendance/day/${e.id}/${missing[0]!.date}`, cta: 'Fix attendance',
        });
      }
    }

    let leave: EmployeeHome['leave'] = null;
    if (rest.leaveRows) {
      const view = (r: Doc) => ({ id: r.id as string, type: rest.typeNames.get(r.leave_type_id) ?? 'Leave', startDate: r.start_date as string, endDate: r.end_date as string, days: Number(r.days) || 0 });
      leave = {
        pending: rest.leaveRows.filter((r) => r.status === 'pending').map(view),
        upcoming: rest.leaveRows.filter((r) => r.status === 'approved' && r.end_date >= today).slice(0, 5).map(view),
      };
      if (leave.pending.length) actions.push({ key: 'leave-pending', level: 'info', count: leave.pending.length, title: `${plural(leave.pending.length, 'leave request')} waiting for approval`, detail: `${leave.pending[0]!.type}, ${shortDate(leave.pending[0]!.startDate)}`, href: '/leave', cta: 'View leave' });
      const soon = leave.upcoming.find((u) => u.startDate <= addDays(today, 7));
      if (soon) actions.push({ key: 'leave-soon', level: 'info', count: null, title: `${soon.type} approved from ${shortDate(soon.startDate)}`, detail: `${soon.days} day${soon.days === 1 ? '' : 's'}`, href: '/leave', cta: 'View leave' });
    }

    let learning: EmployeeHome['learning'] = null;
    if (rest.learning) {
      const open = rest.learning.filter((a) => ['assigned', 'in_progress'].includes(a.status));
      const overdue = open.filter((a) => a.due_on && a.due_on < today);
      const completed = rest.learning.filter((a) => a.status === 'completed').length;
      learning = {
        assigned: rest.learning.filter((a) => a.status === 'assigned').length,
        inProgress: rest.learning.filter((a) => a.status === 'in_progress').length,
        completed, overdue: overdue.length,
        completion: pct(completed, rest.learning.length),
        items: open.slice(0, 4).map((a) => ({ id: a.id, title: rest.courses.get(a.course_id) ?? 'Course', status: a.status, dueOn: a.due_on ?? null, overdue: Boolean(a.due_on && a.due_on < today), progress: typeof a.progress_percent === 'number' ? a.progress_percent : null })),
      };
      if (overdue.length) actions.push({ key: 'learning-overdue', level: 'warning', count: overdue.length, title: `${plural(overdue.length, 'course')} overdue`, detail: rest.courses.get(overdue[0]!.course_id) ?? null, href: '/learning', cta: 'Continue learning' });
      const fresh = open.filter((a) => a.status === 'assigned' && !(a.due_on && a.due_on < today));
      if (fresh.length) actions.push({ key: 'learning-new', level: 'attention', count: fresh.length, title: fresh.length === 1 ? `New learning: ${rest.courses.get(fresh[0]!.course_id) ?? 'course'}` : `${fresh.length} new courses assigned`, detail: fresh[0]!.due_on ? `Due ${shortDate(fresh[0]!.due_on)}` : null, href: '/learning', cta: 'Start learning' });
    }

    if (ann) {
      const toAck = ann.items.filter((a) => a.needsAck);
      if (toAck.length) actions.push({ key: 'announcement-ack', level: 'attention', count: toAck.length, title: toAck.length === 1 ? `Read and acknowledge: ${toAck[0]!.title}` : `${toAck.length} announcements to acknowledge`, detail: toAck[0]!.author ? `From ${toAck[0]!.author}` : null, href: '/announcements', cta: 'Read now' });
    }
    if (taskCounts) {
      const tc = taskCounts as { hr: { open: number; overdue: number }; manager: { open: number; overdue: number } };
      const open = tc.hr.open + tc.manager.open;
      const overdue = tc.hr.overdue + tc.manager.overdue;
      if (open) actions.push({ key: 'tasks', level: overdue ? 'warning' : 'attention', count: open, title: `${plural(open, 'task')} to do${overdue ? `, ${overdue} overdue` : ''}`, detail: `${tc.hr.open} from HR, ${tc.manager.open} from your manager`, href: '/tasks', cta: 'Open tasks' });
    }
    if (rest.profileAsks) actions.push({ key: 'profile-info', level: 'attention', count: rest.profileAsks, title: 'HR asked for more details on your profile update', detail: null, href: '/profile', cta: 'Complete profile' });
    if (inbox.length) actions.push({ key: 'approvals', level: 'attention', count: inbox.length, title: `${plural(inbox.length, 'request')} waiting for your approval`, detail: null, href: '/approvals', cta: 'Review' });

    // Recent activity: what the person did (from the audit trail) and their punches, newest first.
    const activity: EmployeeHome['activity'] = [];
    for (const ev of rest.events) {
      const hit = ACTIVITY.find(([re]) => re.test(ev.action));
      if (hit) activity.push({ at: iso(ev.created_at)!, kind: ev.action, title: hit[1], href: hit[2] });
    }
    for (const p of rest.punches) activity.push({ at: iso(p.captured_at)!, kind: `punch.${p.direction}`, title: p.direction === 'out' ? 'Checked out' : p.direction === 'in' ? 'Checked in' : 'Punched', href: '/attendance' });
    activity.sort((a, b) => b.at.localeCompare(a.at));

    return {
      generatedAt: new Date().toISOString(), today, month: m, timeZone: tz,
      attendance: home, leave, learning, announcements: ann, actions: actions.sort(byLevel), activity: activity.slice(0, 10),
    };
  }

  /** Announcement feed rows with who sent them and at which level (Super Workspace, HR Workspace ...). */
  private async withAuthors(feed: Doc[]) {
    return this.db.tenant(async (tx) => {
      const docs = await tx.collection('announcements').find({ id: { $in: feed.map((a) => a.id) } }, { projection: { published_by_membership_id: 1 } });
      const by = new Map(docs.map((d) => [d.id as string, d.published_by_membership_id as string | null]));
      const levels = await accessLevels(tx, [...by.values()].filter(Boolean));
      return {
        unread: feed.filter((a) => !a.readAt).length,
        items: feed.map((a) => {
          const who = by.get(a.id) ?? null;
          const level = who ? levels.get(who) : undefined;
          return {
            id: a.id as string, title: a.title as string, priority: (a.priority as string) ?? 'normal', category: (a.category as string | null) ?? null, publishedAt: iso(a.publishedAt),
            author: (a.publishedByName as string | null) ?? null, authorLevel: level ? PLATFORM_LEVEL_LABEL[level] : null, read: Boolean(a.readAt), needsAck: Boolean(a.needsAck),
          };
        }),
      };
    });
  }

  private async timeZoneOf(tx: Tx, e: Doc): Promise<string> {
    const loc = e.current_location_id ? await tx.collection('locations').findOne({ id: e.current_location_id }, { projection: { timezone: 1 } }) : null;
    if (loc?.timezone) return loc.timezone as string;
    const ent = e.current_legal_entity_id ? await tx.collection('legal_entities').findOne({ id: e.current_legal_entity_id }, { projection: { timezone: 1 } }) : null;
    if (ent?.timezone) return ent.timezone as string;
    return (await tx.collection('tenants').findOne({}))!.timezone as string;
  }

  // HR Workspace and Super Workspace ---------------------------------------------------------------------------------

  /**
   * The people this person looks after, narrowed by the filters: the employees:read scope (an HR Workspace admin's
   * grants name their HR Workspaces, a manager's cover their team), then department, location and HR Workspace.
   */
  private async workforce(tx: Tx, s: Subject, q: WorkforceHomeQuery, date: string) {
    if (!hrLevel(s) || (!wide(s, 'employees:read') && !wide(s, 'attendance:read'))) throw Errors.forbidden('The workforce view is for the Super Workspace and HR Workspaces');
    const allowed = hrWorkspacesOf(s, 'employees:read');
    const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' }, ...(allowed === null ? {} : { id: { $in: allowed } }) }, { projection: { name: 1 }, sort: { name: 1 } });
    if (q.hrWorkspaceId && q.hrWorkspaceId !== 'central' && !spaces.some((w) => w.id === q.hrWorkspaceId)) throw Errors.notFound('HR Workspace');
    if (q.hrWorkspaceId === 'central' && allowed !== null) throw Errors.notFound('HR Workspace');
    const scope = await this.authz.filter(wide(s, 'employees:read') ? 'employees:read' : 'attendance:read', EMPLOYEE_FIELDS, tx);
    const and: Doc[] = [scope, { status: { $nin: ['exited', 'pre_boarding'] } }, { date_of_joining: { $lte: date } }, { $or: [{ last_working_day: null }, { last_working_day: { $gte: date } }] }];
    if (s.employeeId) and.push({ id: { $ne: s.employeeId } });
    if (q.departmentId) and.push({ current_department_id: q.departmentId });
    if (q.locationId) and.push({ current_location_id: q.locationId });
    if (q.hrWorkspaceId) and.push({ hr_workspace_id: q.hrWorkspaceId === 'central' ? null : q.hrWorkspaceId });
    const people = await tx.collection('employees').find({ $and: and }, {
      projection: { first_name: 1, last_name: 1, preferred_name: 1, date_of_joining: 1, current_department_id: 1, current_location_id: 1, hr_workspace_id: 1, membership_id: 1, phone: 1, date_of_birth: 1, personal_email: 1 },
      limit: 5000,
    });
    const everyone = await tx.collection('employees').find({ $and: [scope, { status: { $nin: ['exited', 'pre_boarding'] } }] }, { projection: { current_department_id: 1, current_location_id: 1 }, limit: 5000 });
    const [departments, locations] = await Promise.all([
      fieldById(tx, 'departments', everyone.map((x) => x.current_department_id)),
      fieldById(tx, 'locations', everyone.map((x) => x.current_location_id)),
    ]);
    const label = isSuper(s) && allowed === null
      ? (q.hrWorkspaceId ? (q.hrWorkspaceId === 'central' ? 'Central group' : spaces.find((w) => w.id === q.hrWorkspaceId)!.name) : 'Whole company')
      : allowed?.length ? (spaces.length === 1 ? spaces[0]!.name : `${spaces.length} HR Workspaces`) : allowed === null ? 'Whole company' : narrowLabel(s, wide(s, 'employees:read') ? 'employees:read' : 'attendance:read');
    return {
      people, label, spaces,
      options: {
        departments: [...departments].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        locations: [...locations].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
        hrWorkspaces: [...(isSuper(s) && allowed === null ? [{ id: 'central', name: 'Central group' }] : []), ...spaces.map((w) => ({ id: w.id as string, name: w.name as string }))],
      },
    };
  }

  /** Today's attendance for a set of people, from the attendance module's team view (which refreshes stale days). */
  private async todayFor(date: string, ids: Set<string>, tx: Tx) {
    const team = await this.attendance.team({ date });
    const rows = (team.rows as Doc[]).filter((r) => ids.has(r.employeeId));
    const wfhTypes = await tx.collection('leave_types').distinct<string>('id', { kind: 'wfh' });
    const remote = new Set(wfhTypes.length ? await tx.collection('leave_requests').distinct<string>('employee_id', { employee_id: { $in: [...ids] }, status: 'approved', leave_type_id: { $in: wfhTypes }, start_date: { $lte: date }, end_date: { $gte: date } }) : []);
    const by = (st: string) => rows.filter((r) => r.status === st);
    const off = rows.filter((r) => OFF.has(r.status)).length;
    const onLeave = by('on_leave').length;
    const workingNow = rows.filter((r) => r.status === 'in_progress' && r.firstIn && !r.lastOut).length;
    const notInYet = rows.filter((r) => r.status === 'in_progress' && !r.firstIn).length;
    const present = by('present').length + by('half_day').length + by('half_day_leave').length + rows.filter((r) => r.status === 'in_progress' && r.firstIn).length;
    const expected = rows.length - off - onLeave;
    return {
      rows,
      today: {
        employees: ids.size, expected, present, workingNow, notInYet, absent: by('absent').length, late: rows.filter((r) => r.lateMinutes > 0).length,
        onLeave, missingPunch: by('missing_punch').length, wfh: rows.filter((r) => remote.has(r.employeeId) || isRemote(r.explanation)).length,
        earlyLeave: rows.filter((r) => r.earlyLeaveMinutes > 0).length, holidayOrOff: off, rate: pct(present, expected),
      },
    };
  }

  async workforceHome(q: WorkforceHomeQuery): Promise<WorkforceHome> {
    const setup = await this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { features } = await this.entitlements.current(tx);
      const tz = (await tx.collection('tenants').findOne({}))!.timezone as string;
      const date = q.date ?? localToday(tz);
      const w = await this.workforce(tx, s, q, date);
      return { s, features, date, ...w };
    });
    const { s, features, date, people } = setup;
    const ids = new Set(people.map((p) => p.id as string));
    const may = (feature: string, permission: string) => features.has(feature) && wide(s, permission);
    const month = date.slice(0, 7);

    const att = may('attendance_basic', 'attendance:read') ? await this.db.tenant((tx) => this.todayFor(date, ids, tx)) : null;
    const [data, inbox, chats, desk, news] = await Promise.all([
      this.db.tenant(async (tx) => {
        const list = [...ids];
        const leave = may('leave', 'leave:read') ? await tx.collection('leave_requests').find({ employee_id: { $in: list }, $or: [{ status: 'pending' }, { end_date: { $gte: `${month}-01` }, start_date: { $lte: addDays(date, 14) } }, { status: { $in: ['approved', 'rejected'] }, updated_at: { $gte: new Date(`${month}-01T00:00:00Z`) } }] }, { limit: 3000 }) : null;
        const types = leave ? await tx.collection('leave_types').find({ id: { $in: [...new Set(leave.map((r) => r.leave_type_id))] } }, { projection: { name: 1, kind: 1 } }) : [];
        const monthDays = att ? await tx.collection('attendance_days').find({ employee_id: { $in: list }, work_date: { $gte: `${month}-01`, $lte: date } }, { projection: { employee_id: 1, status: 1, late_minutes: 1, work_date: 1 } }) : [];
        const learning = features.has('learning') && wide(s, 'learning:read') ? await tx.collection('course_assignments').find({ employee_id: { $in: list }, status: { $ne: 'cancelled' } }, { projection: { status: 1, due_on: 1, score_percent: 1 } }) : null;
        const corrections = att && hasPermission(s, 'attendance:approve').allowed ? await tx.collection('attendance_corrections').count({ employee_id: { $in: list }, status: 'pending' }) : 0;
        const profileUpdates = hasPermission(s, 'profiles:review').allowed ? await tx.collection('profile_change_requests').count({ employee_id: { $in: list }, status: 'pending' }) : 0;
        const missingYesterday = att ? await tx.collection('attendance_days').count({ employee_id: { $in: list }, work_date: addDays(date, -1), status: 'missing_punch' }) : 0;
        const depts = await fieldById(tx, 'departments', people.map((p) => p.current_department_id));
        return { leave, types, monthDays, learning, corrections, profileUpdates, missingYesterday, depts };
      }),
      this.approvals.inbox(),
      features.has('helpdesk') && hasPermission(s, 'helpdesk:use').allowed ? this.chat.unread() : Promise.resolve(null),
      features.has('helpdesk') && hasPermission(s, 'helpdesk:manage').allowed ? this.helpdesk.summary() : Promise.resolve(null),
      features.has('announcements') && hasPermission(s, 'announcements:read').allowed ? this.announcements.feed({}, 3) : Promise.resolve(null),
    ]);
    const name = new Map(people.map((p) => [p.id as string, displayName(p as never)]));
    const today = att?.today ?? null;

    const actions: HomeAction[] = [];
    const team = (patch: Record<string, string>) => `/attendance/team?${new URLSearchParams({ date, ...(q.departmentId ? { departmentId: q.departmentId } : {}), ...(q.locationId ? { locationId: q.locationId } : {}), ...patch })}`;
    if (today) {
      if (today.missingPunch) actions.push({ key: 'missing-today', level: 'warning', count: today.missingPunch, title: `${plural(today.missingPunch, 'missing punch', 'missing punches')} today`, detail: 'Checked in without checking out, or the other way round.', href: team({ status: 'missing_punch' }), cta: 'Review' });
      if (data.missingYesterday) actions.push({ key: 'missing-yesterday', level: 'warning', count: data.missingYesterday, title: `${plural(data.missingYesterday, 'missing punch', 'missing punches')} yesterday`, detail: null, href: team({ date: addDays(date, -1), status: 'missing_punch' }), cta: 'Review' });
      if (today.late) actions.push({ key: 'late', level: 'attention', count: today.late, title: `${plural(today.late, 'employee')} late today`, detail: null, href: team({ filter: 'late' }), cta: 'See who' });
      if (today.absent) actions.push({ key: 'absent', level: 'attention', count: today.absent, title: `${plural(today.absent, 'employee')} absent today`, detail: null, href: team({ status: 'absent' }), cta: 'See who' });
    }
    if (data.corrections) actions.push({ key: 'corrections', level: 'attention', count: data.corrections, title: `${plural(data.corrections, 'attendance correction')} to review`, detail: null, href: '/approvals?category=attendance', cta: 'Review' });
    const inboxBy = new Map<string, number>();
    for (const i of inbox as { category?: string }[]) inboxBy.set(i.category ?? 'other', (inboxBy.get(i.category ?? 'other') ?? 0) + 1);
    const leaveApprovals = inboxBy.get('leave') ?? 0;
    if (leaveApprovals) actions.push({ key: 'leave-approvals', level: 'attention', count: leaveApprovals, title: `${plural(leaveApprovals, 'leave request')} waiting for you`, detail: null, href: '/approvals?category=leave', cta: 'Review' });
    const otherApprovals = inbox.length - leaveApprovals - (inboxBy.get('attendance') ?? 0);
    if (otherApprovals > 0) actions.push({ key: 'approvals', level: 'attention', count: otherApprovals, title: `${plural(otherApprovals, 'other approval')} waiting for you`, detail: null, href: '/approvals', cta: 'Review' });
    if (data.profileUpdates) actions.push({ key: 'profile-updates', level: 'attention', count: data.profileUpdates, title: `${plural(data.profileUpdates, 'profile update')} to check`, detail: null, href: '/profile/updates', cta: 'Review' });
    const awaitingHr = (desk as { queue?: { awaitingHr: number } | null } | null)?.queue?.awaitingHr ?? null;
    if (awaitingHr) actions.push({ key: 'helpdesk', level: 'attention', count: awaitingHr, title: `${plural(awaitingHr, 'employee question')} waiting for HR`, detail: null, href: '/communication', cta: 'Answer' });

    let leave: WorkforceHome['leave'] = null;
    if (data.leave) {
      const tn = new Map(data.types.map((t) => [t.id as string, t]));
      const real = data.leave.filter((r) => tn.get(r.leave_type_id)?.kind !== 'wfh');
      const inMonth = (r: Doc) => iso(r.updated_at)!.slice(0, 7) === month;
      const pending = real.filter((r) => r.status === 'pending');
      leave = {
        pending: pending.length,
        approvedThisMonth: real.filter((r) => r.status === 'approved' && inMonth(r)).length,
        rejectedThisMonth: real.filter((r) => r.status === 'rejected' && inMonth(r)).length,
        onLeaveToday: real.filter((r) => r.status === 'approved' && r.start_date <= date && r.end_date >= date).slice(0, 8)
          .map((r) => ({ employeeId: r.employee_id, name: name.get(r.employee_id) ?? '', type: tn.get(r.leave_type_id)?.name ?? 'Leave', until: r.end_date })),
        upcoming: real.filter((r) => r.status === 'approved' && r.start_date > date && r.start_date <= addDays(date, 14)).sort((a, b) => a.start_date.localeCompare(b.start_date)).slice(0, 6)
          .map((r) => ({ id: r.id, employeeId: r.employee_id, name: name.get(r.employee_id) ?? '', type: tn.get(r.leave_type_id)?.name ?? 'Leave', startDate: r.start_date, endDate: r.end_date, days: Number(r.days) || 0 })),
      };
      if (pending.length > leaveApprovals) actions.push({ key: 'leave-pending', level: 'info', count: pending.length, title: `${plural(pending.length, 'leave request')} pending in your area`, detail: 'Waiting on other approvers too.', href: '/leave/balances', cta: 'Open leave' });
    }

    // People: joiners, attendance patterns this month, absences today, profile gaps.
    const issues = new Map<string, { late: number; absent: number; missing: number }>();
    for (const d of data.monthDays) {
      const x = issues.get(d.employee_id) ?? { late: 0, absent: 0, missing: 0 };
      if (d.late_minutes > 0) x.late++;
      if (d.status === 'absent' && d.work_date < date) x.absent++;
      if (d.status === 'missing_punch') x.missing++;
      issues.set(d.employee_id, x);
    }
    const attendanceIssues = [...issues].filter(([, x]) => x.late >= 3 || x.absent >= 2 || x.missing >= 2)
      .sort(([, a], [, b]) => b.absent * 3 + b.missing * 2 + b.late - (a.absent * 3 + a.missing * 2 + a.late)).slice(0, 6)
      .map(([id, x]) => ({ id, name: name.get(id) ?? '', ...x }));
    const learning = data.learning
      ? (() => {
          const l = data.learning;
          const completed = l.filter((a) => a.status === 'completed').length;
          const overdue = l.filter((a) => ['assigned', 'in_progress'].includes(a.status) && a.due_on && a.due_on < date).length;
          const scored = l.filter((a) => typeof a.score_percent === 'number');
          const averageScore = scored.length ? Math.round((scored.reduce((t, a) => t + a.score_percent, 0) / scored.length) * 10) / 10 : null;
          return { assigned: l.length, completed, inProgress: l.filter((a) => a.status === 'in_progress').length, overdue, completion: pct(completed, l.length), averageScore, canManage: wide(s, 'learning:manage') };
        })()
      : null;
    if (learning?.overdue) actions.push({ key: 'learning-overdue', level: 'warning', count: learning.overdue, title: `${plural(learning.overdue, 'course')} overdue`, detail: null, href: '/learning?view=team&status=overdue', cta: 'View progress' });

    return {
      generatedAt: new Date().toISOString(), date,
      scope: { label: setup.label, employees: ids.size },
      filters: { ...setup.options, applied: { departmentId: q.departmentId ?? null, locationId: q.locationId ?? null, hrWorkspaceId: q.hrWorkspaceId ?? null } },
      today,
      actions: actions.sort(byLevel),
      leave,
      people: {
        newJoiners: people.filter((p) => p.date_of_joining >= addDays(date, -30)).sort((a, b) => b.date_of_joining.localeCompare(a.date_of_joining)).slice(0, 5)
          .map((p) => ({ id: p.id, name: name.get(p.id)!, joinedOn: p.date_of_joining, department: data.depts.get(p.current_department_id) ?? null })),
        attendanceIssues,
        absentToday: (att?.rows ?? []).filter((r) => r.status === 'absent').slice(0, 8).map((r) => ({ id: r.employeeId as string, name: name.get(r.employeeId) ?? '', department: (r.department as string | null) ?? null })),
        incompleteProfiles: people.filter((p) => !p.phone || !p.date_of_birth).length,
        pendingProfileUpdates: data.profileUpdates,
      },
      learning,
      communication: chats || desk || news ? {
        unreadChats: chats?.unread ?? 0,
        awaitingHr,
        announcements: ((news ?? []) as Doc[]).map((a) => ({ id: a.id, title: a.title, publishedAt: iso(a.publishedAt), priority: a.priority ?? 'normal' })),
      } : null,
    };
  }

  /** Daily attendance over the last days for the same people as the workforce view (stored days only, no recompute). */
  async trend(q: WorkforceHomeQuery & { days: number }): Promise<WorkforceTrend> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { features } = await this.entitlements.current(tx);
      if (!features.has('attendance_basic') || !wide(s, 'attendance:read')) throw Errors.forbidden('Attendance trends need access to attendance beyond your own');
      const tz = (await tx.collection('tenants').findOne({}))!.timezone as string;
      const today = localToday(tz);
      const w = await this.workforce(tx, s, q, today);
      const from = addDays(today, -(q.days - 1));
      const rows = await tx.collection('attendance_days').find({ employee_id: { $in: w.people.map((p) => p.id) }, work_date: { $gte: from, $lte: today } }, { projection: { work_date: 1, status: 1, late_minutes: 1 } });
      const days: WorkforceTrend['days'] = [];
      for (let d = from; d <= today; d = addDays(d, 1)) {
        const r = rows.filter((x) => x.work_date === d);
        const c = (st: string) => r.filter((x) => x.status === st).length;
        const present = c('present') + c('half_day') + c('half_day_leave') + c('in_progress');
        const expected = r.length - r.filter((x) => OFF.has(x.status)).length - c('on_leave');
        days.push({ date: d, expected, present, absent: c('absent'), late: r.filter((x) => x.late_minutes > 0).length, onLeave: c('on_leave'), missingPunch: c('missing_punch'), rate: pct(present, expected) });
      }
      return { days };
    });
  }

  // Super Workspace --------------------------------------------------------------------------------------------------

  async organization(): Promise<OrganizationHome> {
    const TARGET = 85;
    const setup = await this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!isSuper(s) || hrWorkspacesOf(s, 'hierarchy:read') !== null) throw Errors.forbidden('Only the Super Workspace sees the whole organisation');
      const { features } = await this.entitlements.current(tx);
      const tz = (await tx.collection('tenants').findOne({}))!.timezone as string;
      const date = localToday(tz);
      const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } }, { sort: { name: 1 }, projection: { name: 1, status: 1 } });
      const people = await tx.collection('employees').find(
        { status: { $nin: ['exited', 'pre_boarding'] }, date_of_joining: { $lte: date }, $or: [{ last_working_day: null }, { last_working_day: { $gte: date } }] },
        { projection: { hr_workspace_id: 1, membership_id: 1 }, limit: 20000 },
      );
      const role = await tx.collection('roles').findOne({ key: 'hr_workspace' }, { projection: { id: 1 } });
      const grants = role ? await tx.collection('role_assignments').find({ role_id: role.id }, { projection: { membership_id: 1, constraints: 1 } }) : [];
      const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: grants.map((g) => g.membership_id) }, status: 'active' }));
      return { s, features, date, spaces, people, grants: grants.filter((g) => active.has(g.membership_id)) };
    });
    const { features, date, spaces, people, grants, s } = setup;
    const groupOf = new Map(people.map((p) => [p.id as string, (p.hr_workspace_id as string | null) ?? 'central']));
    const ids = new Set(groupOf.keys());
    const att = features.has('attendance_basic') ? await this.db.tenant((tx) => this.todayFor(date, ids, tx)) : null;

    const extra = await this.db.tenant(async (tx) => {
      const list = [...ids];
      const leave = features.has('leave') ? await tx.collection('leave_requests').find({ employee_id: { $in: list }, status: 'pending' }, { projection: { employee_id: 1 } }) : [];
      const corrections = await tx.collection('attendance_corrections').find({ employee_id: { $in: list }, status: 'pending' }, { projection: { employee_id: 1 } });
      const profiles = await tx.collection('profile_change_requests').find({ employee_id: { $in: list }, status: 'pending' }, { projection: { employee_id: 1 } });
      const learning = features.has('learning') ? await tx.collection('course_assignments').find({ employee_id: { $in: list }, status: { $ne: 'cancelled' } }, { projection: { employee_id: 1, status: 1, due_on: 1, course_id: 1 } }) : null;
      const memberOf = new Map(people.filter((p) => p.membership_id).map((p) => [p.membership_id as string, groupOf.get(p.id)!]));
      const since = new Date(Date.now() - 7 * DAY);
      const messages = features.has('helpdesk') ? await tx.collection('chat_messages').find({ created_at: { $gte: since }, sender_membership_id: { $in: [...memberOf.keys()] } }, { projection: { sender_membership_id: 1 }, limit: 20000 }) : [];
      const events = await tx.collection('audit_events').find({ resource_type: { $in: ['hr_workspace', 'employee', 'leave_type', 'leave_policy', 'announcement', 'attendance_policy', 'course', 'role_assignment'] } }, { sort: { created_at: -1 }, limit: 8, projection: { action: 1, actor_label: 1, created_at: 1, resource_type: 1 } });
      return { leave, corrections, profiles, learning, messages, memberOf, events };
    });
    const [chats, news] = await Promise.all([
      features.has('helpdesk') && hasPermission(s, 'helpdesk:use').allowed ? this.chat.unread() : Promise.resolve(null),
      features.has('announcements') && hasPermission(s, 'announcements:read').allowed ? this.announcements.feed({}, 3) : Promise.resolve(null),
    ]);

    const groups = [{ id: 'central', name: 'Central group', status: 'active' }, ...spaces.map((w) => ({ id: w.id as string, name: w.name as string, status: w.status as string }))];
    const count = <T extends Doc>(rows: T[], key = 'employee_id') => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const g = key === 'employee_id' ? groupOf.get(r.employee_id) : extra.memberOf.get(r[key]);
        if (g) m.set(g, (m.get(g) ?? 0) + 1);
      }
      return m;
    };
    const pending = [count(extra.leave), count(extra.corrections), count(extra.profiles)];
    const chatBy = count(extra.messages, 'sender_membership_id');
    const workspaces: WorkspaceHealth[] = groups.map((g) => {
      const mine = (att?.rows ?? []).filter((r) => groupOf.get(r.employeeId) === g.id);
      const off = mine.filter((r) => OFF.has(r.status)).length;
      const onLeave = mine.filter((r) => r.status === 'on_leave').length;
      const present = mine.filter((r) => ['present', 'half_day', 'half_day_leave'].includes(r.status) || (r.status === 'in_progress' && r.firstIn)).length;
      const absent = mine.filter((r) => r.status === 'absent').length;
      const missing = mine.filter((r) => r.status === 'missing_punch').length;
      const expected = mine.length - off - onLeave;
      const assignments = (extra.learning ?? []).filter((a) => groupOf.get(a.employee_id) === g.id);
      const presentRate = att ? pct(present, expected) : null;
      const pendingActions = pending.reduce((t, m) => t + (m.get(g.id) ?? 0), 0) + missing;
      const health: WorkspaceHealth['health'] = presentRate !== null && presentRate < TARGET - 10 ? 'attention' : (presentRate !== null && presentRate < TARGET) || pendingActions > 10 || missing > 5 ? 'watch' : 'good';
      return {
        id: g.id, name: g.name, status: g.status,
        employees: people.filter((p) => groupOf.get(p.id) === g.id).length,
        hrUsers: grants.filter((x) => (g.id === 'central' ? !x.constraints?.hrWorkspaceIds?.length : (x.constraints?.hrWorkspaceIds ?? []).includes(g.id))).length,
        expected, present, presentRate, absentRate: att ? pct(absent, expected) : null,
        late: mine.filter((r) => r.lateMinutes > 0).length, missingPunch: missing, onLeave,
        pendingActions,
        learningCompletion: extra.learning ? pct(assignments.filter((a) => a.status === 'completed').length, assignments.length) : null,
        communication: chatBy.get(g.id) ?? 0,
        health,
      };
    }).filter((w) => w.id !== 'central' || w.employees > 0);

    const alerts: HomeAction[] = [];
    for (const w of workspaces) {
      const href = w.id === 'central' ? '/?hrWorkspace=central' : `/?hrWorkspace=${w.id}`;
      if (w.presentRate !== null && w.expected >= 3 && w.presentRate < TARGET) alerts.push({ key: `rate:${w.id}`, level: w.presentRate < TARGET - 10 ? 'warning' : 'attention', count: null, title: `${w.name}: attendance ${w.presentRate}% today`, detail: `Below the ${TARGET}% target, ${w.present} of ${w.expected} in.`, href, cta: 'Open' });
      if (w.missingPunch >= 3) alerts.push({ key: `missing:${w.id}`, level: 'warning', count: w.missingPunch, title: `${w.name}: ${w.missingPunch} missing punches`, detail: null, href, cta: 'Open' });
      if (w.pendingActions >= 8) alerts.push({ key: `pending:${w.id}`, level: 'attention', count: w.pendingActions, title: `${w.name}: ${w.pendingActions} pending HR actions`, detail: 'Leave, corrections and profile updates waiting.', href, cta: 'Open' });
      if (w.learningCompletion !== null && w.learningCompletion < 50) alerts.push({ key: `learning:${w.id}`, level: 'info', count: null, title: `${w.name}: learning completion ${w.learningCompletion}%`, detail: null, href: '/learning?view=team', cta: 'View learning' });
      if (w.id !== 'central' && w.hrUsers === 0 && w.employees > 0) alerts.push({ key: `nohr:${w.id}`, level: 'warning', count: null, title: `${w.name} has no HR user`, detail: 'Nobody runs this HR Workspace.', href: `/hr-workspaces/${w.id}`, cta: 'Assign HR' });
      if (w.status === 'suspended') alerts.push({ key: `suspended:${w.id}`, level: 'info', count: null, title: `${w.name} is suspended`, detail: null, href: `/hr-workspaces/${w.id}`, cta: 'Open' });
    }
    const t = att?.today;
    const l = extra.learning ?? [];
    const completed = l.filter((a) => a.status === 'completed').length;
    return {
      generatedAt: new Date().toISOString(), date,
      overview: {
        hrWorkspaces: spaces.length, employeeWorkspaces: people.filter((p) => p.membership_id).length, employees: people.length, hrUsers: new Set(grants.map((g) => g.membership_id)).size,
        present: t?.present ?? 0, absent: t?.absent ?? 0, onLeave: t?.onLeave ?? 0, late: t?.late ?? 0, missingPunch: t?.missingPunch ?? 0, wfh: t?.wfh ?? 0, expected: t?.expected ?? 0, rate: t?.rate ?? null,
        activeLearning: l.filter((a) => ['assigned', 'in_progress'].includes(a.status)).length,
        pendingActions: workspaces.reduce((x, w) => x + w.pendingActions, 0),
      },
      workspaces,
      alerts: alerts.sort(byLevel),
      learning: {
        active: new Set(l.filter((a) => ['assigned', 'in_progress'].includes(a.status)).map((a) => a.course_id)).size,
        assigned: l.length, completed, overdue: l.filter((a) => ['assigned', 'in_progress'].includes(a.status) && a.due_on && a.due_on < date).length,
        completion: pct(completed, l.length),
        byWorkspace: workspaces.map((w) => ({ id: w.id, name: w.name, completion: w.learningCompletion, overdue: l.filter((a) => groupOf.get(a.employee_id) === w.id && ['assigned', 'in_progress'].includes(a.status) && a.due_on && a.due_on < date).length })),
      },
      communication: {
        unreadChats: chats?.unread ?? 0,
        announcements: ((news ?? []) as Doc[]).map((a) => ({ id: a.id, title: a.title, publishedAt: iso(a.publishedAt), priority: a.priority ?? 'normal' })),
        recentHrActivity: extra.events.map((e) => ({ at: iso(e.created_at)!, title: humanAction(e.action), actor: actorName(e.actor_label) })),
      },
      targetRate: TARGET,
    };
  }
}

/** "leave_policy.updated" -> "Leave policy updated". */
export function humanAction(action: string): string {
  const s = action.replace(/[._]/g, ' ').trim().replace(/\bhr workspace\b/gi, 'HR Workspace').replace(/\b(hr|mfa|sso|api|bgv)\b/gi, (m) => m.toUpperCase());
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The name part of an audit actor label ("Aarav Mehta <owner@…>" reads "Aarav Mehta"): Home never shows addresses. */
export function actorName(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  return label.replace(/\s*<[^>]*>/g, '').replace(/\s+\S+@\S+$/, '').trim() || null;
}

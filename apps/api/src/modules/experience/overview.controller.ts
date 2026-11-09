import { Controller, Get, Injectable, Param } from '@nestjs/common';
import {
  DEFAULT_RATING_SCALE, overviewModuleParam, zonedTime,
  type ListItem, type ModuleOverview, type OverviewChart, type OverviewModule, type OverviewTile, type RatingLevel,
} from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, hasPermission, type Subject } from '../../platform/authz/policy';
import { MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AttendanceService } from '../attendance/attendance.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import { ENTITY_FIELDS } from '../payroll/payroll-common';
import { REQ_FIELDS, visibleRequisitionIds } from '../recruitment/recruitment-common';

const { localToday, addDays } = zonedTime;

/** Beyond the member's own record: an overview is a manager, HR or finance view. */
const wide = (s: Subject, permission: string) => grantsFor(s, permission).some((g) => g.scope !== 'own');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
/** In the workforce on a date: joined, not yet left, and past pre-boarding. */
const employedOn = (e: Row, d: string) => e.status !== 'pre_boarding' && e.date_of_joining <= d && (!e.last_working_day || e.last_working_day >= d);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const dayStart = (d: string) => new Date(`${d}T00:00:00Z`);
const countBy = <T>(rows: T[], key: (r: T) => string | null | undefined) => {
  const m = new Map<string, number>();
  for (const r of rows) { const k = key(r); if (k != null) m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
};
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Month starts (YYYY-MM-01) for the `n` months ending with the month of `today`, oldest first. */
export function monthStarts(today: string, n: number) {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1));
    return d.toISOString().slice(0, 10);
  });
}
const monthLabel = (start: string) => MONTHS[Number(start.slice(5, 7)) - 1]!;
const monthEnd = (start: string) => {
  const [y, m] = start.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The tiles and charts at the top of each module. Each module needs its feature and a wider-than-own grant of the
 * permission its list uses; every count is filtered with that permission's scope predicate, so a department
 * manager sees their department and HR sees the whole workspace.
 */
@Injectable()
export class OverviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
    private readonly attendance: AttendanceService,
  ) {}

  async build(module: OverviewModule): Promise<ModuleOverview> {
    // Attendance refreshes stale days through its own transaction, so it runs outside the read below.
    if (module === 'attendance') return this.attendanceOverview();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { features } = await this.entitlements.current(tx);
      const today = await this.today(tx);
      const need = (feature: string | null, permission: string) => {
        if (feature && !features.has(feature as never)) throw Errors.forbidden('This module is not part of your plan');
        // Permissions that need two-step verification (payroll) need it here too, exactly as on their own pages.
        const decision = hasPermission(s, permission);
        if (!decision.allowed && decision.reason === 'mfa_required') throw Errors.mfaRequired();
        if (!wide(s, permission)) throw Errors.forbidden('You need access to more than your own record to see this overview');
      };
      const done = (tiles: OverviewTile[], charts: OverviewChart[]): ModuleOverview => ({ module, generatedAt: new Date().toISOString(), today, tiles, charts });
      switch (module) {
        case 'employees': need(null, 'employees:read'); return done(...(await this.employees(tx, s, features, today)));
        case 'recruitment': need('recruitment', 'requisitions:read'); return done(...(await this.recruitment(tx, today)));
        case 'leave': need('leave', 'leave:read'); return done(...(await this.leave(tx, today)));
        case 'payroll': need('payroll', 'payroll:read'); return done(...(await this.payroll(tx, today)));
        case 'performance': need('performance', 'performance:read'); return done(...(await this.performance(tx, today)));
        case 'learning': need('learning', 'learning:read'); return done(...(await this.learning(tx, today)));
        case 'analytics': need(null, 'employees:read'); return done(...(await this.analytics(tx, s, features, today)));
        default: throw Errors.notFound('Overview');
      }
    });
  }

  private async today(tx: Tx) {
    const tz = (await tx.collection('tenants').findOne({}))!.timezone as string;
    return localToday(tz);
  }

  /** The employees a permission's scope covers, by id. */
  private async people(tx: Tx, permission: string): Promise<Map<string, Row>> {
    const scope = await this.authz.filter(permission, EMPLOYEE_FIELDS, tx);
    return new Map((await tx.collection('employees').find(scope)).map((e) => [e.id as string, e]));
  }

  /** Requisitions the member may see, and the applications on them. */
  private async hiringRows(tx: Tx) {
    const scope = await this.authz.filter('requisitions:read', REQ_FIELDS, tx);
    const reqs = await tx.collection('job_requisitions').find(scope, { projection: { status: 1, headcount: 1 } });
    const visible = await visibleRequisitionIds(tx, scope);
    const apps = await tx.collection('applications').find(visible ? { requisition_id: { $in: visible } } : {});
    return { reqs, apps };
  }

  // ---------------------------------------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------------------------------------

  private async headcount(tx: Tx, today: string) {
    const all = [...(await this.people(tx, 'employees:read')).values()];
    const months = monthStarts(today, 6);
    const ends = months.map((m, i) => (i === months.length - 1 ? today : monthEnd(m)));
    const count = (d: string) => all.filter((e) => employedOn(e, d)).length;
    const yearAgo = addDays(today, -365);
    const now = all.filter((e) => employedOn(e, today));
    const row = {
      now: now.length, month_ago: count(addDays(today, -30)), year_ago: count(yearAgo),
      new_this_month: all.filter((e) => e.status !== 'pre_boarding' && e.date_of_joining >= `${today.slice(0, 7)}-01` && e.date_of_joining <= today).length,
      upcoming: all.filter((e) => e.date_of_joining > today || e.status === 'pre_boarding').length,
      exits: all.filter((e) => e.status === 'exited' && e.last_working_day && e.last_working_day >= yearAgo && e.last_working_day <= today).length,
    };
    const names = await fieldById(tx, 'departments', now.map((e) => e.current_department_id));
    const groups = new Map<string, { id: string | null; name: string; count: number }>();
    for (const e of now) {
      const id = (e.current_department_id as string | null) ?? null;
      const g = groups.get(id ?? '') ?? { id, name: (id && names.get(id)) || 'No department', count: 0 };
      g.count++;
      groups.set(id ?? '', g);
    }
    const departments = [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const avg = (row.now + row.year_ago) / 2;
    return {
      now: row.now, monthAgo: row.month_ago, newThisMonth: row.new_this_month, upcoming: row.upcoming, exits: row.exits,
      attrition: avg > 0 ? Math.round((row.exits / avg) * 1000) / 10 : 0,
      trend: months.map((m, i) => ({ label: monthLabel(m), value: count(ends[i]!) })),
      departments,
    };
  }

  /** Top departments plus "Others", so a donut stays readable. */
  private departmentSlices(departments: { name: string; count: number; id: string | null }[]) {
    const top = departments.slice(0, 5).map((d) => ({ label: d.name, value: d.count, href: d.id ? `/employees?departmentId=${d.id}` : undefined }));
    const rest = departments.slice(5).reduce((t, d) => t + d.count, 0);
    return rest > 0 ? [...top, { label: 'Others', value: rest }] : top;
  }

  private async onLeaveToday(tx: Tx, s: Subject, features: Set<string>, today: string) {
    if (!features.has('leave') || !wide(s, 'leave:read')) return null;
    const people = await this.people(tx, 'leave:read');
    const away = await tx.collection('leave_requests').distinct<string>('employee_id', { employee_id: { $in: [...people.keys()] }, status: 'approved', start_date: { $lte: today }, end_date: { $gte: today } });
    return away.length;
  }

  private async employees(tx: Tx, s: Subject, features: Set<string>, today: string): Promise<[OverviewTile[], OverviewChart[]]> {
    const h = await this.headcount(tx, today);
    const away = await this.onLeaveToday(tx, s, features, today);
    const tiles: OverviewTile[] = [
      { key: 'total', label: 'Total employees', value: h.now, delta: h.now - h.monthAgo, hint: 'vs 30 days ago', tone: 'violet', icon: 'users', href: '/employees?status=active' },
      { key: 'new', label: 'New this month', value: h.newThisMonth, tone: 'teal', icon: 'user-plus', href: '/employees?sort=joined&dir=desc' },
    ];
    if (away !== null) tiles.push({ key: 'on-leave', label: 'On leave today', value: away, tone: 'orange', icon: 'calendar', href: '/leave' });
    tiles.push({ key: 'upcoming', label: 'Upcoming joiners', value: h.upcoming, tone: 'pink', icon: 'calendar-clock', href: '/employees?status=pre_boarding' });
    return [tiles, [
      { kind: 'line', key: 'headcount', title: 'Headcount trend', points: h.trend, caption: 'People employed at each month end' },
      { kind: 'donut', key: 'departments', title: 'Employees by department', slices: this.departmentSlices(h.departments), centerValue: String(h.now), centerLabel: 'Employees' },
    ]];
  }

  private async analytics(tx: Tx, s: Subject, features: Set<string>, today: string): Promise<[OverviewTile[], OverviewChart[]]> {
    const h = await this.headcount(tx, today);
    const tiles: OverviewTile[] = [
      { key: 'headcount', label: 'Headcount', value: h.now, delta: h.now - (h.trend[0]?.value ?? h.now), hint: 'vs 6 months ago', tone: 'violet', icon: 'users', href: '/employees' },
      { key: 'retention', label: 'Retention rate', value: Math.max(0, Math.round((100 - h.attrition) * 10) / 10), unit: 'percent', hint: 'Last 12 months', tone: 'green', icon: 'heart' },
      { key: 'attrition', label: 'Attrition rate', value: h.attrition, unit: 'percent', invert: true, hint: `${h.exits} left in 12 months`, tone: 'pink', icon: 'trending-down', href: features.has('workforce_analytics') && wide(s, 'insights:attrition') ? '/insights/attrition' : undefined },
    ];
    let hiring: { days: number | null; hires: number; open: number } | null = null;
    if (features.has('recruitment') && wide(s, 'requisitions:read')) {
      const { reqs, apps } = await this.hiringRows(tx);
      const since = dayStart(addDays(today, -365)).getTime();
      const hired = apps.filter((a) => a.status === 'hired' && a.hired_at instanceof Date && a.hired_at.getTime() >= since);
      const days = hired.length ? Math.round(hired.reduce((t, a) => t + (a.hired_at.getTime() - (a.applied_at as Date).getTime()) / 86_400_000, 0) / hired.length) : null;
      const r = { days, hires: hired.length, open: reqs.filter((x) => x.status === 'open').reduce((t, x) => t + (Number(x.headcount) || 0), 0) };
      hiring = r;
      tiles.push({ key: 'time-to-hire', label: 'Avg. time to hire', value: r.days, unit: 'days', hint: `${r.hires} hire(s) in 12 months`, tone: 'orange', icon: 'timer', href: '/recruitment' });
    }

    // Plain statements computed from the numbers above, worded so they never claim more than the data shows.
    const insights: ListItem[] = [];
    const first = h.trend[0]?.value ?? 0;
    if (first > 0 && h.now !== first) {
      const change = Math.round(((h.now - first) / first) * 1000) / 10;
      insights.push({ label: `Headcount ${change > 0 ? 'grew' : 'fell'} ${Math.abs(change)}% in six months`, detail: `${first} to ${h.now} people`, tone: change > 0 ? 'success' : 'warning', href: '/employees' });
    } else insights.push({ label: 'Headcount is steady over six months', detail: `${h.now} people`, tone: 'neutral' });
    const biggest = h.departments[0];
    if (biggest && h.now > 0) insights.push({ label: `${biggest.name} is the largest team`, detail: `${biggest.count} people, ${pct(biggest.count, h.now)}% of the workforce`, tone: 'info' });
    insights.push({ label: `Attrition over 12 months is ${h.attrition}%`, detail: `${h.exits} leaver(s)`, tone: h.attrition >= 15 ? 'danger' : h.attrition >= 8 ? 'warning' : 'success' });
    if (hiring) insights.push({ label: `${hiring.open} open position(s)`, detail: hiring.days !== null ? `Hires take ${hiring.days} days on average` : 'No hires in the last 12 months', tone: 'info', href: '/recruitment' });
    if (features.has('workforce_analytics') && wide(s, 'insights:attrition')) {
      const current = [...(await this.people(tx, 'insights:attrition')).values()].filter((e) => e.status !== 'exited').map((e) => e.id as string);
      // Each person's latest score.
      const latest = new Map<string, string>();
      for (const x of await tx.collection('attrition_scores').find({ employee_id: { $in: current } }, { sort: { computed_on: 1 }, projection: { employee_id: 1, band: 1 } })) latest.set(x.employee_id, x.band);
      const high = [...latest.values()].filter((b) => b === 'high').length;
      insights.push({ label: `${high} ${high === 1 ? 'person shows' : 'people show'} high attrition signals`, detail: 'Rule-based, a prompt for a conversation', tone: high > 0 ? 'warning' : 'success', href: '/insights/attrition?band=high' });
    }
    return [tiles, [
      { kind: 'bar', key: 'departments', title: 'Workforce by department', points: h.departments.slice(0, 8).map((d) => ({ label: d.name, value: d.count })) },
      { kind: 'list', key: 'insights', title: 'Key insights', items: insights, empty: 'Not enough data yet' },
    ]];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Recruitment
  // ---------------------------------------------------------------------------------------------------------

  private async recruitment(tx: Tx, today: string): Promise<[OverviewTile[], OverviewChart[]]> {
    const { reqs, apps } = await this.hiringRows(tx);
    const stages = await tx.collection('recruitment_stages').find({}, { sort: { position: 1 } });
    const kind = new Map(stages.map((st) => [st.id as string, st.kind as string]));
    const appIds = apps.map((a) => a.id);
    const now = Date.now();
    const interviews = await tx.collection('interviews').count({ application_id: { $in: appIds }, status: 'scheduled', starts_at: { $gte: new Date(now), $lt: new Date(now + 14 * 86_400_000) } });
    const offers = await tx.collection('offers').count({ application_id: { $in: appIds }, status: { $in: ['pending_approval', 'approved', 'sent'] } });
    const active = apps.filter((a) => a.status === 'active');
    const open = reqs.filter((x) => x.status === 'open');
    const weekAgo = dayStart(addDays(today, -7)).getTime();
    const t = {
      jobs: open.length, positions: open.reduce((n, x) => n + (Number(x.headcount) || 0), 0), active: active.length,
      screening: active.filter((a) => kind.get(a.stage_id) === 'screen').length, interviews, offers,
      week: apps.filter((a) => (a.applied_at as Date).getTime() >= weekAgo).length,
    };
    const perStage = countBy(active, (a) => a.stage_id as string);
    const funnel = stages.filter((st) => !st.archived_at).map((st) => ({ stage: st.name as string, count: perStage.get(st.id) ?? 0 }));
    // Eight ISO weeks (Monday to Sunday), the last one being this week.
    const day = new Date(`${today}T00:00:00Z`).getUTCDay();
    const monday = addDays(today, -((day + 6) % 7));
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const from = dayStart(addDays(monday, (i - 7) * 7));
      const to = from.getTime() + 7 * 86_400_000;
      const d = isoDay(from);
      return { wk: `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]}`, count: apps.filter((a) => (a.applied_at as Date).getTime() >= from.getTime() && (a.applied_at as Date).getTime() < to).length };
    });
    return [[
      { key: 'jobs', label: 'Active jobs', value: t.jobs, hint: `${t.positions} open position(s)`, tone: 'violet', icon: 'briefcase', href: '/recruitment?status=open' },
      { key: 'applications', label: 'Applications', value: t.active, delta: t.week, hint: 'new in 7 days', tone: 'blue', icon: 'file-text', href: '/recruitment/candidates' },
      { key: 'screening', label: 'In screening', value: t.screening, tone: 'pink', icon: 'user-search', href: '/recruitment/candidates' },
      { key: 'interviews', label: 'Interviews', value: t.interviews, hint: 'Next 14 days', tone: 'orange', icon: 'message-square', href: '/recruitment/interviews' },
      { key: 'offers', label: 'Offers', value: t.offers, hint: 'Open offers', tone: 'green', icon: 'handshake', href: '/recruitment/candidates' },
    ], [
      { kind: 'bar', key: 'pipeline', title: 'Candidate pipeline', points: funnel.map((f) => ({ label: f.stage, value: f.count })), caption: 'Active applications by stage' },
      { kind: 'line', key: 'applications', title: 'Applications per week', points: weeks.map((w) => ({ label: w.wk, value: w.count })) },
    ]];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Attendance
  // ---------------------------------------------------------------------------------------------------------

  private async attendanceOverview(): Promise<ModuleOverview> {
    const pre = await this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { features } = await this.entitlements.current(tx);
      if (!features.has('attendance_basic')) throw Errors.forbidden('This module is not part of your plan');
      if (!wide(s, 'attendance:read')) throw Errors.forbidden('You need access to more than your own record to see this overview');
      return { today: await this.today(tx) };
    });
    const { today } = pre;
    // The team view brings today's days up to date before counting them, exactly as the Team attendance page does.
    const team = await this.attendance.team({ date: today });
    const sum = team.summary as Record<string, number>;
    const total = sum.total ?? 0;
    const offToday = (sum.holiday ?? 0) + (sum.weekly_off ?? 0) + (sum.not_joined ?? 0);
    const onLeave = (sum.on_leave ?? 0);
    // Punch times arrive as Date objects from the driver; keep them as ISO strings for sorting and the response.
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : null);
    const rows = (team.rows as unknown as { employeeName: string; firstIn: unknown; department: string | null; status: string; lateMinutes: number }[])
      .map((r) => ({ ...r, firstIn: iso(r.firstIn) }));
    // A day "in progress" only counts as present once the person has punched in.
    const notInYet = rows.filter((r) => r.status === 'in_progress' && !r.firstIn).length;
    const present = (sum.present ?? 0) + (sum.half_day ?? 0) + (sum.half_day_leave ?? 0) + (sum.in_progress ?? 0) - notInYet;
    const expected = total - offToday - onLeave;

    return this.db.tenant(async (tx) => {
      const people = await this.people(tx, 'attendance:read');
      const from = addDays(today, -6);
      const rows7 = await tx.collection('attendance_days').find({ employee_id: { $in: [...people.keys()] }, work_date: { $gte: from, $lte: today } }, { projection: { work_date: 1, status: 1, first_in: 1 } });
      const days = Array.from({ length: 7 }, (_, i) => {
        const day = addDays(from, i);
        const on = rows7.filter((d) => d.work_date === day);
        return {
          day, label: DAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!,
          present: on.filter((d) => ['present', 'half_day', 'half_day_leave', 'missing_punch'].includes(d.status) || (d.status === 'in_progress' && d.first_in != null)).length,
          expected: on.filter((d) => !['holiday', 'weekly_off', 'not_joined', 'on_leave'].includes(d.status)).length,
        };
      });
      const checkins: ListItem[] = rows
        .filter((r) => r.firstIn)
        .sort((a, b) => (b.firstIn ?? '').localeCompare(a.firstIn ?? ''))
        .slice(0, 6)
        .map((r) => ({ label: r.employeeName, detail: r.department, value: r.firstIn, tone: r.lateMinutes > 0 ? 'warning' : 'success' }));
      const tiles: OverviewTile[] = [
        { key: 'total', label: 'Total employees', value: total, tone: 'violet', icon: 'users', href: '/attendance/team' },
        { key: 'present', label: 'Present', value: present, tone: 'green', icon: 'fingerprint', href: '/attendance/team?status=present' },
        { key: 'on-leave', label: 'On leave', value: onLeave, tone: 'orange', icon: 'calendar', href: '/attendance/team?status=on_leave' },
        { key: 'late', label: 'Late', value: sum.late ?? 0, invert: true, tone: 'blue', icon: 'clock', href: '/attendance/team' },
        { key: 'absent', label: 'Absent', value: sum.absent ?? 0, invert: true, hint: notInYet ? `${notInYet} not in yet` : undefined, tone: 'pink', icon: 'user-x', href: '/attendance/team?status=absent' },
      ];
      return {
        module: 'attendance' as const, generatedAt: new Date().toISOString(), today, tiles,
        charts: [
          { kind: 'ring', key: 'rate', title: 'Attendance today', value: pct(present, expected), label: 'Attendance rate', caption: expected > 0 ? `${present} of ${expected} expected are in${notInYet ? `, ${notInYet} not in yet` : ''}` : 'Nobody is expected at work today' },
          { kind: 'bar', key: 'trend', title: 'Attendance, last 7 days', unit: 'percent', points: days.map((d) => ({ label: d.label, value: pct(d.present, d.expected) ?? 0 })) },
          { kind: 'list', key: 'checkins', title: 'Latest check-ins', items: checkins, empty: 'No one has checked in yet today', href: '/attendance/team' },
        ],
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Leave
  // ---------------------------------------------------------------------------------------------------------

  private async leave(tx: Tx, today: string): Promise<[OverviewTile[], OverviewChart[]]> {
    const people = await this.people(tx, 'leave:read');
    const requests = await tx.collection('leave_requests').find({ employee_id: { $in: [...people.keys()] } });
    const monthStart = dayStart(`${today.slice(0, 7)}-01`).getTime();
    const thisMonth = requests.filter((x) => (x.created_at as Date).getTime() >= monthStart);
    const t = {
      total: thisMonth.length, approved: thisMonth.filter((x) => x.status === 'approved').length, pending: thisMonth.filter((x) => x.status === 'pending').length,
      rejected: thisMonth.filter((x) => x.status === 'rejected').length, pending_all: requests.filter((x) => x.status === 'pending').length,
    };
    const leaveTypes = new Map((await tx.collection('leave_types').find({ id: { $in: [...new Set(requests.map((x) => x.leave_type_id))] } })).map((lt) => [lt.id as string, lt]));
    const daysBy = new Map<string, number>();
    for (const x of requests) if (x.status === 'approved' && x.start_date >= `${today.slice(0, 4)}-01-01`) daysBy.set(x.leave_type_id, (daysBy.get(x.leave_type_id) ?? 0) + Number(x.days));
    const types = [...daysBy].map(([id, days]) => ({ name: leaveTypes.get(id)?.name as string, color: leaveTypes.get(id)?.color as string, days: String(days) })).sort((a, b) => Number(b.days) - Number(a.days));
    const away = requests
      .filter((x) => x.status === 'approved' && x.end_date >= today && x.start_date <= addDays(today, 14))
      .map((x) => ({ name: displayName(people.get(x.employee_id) as never), type: leaveTypes.get(x.leave_type_id)?.name as string, start: x.start_date as string, end: x.end_date as string, employeeId: x.employee_id as string }))
      .sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name))
      .slice(0, 6);
    const totalDays = types.reduce((s, x) => s + Number(x.days), 0);
    return [[
      { key: 'requests', label: 'Leave requests', value: t.total, hint: 'This month', tone: 'violet', icon: 'calendar-range', href: '/leave' },
      { key: 'approved', label: 'Approved', value: t.approved, hint: 'This month', tone: 'green', icon: 'check', href: '/leave' },
      { key: 'pending', label: 'Pending', value: t.pending_all, hint: 'Waiting for a decision', tone: 'orange', icon: 'clock', href: '/approvals' },
      { key: 'rejected', label: 'Rejected', value: t.rejected, hint: 'This month', tone: 'pink', icon: 'x', href: '/leave' },
    ], [
      { kind: 'donut', key: 'types', title: 'Leave taken this year', slices: types.map((x) => ({ label: x.name, value: Number(x.days), color: x.color })), centerValue: String(Math.round(totalDays * 10) / 10), centerLabel: 'Days' },
      { kind: 'list', key: 'away', title: 'Away in the next 14 days', items: away.map((a) => ({ label: a.name, detail: a.type, value: a.start === a.end ? a.start : `${a.start} to ${a.end}`, href: `/employees/${a.employeeId}` })), empty: 'Nobody is away in the next two weeks' },
    ]];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Payroll
  // ---------------------------------------------------------------------------------------------------------

  private async payroll(tx: Tx, today: string): Promise<[OverviewTile[], OverviewChart[]]> {
    const scope = await this.authz.filter('payroll:read', ENTITY_FIELDS('legal_entity_id'), tx);
    const runs = await tx.collection('payroll_runs').find(scope);
    const paid = runs.filter((x) => x.status !== 'cancelled' && x.status !== 'draft');
    const top = [...paid].sort((a, b) => (b.period_start as string).localeCompare(a.period_start) || (b.created_at as Date).getTime() - (a.created_at as Date).getTime())[0];
    if (!top) {
      return [[
        { key: 'net', label: 'Monthly payroll', value: null, unit: 'money', hint: 'No payroll run yet', tone: 'violet', icon: 'wallet', href: '/payroll' },
      ], []];
    }
    const latest = {
      id: top.id as string, currency: top.currency as string, period: `${monthLabel(top.period_start)} ${String(top.period_start).slice(0, 4)}`, net: String(top.net), gross: String(top.gross),
      deductions: String(top.deductions), employer: String(top.employer_contributions), reimbursements: String(top.reimbursements), employees: top.employee_count as number,
    };
    const cur = latest.currency;
    const months = monthStarts(today, 6);
    const byMonth = new Map<string, number>();
    for (const x of runs) {
      if (x.currency !== cur || !['computed', 'pending_approval', 'finalised'].includes(x.status) || x.period_start < months[0]!) continue;
      const m = `${String(x.period_start).slice(0, 7)}-01`;
      byMonth.set(m, (byMonth.get(m) ?? 0) + Number(x.net));
    }
    // Every entity's run for the latest month, in the same currency, so the month's total is not one entity's.
    const sameMonth = paid.filter((x) => x.currency === cur && x.period_start === top.period_start);
    const monthNet = { net: String(sameMonth.reduce((t, x) => t + Number(x.net), 0)), employees: sameMonth.reduce((t, x) => t + (Number(x.employee_count) || 0), 0) };
    const yearStart = monthStarts(today, 12)[0]!;
    const finalised = runs.filter((x) => x.status === 'finalised' && x.period_start >= yearStart);
    const onTime = { finalised: finalised.length, on_time: finalised.filter((x) => x.finalised_at instanceof Date && isoDay(x.finalised_at) <= x.pay_date).length };
    const net = Number(monthNet?.net ?? latest.net);
    const employees = monthNet?.employees ?? latest.employees;
    const gross = Number(latest.gross);
    return [[
      { key: 'net', label: 'Monthly payroll (net)', value: net, unit: 'money', currency: cur, hint: latest.period, tone: 'violet', icon: 'wallet', href: `/payroll/runs/${latest.id}` },
      { key: 'employees', label: 'Employees paid', value: employees, hint: latest.period, tone: 'blue', icon: 'users', href: `/payroll/runs/${latest.id}` },
      { key: 'avg', label: 'Avg. net pay', value: employees > 0 ? Math.round(net / employees) : null, unit: 'money', currency: cur, hint: 'Per employee', tone: 'pink', icon: 'banknote', href: '/payroll/salaries' },
      { key: 'on-time', label: 'On-time payment', value: pct(onTime.on_time, onTime.finalised), unit: 'percent', hint: `${onTime.finalised} finalised run(s) in 12 months`, tone: 'green', icon: 'check', href: '/payroll' },
    ], [
      { kind: 'bar', key: 'trend', title: 'Payroll trend (net, last 6 months)', unit: 'money', currency: cur, points: months.map((m) => ({ label: monthLabel(m), value: byMonth.get(m) ?? 0 })) },
      {
        kind: 'donut', key: 'split', title: `Payroll split, ${latest.period}`, unit: 'money', currency: cur, centerValue: String(gross), centerLabel: 'Gross',
        slices: [
          { label: 'Net pay', value: Number(latest.net) - Number(latest.reimbursements) },
          { label: 'Deductions', value: Number(latest.deductions) },
          { label: 'Reimbursements', value: Number(latest.reimbursements) },
          { label: 'Employer contributions', value: Number(latest.employer) },
        ].filter((x) => x.value > 0),
      },
    ]];
  }

  // ---------------------------------------------------------------------------------------------------------
  // Performance and learning
  // ---------------------------------------------------------------------------------------------------------

  private async performance(tx: Tx, today: string): Promise<[OverviewTile[], OverviewChart[]]> {
    const people = await this.people(tx, 'performance:read');
    const ids = [...people.keys()];
    const cycles = await tx.collection('review_cycles').find({ status: { $ne: 'draft' } });
    const live = (c: Row) => (['active', 'calibration'].includes(c.status) ? 1 : 0);
    const time = (d: unknown) => (d instanceof Date ? d.getTime() : -Infinity);
    const c0 = cycles.sort((a, b) => live(b) - live(a) || time(b.launched_at) - time(a.launched_at))[0];
    const cycle = c0 ? { id: c0.id as string, name: c0.name as string, scale: c0.rating_scale as RatingLevel[], manager_due: (c0.manager_due as string | null) ?? null } : undefined;
    const reviews = cycle ? await tx.collection('reviews').find({ cycle_id: cycle.id, employee_id: { $in: ids }, excluded: { $ne: true } }) : [];
    const r = {
      total: reviews.length, reviewed: reviews.filter((v) => v.manager_status === 'submitted').length,
      in_progress: reviews.filter((v) => v.manager_status === 'pending' && v.self_status === 'submitted').length,
      due: reviews.filter((v) => v.manager_status === 'pending' && cycle?.manager_due && cycle.manager_due <= addDays(today, 7)).length,
    };
    const active = await tx.collection('goals').find({ employee_id: { $in: ids }, status: 'active', period_end: { $gte: addDays(today, -90) } }, { projection: { progress: 1, confidence: 1 } });
    const goals = {
      active: active.length,
      avg: active.length ? String(Math.round((active.reduce((t, g) => t + Number(g.progress), 0) / active.length) * 10) / 10) : null,
      at_risk: active.filter((g) => ['at_risk', 'off_track'].includes(g.confidence)).length,
    };
    const ratingCount = countBy(reviews, (v) => (v.final_rating ?? v.manager_rating) == null ? null : String(Number(v.final_rating ?? v.manager_rating)));
    const ratings = [...ratingCount].map(([rating, count]) => ({ rating: Number(rating), count }));
    const rated = ratings.reduce((t, x) => t + x.count, 0);
    const scale = cycle?.scale?.length ? cycle.scale : DEFAULT_RATING_SCALE;
    return [[
      { key: 'total', label: cycle ? 'In the review cycle' : 'Reviews', value: r.total, hint: cycle?.name ?? 'No review cycle launched yet', tone: 'violet', icon: 'users', href: '/reviews?view=team' },
      { key: 'reviewed', label: 'Reviewed', value: r.reviewed, hint: 'Manager review submitted', tone: 'green', icon: 'check', href: '/reviews?view=team' },
      { key: 'in-progress', label: 'In progress', value: r.in_progress, hint: 'Self review in, manager pending', tone: 'orange', icon: 'clock', href: '/reviews?view=team' },
      { key: 'goals-at-risk', label: 'Goals at risk', value: goals.at_risk, invert: true, hint: `${goals.active} active goal(s)`, tone: 'pink', icon: 'target', href: '/goals' },
    ], [
      { kind: 'ring', key: 'goals', title: 'Goal progress', value: goals.avg === null ? null : Number(goals.avg), label: 'Average progress', caption: `${goals.active} active goal(s)` },
      { kind: 'meter', key: 'ratings', title: 'Performance rating', caption: rated ? `${rated} rated review(s) in ${cycle!.name}` : 'No ratings yet in this cycle', rows: [...scale].sort((a, b) => b.value - a.value).map((l) => {
        const count = ratings.find((x) => x.rating === l.value)?.count ?? 0;
        return { label: l.label, count, value: pct(count, rated) ?? 0 };
      }) },
    ]];
  }

  private async learning(tx: Tx, today: string): Promise<[OverviewTile[], OverviewChart[]]> {
    const people = await this.people(tx, 'learning:read');
    const list = await tx.collection('course_assignments').find({ employee_id: { $in: [...people.keys()] } }, { projection: { employee_id: 1, course_id: 1, status: 1, due_on: 1, completed_on: 1 } });
    const live = list.filter((a) => a.status !== 'cancelled');
    const t = {
      courses: await tx.collection('courses').count({ archived_at: null }),
      learners: new Set(live.map((a) => a.employee_id)).size, total: live.length, completed: list.filter((a) => a.status === 'completed').length,
      overdue: list.filter((a) => ['assigned', 'in_progress'].includes(a.status) && a.due_on && a.due_on < today).length,
    };
    const months = monthStarts(today, 6);
    const byMonth = countBy(list.filter((a) => a.status === 'completed' && a.completed_on && a.completed_on >= months[0]!), (a) => `${String(a.completed_on).slice(0, 7)}-01`);
    const titles = await fieldById(tx, 'courses', live.map((a) => a.course_id), 'title');
    const perCourse = new Map<string, { title: string; enrolled: number; completed: number }>();
    for (const a of live) {
      const c = perCourse.get(a.course_id) ?? { title: titles.get(a.course_id) ?? '', enrolled: 0, completed: 0 };
      c.enrolled++;
      if (a.status === 'completed') c.completed++;
      perCourse.set(a.course_id, c);
    }
    const top = [...perCourse.values()].sort((a, b) => b.enrolled - a.enrolled || a.title.localeCompare(b.title)).slice(0, 5);
    return [[
      { key: 'courses', label: 'Active courses', value: t.courses, tone: 'violet', icon: 'book-open', href: '/learning?view=catalogue' },
      { key: 'learners', label: 'Enrolled learners', value: t.learners, tone: 'blue', icon: 'users', href: '/learning?view=team' },
      { key: 'completion', label: 'Completion rate', value: pct(t.completed, t.total), unit: 'percent', hint: `${t.completed} of ${t.total} completed`, tone: 'green', icon: 'graduation-cap', href: '/learning?view=team' },
      { key: 'overdue', label: 'Overdue', value: t.overdue, invert: true, tone: 'orange', icon: 'clock', href: '/learning?view=team&status=overdue' },
    ], [
      { kind: 'line', key: 'completions', title: 'Courses completed per month', points: months.map((m) => ({ label: monthLabel(m), value: byMonth.get(m) ?? 0 })) },
      { kind: 'list', key: 'top', title: 'Top courses', items: top.map((c) => ({ label: c.title, detail: `${c.enrolled} enrolled`, value: `${pct(c.completed, c.enrolled) ?? 0}% done` })), empty: 'No one is enrolled in a course yet', href: '/learning?view=catalogue' },
    ]];
  }
}

@Controller('dashboard/modules')
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get(':module')
  @Doc({ summary: 'KPI tiles and charts for one module, computed from live records and limited to what your roles let you see' })
  get(@Param('module', new ZodPipe(overviewModuleParam)) module: OverviewModule) {
    return this.overview.build(module);
  }
}

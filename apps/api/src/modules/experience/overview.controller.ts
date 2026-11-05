import { Controller, Get, Injectable, Param } from '@nestjs/common';
import {
  DEFAULT_RATING_SCALE, overviewModuleParam, zonedTime,
  type ListItem, type ModuleOverview, type OverviewChart, type OverviewModule, type OverviewTile, type RatingLevel,
} from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, hasPermission, type Subject } from '../../platform/authz/policy';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { AttendanceService } from '../attendance/attendance.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { ENTITY_SCOPE } from '../payroll/payroll-common';
import { REQ_SCOPE } from '../recruitment/recruitment-common';

const { localToday, addDays } = zonedTime;

/** Beyond the member's own record: an overview is a manager, HR or finance view. */
const wide = (s: Subject, permission: string) => grantsFor(s, permission).some((g) => g.scope !== 'own');

const NAME = `trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name)`;
/** In the workforce on a date: joined, not yet left, and past pre-boarding. */
const employedOn = (d: string) => `(e.date_of_joining <= ${d} and (e.last_working_day is null or e.last_working_day >= ${d}) and e.status <> 'pre_boarding')`;
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
        case 'performance': need('talent', 'performance:read'); return done(...(await this.performance(tx, today)));
        case 'learning': need('talent', 'learning:read'); return done(...(await this.learning(tx, today)));
        case 'analytics': need(null, 'employees:read'); return done(...(await this.analytics(tx, s, features, today)));
        default: throw Errors.notFound('Overview');
      }
    });
  }

  private async today(tx: Tx) {
    const tz = (await one<{ tz: string }>(tx, 'select timezone as tz from tenants where id = app_tenant_id()'))!.tz;
    return localToday(tz);
  }

  private async scope(tx: Tx, permission: string, cols: Parameters<AuthzService['predicate']>[1] = EMPLOYEE_SCOPE) {
    const params: unknown[] = [];
    const sql = await this.authz.predicate(permission, cols, params, tx);
    return { sql, params };
  }

  // ---------------------------------------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------------------------------------

  private async headcount(tx: Tx, today: string) {
    const { sql, params } = await this.scope(tx, 'employees:read');
    const months = monthStarts(today, 6);
    const ends = months.map((m, i) => (i === months.length - 1 ? today : monthEnd(m)));
    const n = params.length;
    const row = (await one<Record<string, number>>(
      tx,
      `select count(*) filter (where ${employedOn(`$${n + 1}::date`)})::int as now,
              count(*) filter (where ${employedOn(`($${n + 1}::date - 30)`)})::int as month_ago,
              count(*) filter (where ${employedOn(`($${n + 1}::date - 365)`)})::int as year_ago,
              count(*) filter (where e.date_of_joining between date_trunc('month', $${n + 1}::date)::date and $${n + 1}::date and e.status <> 'pre_boarding')::int as new_this_month,
              count(*) filter (where e.date_of_joining > $${n + 1}::date or e.status = 'pre_boarding')::int as upcoming,
              count(*) filter (where e.status = 'exited' and e.last_working_day between $${n + 1}::date - 365 and $${n + 1}::date)::int as exits,
              ${ends.map((d, i) => `count(*) filter (where ${employedOn(`'${d}'::date`)})::int as m${i}`).join(', ')}
         from employees e where ${sql}`,
      [...params, today],
    ))!;
    const departments = await many<{ name: string; count: number; id: string | null }>(
      tx,
      `select d.id, coalesce(d.name, 'No department') as name, count(*)::int as count
         from employees e left join departments d on d.id = e.current_department_id
        where ${sql} and ${employedOn(`$${n + 1}::date`)}
        group by d.id, d.name order by count desc, name`,
      [...params, today],
    );
    const avg = (row.now! + row.year_ago!) / 2;
    return {
      now: row.now!, monthAgo: row.month_ago!, newThisMonth: row.new_this_month!, upcoming: row.upcoming!, exits: row.exits!,
      attrition: avg > 0 ? Math.round((row.exits! / avg) * 1000) / 10 : 0,
      trend: months.map((m, i) => ({ label: monthLabel(m), value: row[`m${i}`] ?? 0 })),
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
    const { sql, params } = await this.scope(tx, 'leave:read');
    params.push(today);
    return (await one<{ n: number }>(
      tx,
      `select count(distinct r.employee_id)::int as n from leave_requests r join employees e on e.id = r.employee_id
        where ${sql} and r.status = 'approved' and $${params.length}::date between r.start_date and r.end_date`,
      params,
    ))!.n;
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
      const { sql, params } = await this.scope(tx, 'requisitions:read', REQ_SCOPE);
      params.push(today);
      const r = (await one<{ days: number | null; hires: number; open: number }>(
        tx,
        `select round(avg(extract(epoch from (a.hired_at - a.applied_at)) / 86400) filter (where a.status = 'hired' and a.hired_at >= $${params.length}::date - 365))::int as days,
                count(*) filter (where a.status = 'hired' and a.hired_at >= $${params.length}::date - 365)::int as hires,
                (select coalesce(sum(r.headcount), 0) from job_requisitions r where ${sql} and r.status = 'open')::int as open
           from applications a join job_requisitions r on r.id = a.requisition_id where ${sql}`,
        params,
      ))!;
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
      const { sql, params } = await this.scope(tx, 'insights:attrition');
      const high = (await one<{ n: number }>(
        tx,
        `select count(*)::int as n from employees e join lateral (select band from attrition_scores x where x.employee_id = e.id order by computed_on desc limit 1) a on true
          where ${sql} and e.status <> 'exited' and a.band = 'high'`,
        params,
      ))!.n;
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
    const { sql, params } = await this.scope(tx, 'requisitions:read', REQ_SCOPE);
    const n = params.length;
    const t = (await one<{ jobs: number; positions: number; active: number; screening: number; interviews: number; offers: number; week: number }>(
      tx,
      `select (select count(*) from job_requisitions r where ${sql} and r.status = 'open')::int as jobs,
              (select coalesce(sum(r.headcount), 0) from job_requisitions r where ${sql} and r.status = 'open')::int as positions,
              count(*) filter (where a.status = 'active')::int as active,
              count(*) filter (where a.status = 'active' and s.kind = 'screen')::int as screening,
              (select count(*) from interviews i join applications ia on ia.id = i.application_id join job_requisitions r on r.id = ia.requisition_id
                where ${sql} and i.status = 'scheduled' and i.starts_at >= now() and i.starts_at < now() + interval '14 days')::int as interviews,
              (select count(*) from offers o join applications oa on oa.id = o.application_id join job_requisitions r on r.id = oa.requisition_id
                where ${sql} and o.status in ('pending_approval', 'approved', 'sent'))::int as offers,
              count(*) filter (where a.applied_at >= $${n + 1}::date - 7)::int as week
         from applications a join job_requisitions r on r.id = a.requisition_id join recruitment_stages s on s.id = a.stage_id
        where ${sql}`,
      [...params, today],
    ))!;
    const funnel = await many<{ stage: string; count: number }>(
      tx,
      `select s.name as stage, count(a.id)::int as count
         from recruitment_stages s
         left join applications a on a.stage_id = s.id and a.status = 'active' and a.requisition_id in (select r.id from job_requisitions r where ${sql})
        where s.archived_at is null group by s.id, s.name, s.position order by s.position`,
      params,
    );
    const weeks = await many<{ wk: string; count: number }>(
      tx,
      `select to_char(w, 'DD Mon') as wk, (select count(*) from applications a join job_requisitions r on r.id = a.requisition_id
                where ${sql} and a.applied_at >= w and a.applied_at < w + interval '7 days')::int as count
         from generate_series(date_trunc('week', $${n + 1}::date) - interval '7 weeks', date_trunc('week', $${n + 1}::date), interval '7 days') w order by w`,
      [...params, today],
    );
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
      const { sql, params } = await this.scope(tx, 'attendance:read');
      const from = addDays(today, -6);
      params.push(from, today);
      const days = await many<{ day: string; label: string; present: number; expected: number }>(
        tx,
        `select g::date::text as day, to_char(g, 'Dy') as label,
                count(d.*) filter (where d.status in ('present', 'half_day', 'half_day_leave', 'missing_punch') or (d.status = 'in_progress' and d.first_in is not null))::int as present,
                count(d.*) filter (where d.status not in ('holiday', 'weekly_off', 'not_joined', 'on_leave'))::int as expected
           from generate_series($${params.length - 1}::date, $${params.length}::date, interval '1 day') g
           left join (attendance_days d join employees e on e.id = d.employee_id and ${sql}) on d.work_date = g::date
          group by g order by g`,
        params,
      );
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
    const { sql, params } = await this.scope(tx, 'leave:read');
    const n = params.length;
    const p = [...params, today];
    const t = (await one<{ total: number; approved: number; pending: number; rejected: number; pending_all: number }>(
      tx,
      `select count(*) filter (where r.created_at >= date_trunc('month', $${n + 1}::date))::int as total,
              count(*) filter (where r.created_at >= date_trunc('month', $${n + 1}::date) and r.status = 'approved')::int as approved,
              count(*) filter (where r.created_at >= date_trunc('month', $${n + 1}::date) and r.status = 'pending')::int as pending,
              count(*) filter (where r.created_at >= date_trunc('month', $${n + 1}::date) and r.status = 'rejected')::int as rejected,
              count(*) filter (where r.status = 'pending')::int as pending_all
         from leave_requests r join employees e on e.id = r.employee_id where ${sql}`,
      p,
    ))!;
    const types = await many<{ name: string; color: string; days: string }>(
      tx,
      `select lt.name, lt.color, sum(r.days)::text as days
         from leave_requests r join employees e on e.id = r.employee_id join leave_types lt on lt.id = r.leave_type_id
        where ${sql} and r.status = 'approved' and r.start_date >= date_trunc('year', $${n + 1}::date)
        group by lt.id, lt.name, lt.color order by sum(r.days) desc`,
      p,
    );
    const away = await many<{ name: string; type: string; start: string; end: string; employeeId: string }>(
      tx,
      `select ${NAME} as name, lt.name as type, r.start_date::text as start, r.end_date::text as "end", e.id as "employeeId"
         from leave_requests r join employees e on e.id = r.employee_id join leave_types lt on lt.id = r.leave_type_id
        where ${sql} and r.status = 'approved' and r.end_date >= $${n + 1}::date and r.start_date <= $${n + 1}::date + 14
        order by r.start_date, name limit 6`,
      p,
    );
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
    const { sql, params } = await this.scope(tx, 'payroll:read', ENTITY_SCOPE('r.legal_entity_id'));
    const latest = await one<{ id: string; currency: string; period: string; net: string; gross: string; deductions: string; employer: string; reimbursements: string; employees: number }>(
      tx,
      `select r.id, r.currency, to_char(r.period_start, 'Mon YYYY') as period, r.net::text as net, r.gross::text as gross, r.deductions::text as deductions,
              r.employer_contributions::text as employer, r.reimbursements::text as reimbursements, r.employee_count as employees
         from payroll_runs r where ${sql} and r.status <> 'cancelled' and r.status <> 'draft' order by r.period_start desc, r.created_at desc limit 1`,
      params,
    );
    if (!latest) {
      return [[
        { key: 'net', label: 'Monthly payroll', value: null, unit: 'money', hint: 'No payroll run yet', tone: 'violet', icon: 'wallet', href: '/payroll' },
      ], []];
    }
    const cur = latest.currency;
    const months = monthStarts(today, 6);
    const n = params.length;
    const series = await many<{ month: string; net: string }>(
      tx,
      `select to_char(r.period_start, 'YYYY-MM-01') as month, sum(r.net)::text as net
         from payroll_runs r where ${sql} and r.currency = $${n + 1} and r.status in ('computed', 'pending_approval', 'finalised') and r.period_start >= $${n + 2}::date
        group by 1`,
      [...params, cur, months[0]],
    );
    const monthNet = latest
      ? (await one<{ net: string; employees: number }>(
          tx,
          `select coalesce(sum(r.net), 0)::text as net, coalesce(sum(r.employee_count), 0)::int as employees from payroll_runs r
            where ${sql} and r.currency = $${n + 1} and r.status <> 'cancelled' and r.status <> 'draft'
              and r.period_start = (select max(x.period_start) from payroll_runs x where x.id = $${n + 2})`,
          [...params, cur, latest.id],
        ))!
      : null;
    const onTime = (await one<{ finalised: number; on_time: number }>(
      tx,
      `select count(*)::int as finalised, count(*) filter (where (r.finalised_at at time zone 'UTC')::date <= r.pay_date)::int as on_time
         from payroll_runs r where ${sql} and r.status = 'finalised' and r.period_start >= $${n + 1}::date`,
      [...params, monthStarts(today, 12)[0]],
    ))!;
    const net = Number(monthNet?.net ?? latest.net);
    const employees = monthNet?.employees ?? latest.employees;
    const byMonth = new Map(series.map((x) => [x.month, Number(x.net)]));
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
    const { sql, params } = await this.scope(tx, 'performance:read');
    const n = params.length;
    const cycle = await one<{ id: string; name: string; scale: RatingLevel[]; manager_due: string | null }>(
      tx,
      `select c.id, c.name, c.rating_scale as scale, c.manager_due::text as manager_due from review_cycles c where c.status <> 'draft'
        order by (c.status in ('active', 'calibration')) desc, c.launched_at desc nulls last limit 1`,
    );
    const r = cycle
      ? (await one<{ total: number; reviewed: number; in_progress: number; due: number }>(
          tx,
          `select count(*)::int as total,
                  count(*) filter (where v.manager_status = 'submitted')::int as reviewed,
                  count(*) filter (where v.manager_status = 'pending' and v.self_status = 'submitted')::int as in_progress,
                  count(*) filter (where v.manager_status = 'pending' and $${n + 2}::date is not null and $${n + 2}::date <= $${n + 3}::date + 7)::int as due
             from reviews v join employees e on e.id = v.employee_id where ${sql} and v.cycle_id = $${n + 1} and not v.excluded`,
          [...params, cycle.id, cycle.manager_due, today],
        ))!
      : { total: 0, reviewed: 0, in_progress: 0, due: 0 };
    const goals = (await one<{ active: number; avg: string | null; at_risk: number }>(
      tx,
      `select count(*)::int as active, round(avg(g.progress), 1)::text as avg, count(*) filter (where g.confidence in ('at_risk', 'off_track'))::int as at_risk
         from goals g join employees e on e.id = g.employee_id where ${sql} and g.status = 'active' and g.period_end >= $${n + 1}::date - 90`,
      [...params, today],
    ))!;
    const ratings = cycle
      ? await many<{ rating: number; count: number }>(
          tx,
          `select coalesce(v.final_rating, v.manager_rating) as rating, count(*)::int as count
             from reviews v join employees e on e.id = v.employee_id
            where ${sql} and v.cycle_id = $${n + 1} and not v.excluded and coalesce(v.final_rating, v.manager_rating) is not null group by 1`,
          [...params, cycle.id],
        )
      : [];
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
    const { sql, params } = await this.scope(tx, 'learning:read');
    const n = params.length;
    const t = (await one<{ courses: number; learners: number; total: number; completed: number; overdue: number }>(
      tx,
      `select (select count(*) from courses c where c.archived_at is null)::int as courses,
              count(distinct a.employee_id) filter (where a.status <> 'cancelled')::int as learners,
              count(*) filter (where a.status <> 'cancelled')::int as total,
              count(*) filter (where a.status = 'completed')::int as completed,
              count(*) filter (where a.status in ('assigned', 'in_progress') and a.due_on < $${n + 1}::date)::int as overdue
         from course_assignments a join employees e on e.id = a.employee_id where ${sql}`,
      [...params, today],
    ))!;
    const months = monthStarts(today, 6);
    const done = await many<{ month: string; count: number }>(
      tx,
      `select to_char(a.completed_on, 'YYYY-MM-01') as month, count(*)::int as count
         from course_assignments a join employees e on e.id = a.employee_id
        where ${sql} and a.status = 'completed' and a.completed_on >= $${n + 1}::date group by 1`,
      [...params, months[0]],
    );
    const top = await many<{ title: string; enrolled: number; completed: number }>(
      tx,
      `select c.title, count(*)::int as enrolled, count(*) filter (where a.status = 'completed')::int as completed
         from course_assignments a join employees e on e.id = a.employee_id join courses c on c.id = a.course_id
        where ${sql} and a.status <> 'cancelled' group by c.id, c.title order by enrolled desc, c.title limit 5`,
      params,
    );
    const byMonth = new Map(done.map((d) => [d.month, d.count]));
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

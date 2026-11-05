import { Controller, Get, Injectable } from '@nestjs/common';
import { zonedTime } from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Doc } from '../../platform/openapi/openapi';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { OnboardingService } from '../onboarding/onboarding.service';
import { ENTITY_SCOPE } from '../payroll/payroll-common';
import { REQ_SCOPE } from '../recruitment/recruitment-common';

const { localToday } = zonedTime;

/** Beyond the member's own record: a manager, HR or finance view rather than self-service. */
const wide = (s: Subject, permission: string) => grantsFor(s, permission).some((g) => g.scope !== 'own');

export interface Kpi { key: string; label: string; value: number | null; unit?: 'percent' | 'money'; currency?: string; hint?: string; trend?: number[]; delta?: number | null; href?: string }
export interface AttentionItem { key: string; kind: 'approval' | 'interview' | 'task' | 'probation' | 'payroll'; title: string; detail: string | null; at: string | null; href: string; approvalId?: string; overdue?: boolean }

/**
 * Home dashboard data for the signed-in member: KPIs and "Needs your attention", computed from live records and
 * limited to what the member's roles let them see (every count uses the same scope rules as the list it links to).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly approvals: ApprovalsService,
    private readonly attendance: AttendanceService,
    private readonly onboarding: OnboardingService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async build() {
    const actor = requestContext.tenantActor();
    const core = await this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const { features } = await this.entitlements.current(tx);
      const tz = (await one<{ tz: string }>(tx, 'select timezone as tz from tenants where id = app_tenant_id()'))!.tz;
      const today = localToday(tz);
      const people = wide(s, 'employees:read');
      return {
        s, features, today,
        people: people ? await this.people(tx, today) : null,
        probation: people ? await this.probation(tx, today) : [],
        hiring: features.has('recruitment') && wide(s, 'requisitions:read') ? await this.hiring(tx) : null,
        payroll: features.has('payroll') && wide(s, 'payroll:read') ? await this.payroll(tx, wide(s, 'payroll:run')) : null,
        interviews: features.has('recruitment') ? await this.interviews(tx, actor.membershipId) : [],
      };
    });
    const { s, features, today, people, hiring, payroll } = core;

    const attendance = features.has('attendance_basic') && wide(s, 'attendance:read') ? await this.attendanceToday(today) : null;
    const inbox = await this.approvals.inbox();
    const tasks = (await this.onboarding.mine()) as { id: string; title: string; employeeName: string; employeeId: string; dueOn: string | null; overdue: boolean }[];

    const kpis: Kpi[] = [];
    if (people) {
      kpis.push(
        { key: 'headcount', label: 'Total employees', value: people.headcount, trend: people.trend, delta: people.trend.length > 1 ? people.headcount - people.trend[0]! : null, hint: 'vs 6 months ago', href: '/employees' },
        { key: 'active', label: 'Active employees', value: people.active, hint: `${people.probation} on probation, ${people.notice} on notice`, href: '/employees?status=active' },
        { key: 'new-hires', label: 'New hires', value: people.newHires, hint: 'Joined in the last 30 days', href: '/employees' },
        { key: 'attrition', label: 'Attrition rate', value: people.attrition, unit: 'percent', hint: `${people.exits} left in the last 12 months`, href: '/insights/attrition' },
      );
    }
    if (hiring) {
      kpis.push(
        { key: 'open-positions', label: 'Open positions', value: hiring.openPositions, hint: `${hiring.openRequisitions} open job(s)`, href: '/recruitment' },
        { key: 'pipeline', label: 'Recruitment pipeline', value: hiring.active, hint: 'Active applications', href: '/recruitment/candidates' },
      );
    }
    if (attendance) kpis.push({ key: 'attendance', label: 'Attendance today', value: attendance.rate, unit: 'percent', hint: attendance.expected ? `${attendance.present} of ${attendance.expected} in, ${attendance.late} late` : 'Nobody expected at work today', href: '/attendance/team' });
    kpis.push({ key: 'approvals', label: 'Pending approvals', value: inbox.length, hint: 'Waiting for you', href: '/approvals' });
    if (payroll?.latest) {
      kpis.push({ key: 'payroll', label: 'Last payroll (net)', value: Number(payroll.latest.net), unit: 'money', currency: payroll.latest.currency, hint: `${payroll.latest.period}, ${payroll.latest.status.replace('_', ' ')}`, href: `/payroll/runs/${payroll.latest.id}` });
    }

    const attention: AttentionItem[] = [
      ...inbox.slice(0, 8).map((a: { id: string; label: string; summary: string; subjectName: string | null; requestedBy: string | null; createdAt: string; link: string }) => ({
        key: `approval:${a.id}`, kind: 'approval' as const, approvalId: a.id, title: `${a.label}: ${a.summary}`, detail: a.subjectName ?? a.requestedBy, at: a.createdAt, href: a.link,
      })),
      ...core.interviews.map((i) => ({ key: `interview:${i.id}`, kind: 'interview' as const, title: `Interview: ${i.title}`, detail: i.candidate, at: i.startsAt, href: `/recruitment/interviews/${i.id}` })),
      ...tasks.slice(0, 6).map((t) => ({ key: `task:${t.id}`, kind: 'task' as const, title: t.title, detail: `Onboarding for ${t.employeeName}`, at: t.dueOn, href: '/tasks', overdue: t.overdue })),
      ...core.probation.map((p) => ({ key: `probation:${p.id}`, kind: 'probation' as const, title: `Probation ends: ${p.name}`, detail: p.department, at: p.probationEnd, href: `/employees/${p.id}` })),
      ...(payroll?.awaitingAction ?? []).map((r) => ({ key: `payroll:${r.id}`, kind: 'payroll' as const, title: `Payroll ${r.period} is ${r.status === 'computed' ? 'calculated, waiting to be sent for approval' : 'a draft'}`, detail: r.entity, at: r.payDate, href: `/payroll/runs/${r.id}` })),
    ];

    return {
      generatedAt: new Date().toISOString(),
      today,
      kpis,
      attention,
      counts: { approvals: inbox.length, tasks: tasks.length, interviews: core.interviews.length },
      departments: people?.departments ?? null,
      funnel: hiring?.funnel ?? null,
      attendance,
    };
  }

  private async people(tx: Tx, today: string) {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
    const n = params.length;
    const p = [...params, today];
    const at = (d: string) => `(e.date_of_joining <= ${d} and (e.last_working_day is null or e.last_working_day >= ${d}) and e.status <> 'pre_boarding')`;
    const row = (await one<{ headcount: number; active: number; probation: number; notice: number; new_hires: number; exits: number; year_ago: number }>(
      tx,
      `select count(*) filter (where ${at(`$${n + 1}::date`)})::int as headcount,
              count(*) filter (where e.status = 'active')::int as active,
              count(*) filter (where e.status = 'probation')::int as probation,
              count(*) filter (where e.status = 'notice')::int as notice,
              count(*) filter (where e.date_of_joining between $${n + 1}::date - 30 and $${n + 1}::date)::int as new_hires,
              count(*) filter (where e.status = 'exited' and e.last_working_day between $${n + 1}::date - 365 and $${n + 1}::date)::int as exits,
              count(*) filter (where ${at(`($${n + 1}::date - 365)`)})::int as year_ago
         from employees e where ${scope}`,
      p,
    ))!;
    const months = [5, 4, 3, 2, 1, 0].map((m) => (m === 0 ? today : monthEnd(today, m)));
    const trendRow = await one<Record<string, number>>(
      tx,
      `select ${months.map((d, i) => `count(*) filter (where ${at(`'${d}'::date`)})::int as m${i}`).join(', ')} from employees e where ${scope}`,
      params,
    );
    const departments = await many<{ id: string | null; name: string; count: number }>(
      tx,
      `select d.id, coalesce(d.name, 'No department') as name, count(*)::int as count
         from employees e left join departments d on d.id = e.current_department_id
        where ${scope} and ${at(`$${n + 1}::date`)}
        group by d.id, d.name order by count desc, name limit 8`,
      p,
    );
    const avg = (row.headcount + row.year_ago) / 2;
    return {
      headcount: row.headcount, active: row.active, probation: row.probation, notice: row.notice, newHires: row.new_hires, exits: row.exits,
      attrition: avg > 0 ? Math.round((row.exits / avg) * 1000) / 10 : 0,
      trend: months.map((_, i) => trendRow?.[`m${i}`] ?? 0),
      departments,
    };
  }

  private async probation(tx: Tx, today: string) {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
    params.push(today);
    return many<{ id: string; name: string; department: string | null; probationEnd: string }>(
      tx,
      `select e.id, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, d.name as department, e.probation_end_date::text as "probationEnd"
         from employees e left join departments d on d.id = e.current_department_id
        where ${scope} and e.status = 'probation' and e.probation_end_date between $${params.length}::date and $${params.length}::date + 30
        order by e.probation_end_date limit 5`,
      params,
    );
  }

  private async hiring(tx: Tx) {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('requisitions:read', REQ_SCOPE, params, tx);
    const totals = (await one<{ open_positions: number; open_requisitions: number }>(
      tx,
      `select coalesce(sum(r.headcount) filter (where r.status = 'open'), 0)::int as open_positions, count(*) filter (where r.status = 'open')::int as open_requisitions
         from job_requisitions r where ${scope}`,
      params,
    ))!;
    const funnel = await many<{ stage: string; kind: string; count: number }>(
      tx,
      `select s.name as stage, s.kind, count(a.id)::int as count
         from recruitment_stages s
         left join applications a on a.stage_id = s.id and a.status = 'active' and a.requisition_id in (select r.id from job_requisitions r where ${scope})
        where s.archived_at is null group by s.id, s.name, s.kind, s.position order by s.position`,
      params,
    );
    return { openPositions: totals.open_positions, openRequisitions: totals.open_requisitions, active: funnel.reduce((t, f) => t + f.count, 0), funnel };
  }

  private async payroll(tx: Tx, preparer: boolean) {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('payroll:read', ENTITY_SCOPE('r.legal_entity_id'), params, tx);
    const cols = `r.id, to_char(r.period_start, 'Mon YYYY') as period, r.status, r.net::text as net, r.currency, r.pay_date::text as "payDate", le.name as entity`;
    const latest = await one<{ id: string; period: string; status: string; net: string; currency: string }>(
      tx,
      `select ${cols} from payroll_runs r join legal_entities le on le.id = r.legal_entity_id where ${scope} and r.status <> 'cancelled' order by r.period_start desc, r.created_at desc limit 1`,
      params,
    );
    const awaitingAction = !preparer ? [] : await many<{ id: string; period: string; status: string; payDate: string; entity: string }>(
      tx,
      `select ${cols} from payroll_runs r join legal_entities le on le.id = r.legal_entity_id where ${scope} and r.status in ('draft', 'computed') order by r.pay_date limit 3`,
      params,
    );
    return { latest: latest ?? null, awaitingAction };
  }

  private interviews(tx: Tx, membershipId: string) {
    return many<{ id: string; title: string; startsAt: string; candidate: string }>(
      tx,
      `select i.id, i.title, i.starts_at as "startsAt", trim(c.first_name || ' ' || c.last_name) as candidate
         from interviews i join interview_panelists p on p.interview_id = i.id and p.membership_id = $1
         join applications a on a.id = i.application_id join candidates c on c.id = a.candidate_id
        where i.status = 'scheduled' and i.starts_at between now() - interval '1 hour' and now() + interval '7 days'
        order by i.starts_at limit 5`,
      [membershipId],
    );
  }

  private async attendanceToday(today: string) {
    const r = await this.attendance.team({ date: today });
    const sum = r.summary as Record<string, number>;
    const expected = (sum.total ?? 0) - (sum.holiday ?? 0) - (sum.weekly_off ?? 0) - (sum.not_joined ?? 0) - (sum.on_leave ?? 0);
    const present = (sum.present ?? 0) + (sum.half_day ?? 0) + (sum.in_progress ?? 0) + (sum.half_day_leave ?? 0);
    if (expected <= 0) return { rate: null, present, expected: 0, late: sum.late ?? 0, onLeave: sum.on_leave ?? 0, missing: sum.missing_punch ?? 0, absent: sum.absent ?? 0 };
    return { rate: Math.round((present / expected) * 1000) / 10, present, expected, late: sum.late ?? 0, onLeave: sum.on_leave ?? 0, missing: sum.missing_punch ?? 0, absent: sum.absent ?? 0 };
  }
}

/** Last day of the month `back` months before `date` (YYYY-MM-DD). */
function monthEnd(date: string, back: number) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - back, 0));
  return d.toISOString().slice(0, 10);
}

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @Doc({ summary: 'Your Home dashboard: KPIs and items that need your attention, limited to what your roles let you see' })
  get() {
    return this.dashboard.build();
  }
}


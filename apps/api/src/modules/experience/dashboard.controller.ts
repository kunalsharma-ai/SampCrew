import { Controller, Get, Injectable } from '@nestjs/common';
import { zonedTime } from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, hasPermission, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Doc } from '../../platform/openapi/openapi';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import { OnboardingService } from '../onboarding/onboarding.service';
import { ENTITY_FIELDS } from '../payroll/payroll-common';
import { candidateName, REQ_FIELDS, visibleRequisitionIds } from '../recruitment/recruitment-common';

const { localToday } = zonedTime;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** PostgreSQL's to_char(date, 'Mon YYYY'). */
const monYear = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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
      const tz = (await tx.collection('tenants').findOne({}))!.timezone as string;
      const today = localToday(tz);
      const people = wide(s, 'employees:read');
      return {
        s, features, today,
        people: people ? await this.people(tx, today) : null,
        probation: people ? await this.probation(tx, today) : [],
        hiring: features.has('recruitment') && wide(s, 'requisitions:read') ? await this.hiring(tx) : null,
        // Payroll figures need two-step verification, as on the payroll pages.
        payroll: features.has('payroll') && wide(s, 'payroll:read') && hasPermission(s, 'payroll:read').allowed ? await this.payroll(tx, wide(s, 'payroll:run')) : null,
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

  /** Everyone in the member's employees:read scope. */
  private async visible(tx: Tx) {
    const scope = await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
    return tx.collection('employees').find(scope, {
      projection: { status: 1, date_of_joining: 1, last_working_day: 1, current_department_id: 1, probation_end_date: 1, preferred_name: 1, first_name: 1, last_name: 1 },
    });
  }

  private async people(tx: Tx, today: string) {
    const all = await this.visible(tx);
    const employedOn = (d: string) => all.filter((e) => e.status !== 'pre_boarding' && e.date_of_joining <= d && (!e.last_working_day || e.last_working_day >= d));
    const yearAgo = addDays(today, -365);
    const now = employedOn(today);
    const row = {
      headcount: now.length,
      active: all.filter((e) => e.status === 'active').length,
      probation: all.filter((e) => e.status === 'probation').length,
      notice: all.filter((e) => e.status === 'notice').length,
      new_hires: all.filter((e) => e.date_of_joining >= addDays(today, -30) && e.date_of_joining <= today).length,
      exits: all.filter((e) => e.status === 'exited' && e.last_working_day && e.last_working_day >= yearAgo && e.last_working_day <= today).length,
      year_ago: employedOn(yearAgo).length,
    };
    const months = [5, 4, 3, 2, 1, 0].map((m) => (m === 0 ? today : monthEnd(today, m)));
    const names = await fieldById(tx, 'departments', now.map((e) => e.current_department_id));
    const byDept = new Map<string, { id: string | null; name: string; count: number }>();
    for (const e of now) {
      const id = (e.current_department_id as string | null) ?? null;
      const key = id ?? '';
      const g = byDept.get(key) ?? { id, name: (id && names.get(id)) || 'No department', count: 0 };
      g.count++;
      byDept.set(key, g);
    }
    const departments = [...byDept.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 8);
    const avg = (row.headcount + row.year_ago) / 2;
    return {
      headcount: row.headcount, active: row.active, probation: row.probation, notice: row.notice, newHires: row.new_hires, exits: row.exits,
      attrition: avg > 0 ? Math.round((row.exits / avg) * 1000) / 10 : 0,
      trend: months.map((d) => employedOn(d).length),
      departments,
    };
  }

  private async probation(tx: Tx, today: string) {
    const ending = (await this.visible(tx))
      .filter((e) => e.status === 'probation' && e.probation_end_date && e.probation_end_date >= today && e.probation_end_date <= addDays(today, 30))
      .sort((a, b) => (a.probation_end_date as string).localeCompare(b.probation_end_date))
      .slice(0, 5);
    const names = await fieldById(tx, 'departments', ending.map((e) => e.current_department_id));
    return ending.map((e) => ({ id: e.id as string, name: displayName(e as never), department: names.get(e.current_department_id) ?? null, probationEnd: e.probation_end_date as string }));
  }

  private async hiring(tx: Tx) {
    const scope = await this.authz.filter('requisitions:read', REQ_FIELDS, tx);
    const open = await tx.collection('job_requisitions').find({ $and: [scope, { status: 'open' }] }, { projection: { headcount: 1 } });
    const visible = await visibleRequisitionIds(tx, scope);
    const active = await tx.collection('applications').find({ status: 'active', ...(visible ? { requisition_id: { $in: visible } } : {}) }, { projection: { stage_id: 1 } });
    const perStage = new Map<string, number>();
    for (const a of active) perStage.set(a.stage_id, (perStage.get(a.stage_id) ?? 0) + 1);
    const funnel = (await tx.collection('recruitment_stages').find({ archived_at: null }, { sort: { position: 1 } }))
      .map((st) => ({ stage: st.name as string, kind: st.kind as string, count: perStage.get(st.id) ?? 0 }));
    return {
      openPositions: open.reduce((t, x) => t + (Number(x.headcount) || 0), 0), openRequisitions: open.length,
      active: funnel.reduce((t, f) => t + f.count, 0), funnel,
    };
  }

  private async payroll(tx: Tx, preparer: boolean) {
    const scope = await this.authz.filter('payroll:read', ENTITY_FIELDS('legal_entity_id'), tx);
    const runs = await tx.collection('payroll_runs').find({ $and: [scope, { status: { $ne: 'cancelled' } }] });
    const entities = await fieldById(tx, 'legal_entities', runs.map((x) => x.legal_entity_id));
    const view = (x: Record<string, unknown>) => ({
      id: x.id as string, period: monYear(x.period_start as string), status: x.status as string, net: String(x.net), currency: x.currency as string,
      payDate: x.pay_date as string, entity: entities.get(x.legal_entity_id as string) ?? '',
    });
    const latest = [...runs].sort((a, b) => (b.period_start as string).localeCompare(a.period_start) || (b.created_at as Date).getTime() - (a.created_at as Date).getTime())[0];
    const awaitingAction = !preparer ? [] : runs.filter((x) => ['draft', 'computed'].includes(x.status)).sort((a, b) => (a.pay_date as string).localeCompare(b.pay_date)).slice(0, 3).map(view);
    return { latest: latest ? view(latest) : null, awaitingAction };
  }

  private async interviews(tx: Tx, membershipId: string) {
    const mine = await tx.collection('interview_panelists').distinct<string>('interview_id', { membership_id: membershipId });
    const list = await tx.collection('interviews').find(
      { id: { $in: mine }, status: 'scheduled', starts_at: { $gte: new Date(Date.now() - 3_600_000), $lte: new Date(Date.now() + 7 * 86_400_000) } },
      { sort: { starts_at: 1 }, limit: 5 },
    );
    const apps = new Map((await tx.collection('applications').find({ id: { $in: list.map((i) => i.application_id) } }, { projection: { candidate_id: 1 } })).map((a) => [a.id, a.candidate_id]));
    const candidates = new Map((await tx.collection('candidates').find({ id: { $in: [...apps.values()] } }, { projection: { first_name: 1, last_name: 1 } })).map((c) => [c.id, candidateName(c)]));
    return list.map((i) => ({ id: i.id as string, title: i.title as string, startsAt: i.starts_at as string, candidate: candidates.get(apps.get(i.application_id)) ?? '' }));
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


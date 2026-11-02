import { Injectable } from '@nestjs/common';
import { type BooleanFeatureKey, caseRef, draftJobDescription, type IqAnswer, type IqConversation, type IqMatch, type IqMessage, IQ_SUGGESTIONS, matchInContext } from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, type Subject } from '../../platform/authz/policy';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { AssistantService } from '../ai/assistant.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { HelpdeskService } from '../helpdesk/helpdesk.service';
import { Errors } from '../../platform/http/errors';
import { OnboardingService } from '../onboarding/onboarding.service';
import { REQ_SCOPE } from '../recruitment/recruitment-common';

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The first and last day of the period a question is about. */
function range(p: IqMatch['params']['period'], fallback: 'week' | 'quarter') {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (p ?? fallback) {
    case 'today': return { from: iso(now), to: iso(now), label: 'today' };
    case 'week': {
      const day = (now.getUTCDay() + 6) % 7;
      const from = new Date(Date.UTC(y, m, now.getUTCDate() - day));
      return { from: iso(from), to: iso(new Date(from.getTime() + 6 * 86_400_000)), label: 'this week' };
    }
    case 'month': return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))), label: 'this month' };
    case 'year': return { from: `${y}-01-01`, to: `${y}-12-31`, label: `in ${y}` };
    default: {
      const q = Math.floor(m / 3);
      return { from: iso(new Date(Date.UTC(y, q * 3, 1))), to: iso(new Date(Date.UTC(y, q * 3 + 3, 0))), label: `this quarter (Q${q + 1} ${y})` };
    }
  }
}

/** Narrows to the department named in the question (by current department), or adds nothing. */
function inDept(params: unknown[], m: IqMatch, col = 'e.current_department_id') {
  params.push(m.params.department ?? null);
  const i = params.length;
  return `($${i}::text is null or ${col} in (select id from departments where lower(name) = lower($${i}::text)))`;
}
const inName = (m: IqMatch) => (m.params.department ? ` in ${m.params.department}` : '');
const NAME = `trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name)`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (v: string | number, currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(v));

/**
 * CREW IQ answers. Every data answer is a query run as the asker, narrowed by the same permission scopes as the
 * pages it links to, so IQ never shows more than the person could open themselves. Nothing is changed by IQ.
 */
@Injectable()
export class IqService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
    private readonly approvals: ApprovalsService,
    private readonly onboarding: OnboardingService,
    private readonly ai: AiService,
    private readonly assistant: AssistantService,
    private readonly helpdesk: HelpdeskService,
  ) {}

  /**
   * Answers a question and saves it to the asker's conversation, so the panel can show it again later and a short
   * follow-up ("and last month?", "what about Sales?") continues the subject of the previous question.
   */
  async ask(question: string, conversationId?: string): Promise<IqAnswer> {
    const ctx = await this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      let previous: { question: string; match: IqMatch } | null = null;
      if (conversationId) {
        const c = await one<{ id: string }>(tx, `select id from iq_conversations where id = $1 and membership_id = $2`, [conversationId, s.membershipId]);
        if (!c) throw Errors.notFound('Conversation');
        previous = (await one<{ question: string; match: IqMatch }>(tx, `select question, match from iq_messages where conversation_id = $1 order by created_at desc, id desc limit 1`, [conversationId])) ?? null;
      }
      const departments = (await many<{ name: string }>(tx, `select name from departments where archived_at is null`)).map((d) => d.name);
      return { previous, departments, membershipId: s.membershipId };
    });
    const m = matchInContext(question, ctx.previous?.match ?? null, ctx.departments);
    const answer = await this.answer(question, m);
    if (m.followUp && ctx.previous) answer.how = `Read as a follow-up to “${ctx.previous.question}”. ${answer.how}`;
    return this.db.tenant(async (tx) => {
      let id = conversationId;
      if (!id) {
        id = (await one<{ id: string }>(
          tx, `insert into iq_conversations (tenant_id, membership_id, title) values (app_tenant_id(), $1, $2) returning id`, [ctx.membershipId, question.slice(0, 120)],
        ))!.id;
      } else {
        await tx.query(`update iq_conversations set updated_at = now() where id = $1`, [id]);
      }
      const msg = await one<{ id: string }>(
        tx,
        `insert into iq_messages (tenant_id, conversation_id, membership_id, question, intent, match, answer) values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [id, ctx.membershipId, question, answer.intent, JSON.stringify(m), JSON.stringify(answer)],
      );
      return { ...answer, conversationId: id, messageId: msg!.id };
    });
  }

  /** The asker's own conversations, newest first. Nobody else's are ever listed. */
  async conversations(): Promise<IqConversation[]> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      return many<IqConversation>(
        tx,
        `select c.id, c.title, c.updated_at as "updatedAt", (select count(*)::int from iq_messages m where m.conversation_id = c.id) as questions
           from iq_conversations c where c.membership_id = $1 order by c.updated_at desc limit 30`,
        [s.membershipId],
      );
    });
  }

  async conversation(id: string): Promise<{ id: string; title: string; messages: IqMessage[] }> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const c = await one<{ id: string; title: string }>(tx, `select id, title from iq_conversations where id = $1 and membership_id = $2`, [id, s.membershipId]);
      if (!c) throw Errors.notFound('Conversation');
      const messages = await many<IqMessage>(tx, `select id, question, answer, created_at as "createdAt" from iq_messages where conversation_id = $1 order by created_at, id`, [id]);
      return { ...c, messages: messages.map((x) => ({ ...x, answer: { ...x.answer, conversationId: id, messageId: x.id } })) };
    });
  }

  async forget(id: string | null) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const r = id
        ? await tx.query(`delete from iq_conversations where id = $1 and membership_id = $2`, [id, s.membershipId])
        : await tx.query(`delete from iq_conversations where membership_id = $1`, [s.membershipId]);
      if (id && !r.rowCount) throw Errors.notFound('Conversation');
      return { deleted: r.rowCount ?? 0 };
    });
  }

  private async answer(question: string, m: IqMatch): Promise<IqAnswer> {
    const how = (what: string) => (m.matched.length ? `Matched “${m.matched.join('”, “')}” to ${what}. ` : '');
    switch (m.intent) {
      case 'approvals': return this.approvalsAnswer(how('your approvals'));
      case 'onboarding_tasks': return this.onboardingAnswer(how('onboarding tasks'));
      case 'onboarding_checklist': return this.gated('core_hr', 'employees:update', 'onboarding checklists', () => this.checklistAnswer(how('onboarding checklists')));
      case 'on_leave': return this.gated('leave', 'leave:read', 'leave', (tx) => this.onLeaveAnswer(tx, m, how('people on leave')));
      case 'leave_trend': return this.gated('leave', 'leave:read', 'leave', (tx, s) => this.leaveTrendAnswer(tx, s, how('the leave trend')));
      case 'headcount': return this.gated('core_hr', 'employees:read', 'employee records', (tx) => this.headcountAnswer(tx, m, how('headcount')));
      case 'overtime': return this.gated('attendance_basic', 'attendance:read', 'attendance', (tx) => this.overtimeAnswer(tx, m, how('overtime by department')));
      case 'payroll_summary': return this.gated('payroll', 'payroll:read', 'payroll', (tx) => this.payrollAnswer(tx, how('payroll runs')));
      case 'expenses_pending': return this.gated('expenses', 'expenses:approve', 'expense approvals', (tx) => this.expensesAnswer(tx, m, how('expense claims')));
      case 'attrition': return this.gated('core_hr', 'employees:read', 'employee records', (tx) => this.attritionAnswer(tx, m, how('leavers and attrition')));
      case 'probation': return this.gated('core_hr', 'employees:read', 'employee records', (tx) => this.probationAnswer(tx, m, how('probation endings')));
      case 'anniversaries': return this.gated('core_hr', 'employees:read', 'employee records', (tx) => this.anniversaryAnswer(tx, m, how('work anniversaries')));
      case 'attendance_today': return this.gated('attendance_basic', 'attendance:read', 'attendance', (tx) => this.attendanceTodayAnswer(tx, m, how('today’s attendance')));
      case 'goals': return this.gated('talent', 'performance:read', 'goals', (tx) => this.goalsAnswer(tx, m, how('goals')));
      case 'learning': return this.gated('talent', 'learning:read', 'learning', (tx) => this.learningAnswer(tx, m, how('training')));
      case 'cases': return this.gated('self_service', 'helpdesk:use', 'the helpdesk', (_tx, s) => this.casesAnswer(s, how('helpdesk cases')));
      case 'recruitment_summary': return this.gated('recruitment', 'requisitions:read', 'recruitment', (tx, s) => this.recruitmentAnswer(tx, s, m, how('the recruitment summary')));
      case 'draft_bid': return this.gated('recruitment', 'bids:manage', 'staffing bids', () => this.bidAction(m, how('a new staffing bid')));
      case 'draft_job': return this.gated('recruitment', 'requisitions:create', 'requisitions', (tx) => this.jobAction(tx, m, how('a new requisition')));
      case 'policy': return this.policyAnswer(question);
      default: return {
        intent: 'unknown', title: 'I am not sure what you need', confidence: 'low', sources: [],
        summary: 'IQ answers questions about approvals, onboarding, leave, headcount, attendance, overtime, payroll, expenses, leavers, probation, goals, training, helpdesk cases and recruitment, opens prefilled bids and requisitions, and finds help articles. Follow-ups such as "and last month?" or "what about Sales?" continue the last question. Try one of these.',
        how: 'No rule matched the question, so nothing was looked up.', suggestions: IQ_SUGGESTIONS.slice(0, 6),
      };
    }
  }

  /** Runs an answer only when the plan has the module and the person holds the permission at some scope. */
  private async gated(feature: BooleanFeatureKey, permission: string, area: string, fn: (tx: Tx, s: Subject) => Promise<IqAnswer>): Promise<IqAnswer> {
    return this.db.tenant(async (tx) => {
      const e = await this.entitlements.current(tx);
      if (!e.features.has(feature)) return this.refusal(`Your workspace's plan does not include ${area}.`);
      const s = await this.authz.subject(tx);
      if (!grantsFor(s, permission).length) return this.refusal(`Your role does not give you access to ${area}, so IQ cannot look this up for you.`);
      return fn(tx, s);
    });
  }

  private refusal(why: string): IqAnswer {
    return { intent: 'unknown', title: 'Not available to you', summary: why, confidence: 'exact', how: 'IQ only reads what you could open yourself.', sources: [] };
  }

  private async approvalsAnswer(how: string): Promise<IqAnswer> {
    const inbox = (await this.approvals.inbox()) as { id: string; label: string; summary: string; createdAt: string; link: string; requestedBy: string | null }[];
    return {
      intent: 'approvals', confidence: 'exact', title: inbox.length ? `${inbox.length} waiting for your approval` : 'Nothing is waiting for your approval',
      summary: inbox.length ? `The oldest has waited since ${fmtDate(new Date(inbox.at(-1)!.createdAt).toISOString())}.` : 'Your approvals inbox is clear.',
      how: `${how}Read from your approvals inbox: requests where you are the current approver.`,
      items: inbox.slice(0, 10).map((i) => ({ label: `${i.label}: ${i.summary}`, detail: `${i.requestedBy ? `from ${i.requestedBy}, ` : ''}${fmtDate(new Date(i.createdAt).toISOString())}`, href: i.link })),
      sources: [{ label: 'Approvals', href: '/approvals' }],
    };
  }

  private async onboardingAnswer(how: string): Promise<IqAnswer> {
    const tasks = (await this.onboarding.mine()) as { title: string; employeeName: string; employeeId: string; dueOn: string | null; overdue: boolean }[];
    const overdue = tasks.filter((t) => t.overdue).length;
    return {
      intent: 'onboarding_tasks', confidence: 'exact', title: tasks.length ? `${tasks.length} onboarding task${tasks.length === 1 ? '' : 's'} for you` : 'No onboarding tasks for you',
      summary: tasks.length ? `${overdue ? `${overdue} overdue. ` : ''}Soonest due first.` : 'Nothing is assigned to you right now.',
      how: `${how}Read from open onboarding tasks assigned to you (and the IT queue if you look after it).`,
      table: tasks.length ? { columns: ['Task', 'For', 'Due'], rows: tasks.slice(0, 15).map((t) => [t.title, t.employeeName, t.dueOn ? `${fmtDate(String(t.dueOn))}${t.overdue ? ' (overdue)' : ''}` : 'No date']) } : undefined,
      sources: [{ label: 'My tasks', href: '/tasks' }],
    };
  }

  private async checklistAnswer(how: string): Promise<IqAnswer> {
    return {
      intent: 'onboarding_checklist', confidence: 'exact', title: 'Onboarding checklists',
      summary: 'New hires get their checklist from an onboarding template: tasks for HR, IT, the manager and the new person, each with a due day. Open the templates to add or change one; IQ does not change them itself.',
      how: `${how}Checklists live in onboarding templates.`,
      sources: [{ label: 'Onboarding templates', href: '/settings/onboarding' }],
      action: { label: 'Open onboarding templates', href: '/settings/onboarding', preview: [], note: 'Nothing changes until you save a template.' },
    };
  }

  private async onLeaveAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const r = range(m.params.period, 'week');
    const params: unknown[] = [r.from, r.to];
    const scope = `${await this.authz.predicate('leave:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ name: string; employeeId: string; type: string; startDate: string; endDate: string; days: string }>(
      tx,
      `select trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, e.id as "employeeId", t.name as type,
              to_char(l.start_date, 'YYYY-MM-DD') as "startDate", to_char(l.end_date, 'YYYY-MM-DD') as "endDate", l.days::text
         from leave_requests l join employees e on e.id = l.employee_id join leave_types t on t.id = l.leave_type_id
        where l.status = 'approved' and l.start_date <= $2 and l.end_date >= $1 and ${scope}
        order by l.start_date, name limit 100`,
      params,
    );
    return {
      intent: 'on_leave', confidence: 'exact', title: rows.length ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}${inName(m)} on leave ${r.label}` : `Nobody you can see${inName(m)} is on leave ${r.label}`,
      summary: `Approved leave overlapping ${fmtDate(r.from)} to ${fmtDate(r.to)}, for the people your leave access covers.`,
      how: `${how}Read from approved leave requests; pending requests are not counted.`,
      table: rows.length ? { columns: ['Person', 'Leave', 'From', 'To', 'Days'], rows: rows.map((x) => [x.name, x.type, fmtDate(x.startDate), fmtDate(x.endDate), Number(x.days)]) } : undefined,
      sources: [{ label: 'Leave', href: '/leave' }],
    };
  }

  private async leaveTrendAnswer(tx: Tx, _s: Subject, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('leave:read', EMPLOYEE_SCOPE, params, tx);
    const rows = await many<{ month: string; days: string; requests: number }>(
      tx,
      `select to_char(date_trunc('month', l.start_date), 'YYYY-MM') as month, sum(l.days)::text as days, count(*)::int as requests
         from leave_requests l join employees e on e.id = l.employee_id
        where l.status = 'approved' and l.start_date >= date_trunc('month', current_date) - interval '5 months' and l.start_date < date_trunc('month', current_date) + interval '1 month' and ${scope}
        group by 1 order by 1`,
      params,
    );
    const months: string[] = [];
    const now = new Date();
    for (let k = 5; k >= 0; k--) months.push(iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1))).slice(0, 7));
    const series = months.map((mo) => ({ mo, days: Number(rows.find((r) => r.month === mo)?.days ?? 0), requests: rows.find((r) => r.month === mo)?.requests ?? 0 }));
    const first = series.slice(0, 3).reduce((t, x) => t + x.days, 0);
    const last = series.slice(3).reduce((t, x) => t + x.days, 0);
    const label = (mo: string) => new Date(`${mo}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const change = first === 0 ? (last === 0 ? 'no leave taken in either half' : 'up from none') : `${last >= first ? 'up' : 'down'} ${Math.abs(Math.round(((last - first) / first) * 100))}%`;
    return {
      intent: 'leave_trend', confidence: 'exact', title: 'Leave over the last six months',
      summary: `${last} days in the last three months against ${first} in the three before: ${change}.`,
      how: `${how}Approved leave days by the month they start, for the people your leave access covers.`,
      table: { columns: ['Month', 'Days', 'Requests'], rows: series.map((x) => [label(x.mo), x.days, x.requests]) },
      sources: [{ label: 'Leave', href: '/leave' }],
    };
  }

  private async headcountAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = `${await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ department: string; people: number; joined: number }>(
      tx,
      `select coalesce(d.name, 'No department') as department, count(*)::int as people,
              count(*) filter (where e.date_of_joining > current_date - 90)::int as joined
         from employees e left join departments d on d.id = e.current_department_id
        where e.status in ('probation', 'active', 'notice') and ${scope}
        group by 1 order by 2 desc, 1`,
      params,
    );
    const total = rows.reduce((t, r) => t + r.people, 0);
    return {
      intent: 'headcount', confidence: 'exact', title: m.params.department ? `${total} ${total === 1 ? 'person' : 'people'} in ${m.params.department}` : `${total} ${total === 1 ? 'person' : 'people'} across ${rows.length} department${rows.length === 1 ? '' : 's'}`,
      summary: 'People who are employed today (on probation, active or serving notice), among those you can see.',
      how: `${how}Counted from employee records, by current department.`,
      table: { columns: ['Department', 'People', 'Joined in 90 days'], rows: rows.map((r) => [r.department, r.people, r.joined]) },
      sources: [{ label: 'Employees', href: '/employees' }, { label: 'Workforce Universe', href: '/insights/universe' }],
    };
  }

  private async overtimeAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = `${await this.authz.predicate('attendance:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ department: string; recent: number; before: number }>(
      tx,
      `select coalesce(d.name, 'No department') as department,
              coalesce(sum(a.overtime_minutes) filter (where a.work_date > current_date - 30), 0)::int as recent,
              coalesce(sum(a.overtime_minutes) filter (where a.work_date <= current_date - 30), 0)::int as before
         from attendance_days a join employees e on e.id = a.employee_id left join departments d on d.id = e.current_department_id
        where a.work_date > current_date - 60 and a.work_date <= current_date and ${scope}
        group by 1 having sum(a.overtime_minutes) > 0 order by (coalesce(sum(a.overtime_minutes) filter (where a.work_date > current_date - 30), 0) - coalesce(sum(a.overtime_minutes) filter (where a.work_date <= current_date - 30), 0)) desc`,
      params,
    );
    const h = (min: number) => `${(min / 60).toFixed(1)} h`;
    const rising = rows.filter((r) => r.recent > r.before);
    return {
      intent: 'overtime', confidence: 'exact',
      title: rising.length ? `${rising.length} department${rising.length === 1 ? '' : 's'} with rising overtime` : rows.length ? 'No department has rising overtime' : 'No overtime recorded in the last 60 days',
      summary: rising.length ? `Biggest rise: ${rising[0]!.department}, ${h(rising[0]!.before)} to ${h(rising[0]!.recent)}.` : 'Compared the last 30 days with the 30 before.',
      how: `${how}Overtime minutes from daily attendance, last 30 days against the 30 before, for the people your attendance access covers.`,
      table: rows.length ? { columns: ['Department', 'Previous 30 days', 'Last 30 days', 'Change'], rows: rows.map((r) => [r.department, h(r.before), h(r.recent), r.recent > r.before ? `up ${h(r.recent - r.before)}` : r.recent < r.before ? `down ${h(r.before - r.recent)}` : 'same']) } : undefined,
      sources: [{ label: 'Team attendance', href: '/attendance/team' }],
    };
  }

  private async recruitmentAnswer(tx: Tx, _s: Subject, m: IqMatch, how: string): Promise<IqAnswer> {
    const r = range(m.params.period, 'quarter');
    const params: unknown[] = [r.from, r.to];
    const scope = await this.authz.predicate('requisitions:read', REQ_SCOPE, params, tx);
    const f = (await one<Record<string, number>>(
      tx,
      `select count(*) filter (where a.applied_at::date between $1 and $2)::int as applied,
              count(*) filter (where a.status = 'active')::int as "inProcess",
              count(*) filter (where a.status = 'hired' and a.decided_at::date between $1 and $2)::int as hired,
              count(*) filter (where a.status = 'rejected' and a.decided_at::date between $1 and $2)::int as rejected,
              count(distinct r.id) filter (where r.status = 'open')::int as "openJobs"
         from job_requisitions r left join applications a on a.requisition_id = r.id where ${scope}`,
      params,
    ))!;
    // The stage counts are "now", so they take no dates: their own parameter list.
    const stageParams: unknown[] = [];
    const stageScope = await this.authz.predicate('requisitions:read', REQ_SCOPE, stageParams, tx);
    const stages = await many<{ stage: string; n: number }>(
      tx,
      `select s.name as stage, count(*)::int as n from applications a join recruitment_stages s on s.id = a.stage_id join job_requisitions r on r.id = a.requisition_id
        where a.status = 'active' and ${stageScope} group by s.name, s.position order by s.position`,
      stageParams,
    );
    const sources = await many<{ source: string; n: number }>(
      tx,
      `select c.source, count(*)::int as n from applications a join candidates c on c.id = a.candidate_id join job_requisitions r on r.id = a.requisition_id
        where a.applied_at::date between $1 and $2 and ${scope} group by 1 order by 2 desc limit 5`,
      params,
    );
    return {
      intent: 'recruitment_summary', confidence: 'exact', title: `Recruitment ${r.label}`,
      summary: `${f.applied} applied, ${f.hired} hired and ${f.rejected} rejected ${r.label}. ${f.inProcess} candidates are in process across ${f.openJobs} open job${f.openJobs === 1 ? '' : 's'}.${sources[0] ? ` Most came from ${sources[0].source.replace(/_/g, ' ')}.` : ''}`,
      how: `${how}Counted from applications on the jobs you can see, ${fmtDate(r.from)} to ${fmtDate(r.to)}.`,
      table: stages.length ? { columns: ['Stage now', 'Candidates'], rows: stages.map((x) => [x.stage, x.n]) } : undefined,
      sources: [{ label: 'Recruitment', href: '/recruitment' }],
    };
  }

  private async bidAction(m: IqMatch, how: string): Promise<IqAnswer> {
    const count = m.params.count ?? 1;
    const role = m.params.role ?? '';
    const q = new URLSearchParams({ mode: 'quick', people: String(count), ...(role ? { role } : {}) });
    return {
      intent: 'draft_bid', confidence: m.params.role ? 'exact' : 'low', title: 'A Quick Bid, ready for you to finish',
      summary: m.params.role ? `I filled in ${count} × ${role}. Choose the client and monthly pay; the price works itself out from your default template.` : 'I could not tell the role or how many people; the Quick Bid opens blank.',
      how: `${how}${m.params.role ? `Read “${count}” and “${role}” from your question.` : ''}`,
      sources: [{ label: 'Staffing bids', href: '/staffing/bids' }],
      action: {
        label: 'Open the Quick Bid', href: `/staffing/bids/new?${q}`,
        preview: [{ label: 'Role', value: role || 'Not set' }, { label: 'People', value: String(count) }, { label: 'Pricing', value: 'From your default proposal template' }],
        note: 'Nothing is saved until you save the bid, and Finance approves it before it can go to a client.',
      },
    };
  }

  private async jobAction(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const jobTitle = m.params.title ?? '';
    const org = (await one<{ name: string }>(tx, 'select name from tenants where id = app_tenant_id()'))!.name.replace(/\s*\(Demo\)$/, '');
    const q = new URLSearchParams({ create: 'requisition', ...(jobTitle ? { title: jobTitle, description: draftJobDescription(jobTitle, org) } : {}) });
    return {
      intent: 'draft_job', confidence: jobTitle ? 'exact' : 'low', title: jobTitle ? `A draft requisition for ${jobTitle}` : 'A new requisition',
      summary: jobTitle ? 'I started the job description from the standard outline. The parts in [brackets] are yours to write; it is a template, not written by AI.' : 'I could not tell the job title; the requisition opens blank.',
      how: `${how}${jobTitle ? `Read the title “${jobTitle}” from your question.` : ''}`,
      sources: [{ label: 'Recruitment', href: '/recruitment' }],
      action: {
        label: 'Open the requisition form', href: `/recruitment?${q}`,
        preview: [{ label: 'Job title', value: jobTitle || 'Not set' }, { label: 'Description', value: jobTitle ? 'Standard outline with About the role, What you will do, What you bring, What we offer' : 'Empty' }],
        note: 'It is saved as a draft only when you save it, and HR approves it before the job opens.',
      },
    };
  }

  /** Policy questions: the AI assistant grounded in help articles when it is on; otherwise the best matching articles. */
  private async payrollAnswer(tx: Tx, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('payroll:read', { membershipId: 'null::uuid', legalEntityId: 'r.legal_entity_id', departmentId: 'null::uuid', locationId: 'null::uuid' }, params, tx);
    const runs = await many<{ id: string; periodStart: string; periodEnd: string; status: string; employees: number; gross: string; net: string; employer: string; currency: string; entity: string }>(
      tx,
      `select r.id, to_char(r.period_start, 'YYYY-MM-DD') as "periodStart", to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd", r.status, r.employee_count as employees,
              r.gross::text, r.net::text, r.employer_contributions::text as employer, r.currency, le.name as entity
         from payroll_runs r join legal_entities le on le.id = r.legal_entity_id
        where r.status <> 'cancelled' and ${scope} order by r.period_end desc, le.name limit 6`,
      params,
    );
    if (!runs.length) return { intent: 'payroll_summary', confidence: 'exact', title: 'No payroll runs yet', summary: 'There are no payroll runs you can see.', how: `${how}Read from payroll runs.`, sources: [{ label: 'Payroll', href: '/payroll' }] };
    const last = runs[0]!;
    const cost = Number(last.gross) + Number(last.employer);
    const prev = runs.find((r) => r.periodEnd < last.periodEnd);
    const change = prev ? Math.round(((Number(last.net) - Number(prev.net)) / Math.max(1, Number(prev.net))) * 100) : null;
    const status: Record<string, string> = { draft: 'Draft', computed: 'Computed', pending_approval: 'Awaiting approval', finalised: 'Finalised' };
    return {
      intent: 'payroll_summary', confidence: 'exact',
      title: `${fmtDate(last.periodStart)} to ${fmtDate(last.periodEnd)}: ${money(last.net, last.currency)} net`,
      summary: `${plural(last.employees, 'person', 'people')} paid by ${last.entity}, ${status[last.status] ?? last.status}. Cost to the company ${money(cost, last.currency)} (gross plus employer contributions).${change != null ? ` Net pay is ${change >= 0 ? 'up' : 'down'} ${Math.abs(change)}% on the run before.` : ''}`,
      how: `${how}Read from payroll run totals for the legal entities your payroll access covers.`,
      table: { columns: ['Period', 'Entity', 'Status', 'People', 'Net pay'], rows: runs.map((r) => [`${fmtDate(r.periodStart)} to ${fmtDate(r.periodEnd)}`, r.entity, status[r.status] ?? r.status, r.employees, money(r.net, r.currency)]) },
      sources: [{ label: 'Payroll run', href: `/payroll/runs/${last.id}` }, { label: 'Payroll', href: '/payroll' }],
    };
  }

  private async expensesAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = `${await this.authz.predicate('expenses:approve', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ name: string; category: string; spentOn: string; amount: string; currency: string; days: number }>(
      tx,
      `select ${NAME} as name, k.name as category, to_char(x.spent_on, 'YYYY-MM-DD') as "spentOn", x.amount::text, x.currency, (current_date - x.created_at::date)::int as days
         from expense_claims x join employees e on e.id = x.employee_id join expense_categories k on k.id = x.category_id
        where x.status = 'pending' and ${scope} order by x.created_at limit 50`,
      params,
    );
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.currency, (totals.get(r.currency) ?? 0) + Number(r.amount));
    return {
      intent: 'expenses_pending', confidence: 'exact',
      title: rows.length ? `${plural(rows.length, 'expense claim')} waiting${inName(m)}` : `No expense claims waiting${inName(m)}`,
      summary: rows.length ? `${[...totals].map(([c, v]) => money(v, c)).join(' and ')} in total; the oldest has waited ${plural(rows[0]!.days, 'day')}.` : 'Nothing pending among the people your expense approval covers.',
      how: `${how}Pending claims for the people your expense approval access covers, oldest first.`,
      table: rows.length ? { columns: ['Person', 'Category', 'Spent on', 'Amount', 'Waiting'], rows: rows.map((r) => [r.name, r.category, fmtDate(r.spentOn), money(r.amount, r.currency), plural(r.days, 'day')]) } : undefined,
      sources: [{ label: 'Approvals', href: '/approvals' }, { label: 'Expenses', href: '/expenses' }],
    };
  }

  private async attritionAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const r = range(m.params.period ?? 'year', 'quarter');
    const params: unknown[] = [r.from, r.to];
    const scope = `${await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const left = await many<{ name: string; id: string; department: string | null; lastDay: string; reason: string | null; tenure: number }>(
      tx,
      `select ${NAME} as name, e.id, d.name as department, to_char(e.last_working_day, 'YYYY-MM-DD') as "lastDay", e.exit_reason as reason,
              round((e.last_working_day - e.date_of_joining) / 365.25, 1)::float8 as tenure
         from employees e left join departments d on d.id = e.current_department_id
        where e.status = 'exited' and e.last_working_day between $1 and $2 and ${scope} order by e.last_working_day desc limit 50`,
      params,
    );
    const avg = (await one<{ n: number }>(
      tx,
      `select (count(*) filter (where e.date_of_joining <= $1 and (e.last_working_day is null or e.last_working_day >= $1)) +
               count(*) filter (where e.date_of_joining <= $2 and e.status <> 'pre_boarding' and (e.last_working_day is null or e.last_working_day >= $2)))::float8 / 2 as n
         from employees e where ${scope}`,
      params,
    ))!.n;
    const rate = avg ? Math.round((left.length / avg) * 1000) / 10 : 0;
    return {
      intent: 'attrition', confidence: 'exact',
      title: left.length ? `${plural(left.length, 'person', 'people')} left${inName(m)} ${r.label}` : `Nobody you can see left${inName(m)} ${r.label}`,
      summary: `Attrition ${rate}% of average headcount (${Math.round(avg)}) from ${fmtDate(r.from)} to ${fmtDate(r.to)}.${left.length ? ` Average time with us: ${(left.reduce((t, x) => t + x.tenure, 0) / left.length).toFixed(1)} years.` : ''}`,
      how: `${how}Counted from employees whose last working day falls in the period, against the average of the headcount at its start and end.`,
      table: left.length ? { columns: ['Person', 'Department', 'Last day', 'Years', 'Reason'], rows: left.map((x) => [x.name, x.department ?? 'No department', fmtDate(x.lastDay), x.tenure, x.reason ?? 'Not given']) } : undefined,
      sources: [{ label: 'Employees who left', href: '/employees?status=exited' }, { label: 'Workforce Universe', href: '/insights/universe' }],
    };
  }

  private async probationAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const r = range(m.params.period ?? 'month', 'quarter');
    const params: unknown[] = [r.to];
    const scope = `${await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ id: string; name: string; department: string | null; ends: string; overdue: boolean }>(
      tx,
      `select e.id, ${NAME} as name, d.name as department, to_char(e.probation_end_date, 'YYYY-MM-DD') as ends, e.probation_end_date < current_date as overdue
         from employees e left join departments d on d.id = e.current_department_id
        where e.status = 'probation' and e.probation_end_date <= $1 and ${scope} order by e.probation_end_date limit 50`,
      params,
    );
    const overdue = rows.filter((x) => x.overdue).length;
    return {
      intent: 'probation', confidence: 'exact',
      title: rows.length ? `${plural(rows.length, 'probation')} ending by ${fmtDate(r.to)}${inName(m)}` : `No probation ends by ${fmtDate(r.to)}${inName(m)}`,
      summary: rows.length ? `${overdue ? `${overdue} already past the end date and still on probation. ` : ''}Confirm or extend each from the person's profile.` : 'Nobody you can see is due for confirmation.',
      how: `${how}People still on probation whose end date is on or before ${fmtDate(r.to)}.`,
      items: rows.map((x) => ({ label: x.name, detail: `${x.department ?? 'No department'} · ${x.overdue ? 'ended' : 'ends'} ${fmtDate(x.ends)}`, href: `/employees/${x.id}` })),
      sources: [{ label: 'Employees on probation', href: '/employees?status=probation' }],
    };
  }

  private async anniversaryAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const r = range(m.params.period ?? 'month', 'quarter');
    const params: unknown[] = [r.from, r.to];
    const scope = `${await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ id: string; name: string; on: string; years: number }>(
      tx,
      `with a as (
         select e.id, ${NAME} as name, y.day, extract(year from age(y.day, e.date_of_joining))::int as years
           from employees e
           cross join lateral (select (e.date_of_joining + make_interval(years => g))::date as day from generate_series(1, 60) g) y
          where e.status in ('probation', 'active', 'notice') and ${scope} and y.day between $1 and $2)
       select id, name, to_char(day, 'YYYY-MM-DD') as "on", years from a order by a.day, name limit 50`,
      params,
    );
    return {
      intent: 'anniversaries', confidence: 'exact',
      title: rows.length ? `${plural(rows.length, 'work anniversary', 'work anniversaries')} ${r.label}${inName(m)}` : `No work anniversaries ${r.label}${inName(m)}`,
      summary: rows.length ? `The longest: ${rows.reduce((a, b) => (b.years > a.years ? b : a)).name}, ${plural(rows.reduce((a, b) => (b.years > a.years ? b : a)).years, 'year')}. Say thanks with a recognition.` : 'Nobody you can see reaches a joining anniversary in this period.',
      how: `${how}Joining dates of people employed today, from ${fmtDate(r.from)} to ${fmtDate(r.to)}.`,
      items: rows.map((x) => ({ label: x.name, detail: `${plural(x.years, 'year')} on ${fmtDate(x.on)}`, href: `/employees/${x.id}` })),
      sources: [{ label: 'Recognition', href: '/recognition' }],
    };
  }

  private async attendanceTodayAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = `${await this.authz.predicate('attendance:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ name: string; department: string | null; status: string; late: number }>(
      tx,
      `select ${NAME} as name, d.name as department, a.status, a.late_minutes as late
         from attendance_days a join employees e on e.id = a.employee_id left join departments d on d.id = e.current_department_id
        where a.work_date = current_date and (a.status in ('absent', 'missing_punch') or a.late_minutes > 0) and ${scope}
        order by a.status, name limit 100`,
      params,
    );
    const absent = rows.filter((x) => x.status === 'absent').length;
    const missing = rows.filter((x) => x.status === 'missing_punch').length;
    const late = rows.filter((x) => x.late > 0).length;
    const label: Record<string, string> = { absent: 'Absent', missing_punch: 'Missing punch', present: 'Present', half_day: 'Half day' };
    return {
      intent: 'attendance_today', confidence: 'exact',
      title: rows.length ? `${absent} absent, ${late} late, ${missing} missing a punch today${inName(m)}` : `Nobody absent or late so far today${inName(m)}`,
      summary: 'From today’s attendance as worked out so far; people on approved leave are not counted as absent.',
      how: `${how}Read from today's attendance for the people your attendance access covers.`,
      table: rows.length ? { columns: ['Person', 'Department', 'Status', 'Late by'], rows: rows.map((x) => [x.name, x.department ?? 'No department', label[x.status] ?? x.status, x.late ? `${x.late} min` : '']) } : undefined,
      sources: [{ label: 'Team attendance', href: '/attendance/team' }],
    };
  }

  private async goalsAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = `${await this.authz.predicate('performance:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ title: string; name: string; id: string; progress: string; confidence: string | null; ends: string }>(
      tx,
      `select g.title, ${NAME} as name, e.id, g.progress::text, g.confidence, to_char(g.period_end, 'YYYY-MM-DD') as ends
         from goals g join employees e on e.id = g.employee_id
        where g.status = 'active' and ${scope} order by (g.confidence = 'off_track') desc, (g.confidence = 'at_risk') desc, g.period_end limit 200`,
      params,
    );
    const risky = rows.filter((g) => g.confidence === 'at_risk' || g.confidence === 'off_track');
    const avg = rows.length ? Math.round(rows.reduce((t, g) => t + Number(g.progress), 0) / rows.length) : 0;
    const conf: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };
    return {
      intent: 'goals', confidence: 'exact',
      title: rows.length ? `${plural(risky.length, 'goal')} at risk or off track of ${rows.length} active${inName(m)}` : `No active goals${inName(m)}`,
      summary: rows.length ? `Average progress ${avg}%. At risk and off track come first.` : 'Nobody you can see has an active goal.',
      how: `${how}Active goals with the latest check-in confidence, for the people your performance access covers.`,
      table: rows.length ? { columns: ['Goal', 'Owner', 'Progress', 'Confidence', 'Due'], rows: (risky.length ? risky : rows).slice(0, 15).map((g) => [g.title, g.name, `${Math.round(Number(g.progress))}%`, g.confidence ? conf[g.confidence]! : 'No check-in', fmtDate(g.ends)]) } : undefined,
      sources: [{ label: 'Goals', href: '/goals' }],
    };
  }

  private async learningAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = `${await this.authz.predicate('learning:read', EMPLOYEE_SCOPE, params, tx)} and ${inDept(params, m)}`;
    const rows = await many<{ name: string; course: string; due: string | null; overdue: boolean; status: string }>(
      tx,
      `select ${NAME} as name, c.title as course, to_char(a.due_on, 'YYYY-MM-DD') as due, coalesce(a.due_on < current_date, false) as overdue, a.status
         from course_assignments a join employees e on e.id = a.employee_id join courses c on c.id = a.course_id
        where a.status in ('assigned', 'in_progress') and ${scope} order by a.due_on nulls last limit 100`,
      params,
    );
    const overdue = rows.filter((x) => x.overdue);
    return {
      intent: 'learning', confidence: 'exact',
      title: rows.length ? `${plural(overdue.length, 'course')} overdue of ${rows.length} open${inName(m)}` : `No open training${inName(m)}`,
      summary: rows.length ? 'Overdue first, then by due date.' : 'Nobody you can see has open course assignments.',
      how: `${how}Open course assignments for the people your learning access covers.`,
      table: rows.length ? { columns: ['Person', 'Course', 'Due', 'Status'], rows: rows.slice(0, 20).map((x) => [x.name, x.course, x.due ? `${fmtDate(x.due)}${x.overdue ? ' (overdue)' : ''}` : 'No date', x.status === 'in_progress' ? 'In progress' : 'Not started']) } : undefined,
      sources: [{ label: 'Learning', href: '/learning' }],
    };
  }

  private async casesAnswer(s: Subject, how: string): Promise<IqAnswer> {
    const manage = grantsFor(s, 'helpdesk:manage').length > 0;
    type Case = { id: string; number: number; subject: string; status: string; priority: string; employeeName: string };
    const cases = (await this.helpdesk.list({ view: manage ? 'queue' : 'mine', status: 'active' })) as unknown as Case[];
    const st: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting_on_employee: 'Waiting on employee', resolved: 'Resolved' };
    const urgent = cases.filter((c) => c.priority === 'urgent' || c.priority === 'high').length;
    return {
      intent: 'cases', confidence: 'exact',
      title: manage ? (cases.length ? `${plural(cases.length, 'case')} open in your queue` : 'Your helpdesk queue is clear') : cases.length ? `${plural(cases.length, 'request')} of yours still open` : 'You have no open requests',
      summary: cases.length ? `${urgent ? `${urgent} high or urgent. ` : ''}Newest first.` : manage ? 'Nothing open among the cases you handle.' : 'Ask HR from the helpdesk if you need something.',
      how: `${how}Read from ${manage ? 'the cases you handle (confidential ones only if you are a handler for their category)' : 'your own helpdesk requests'}.`,
      items: cases.slice(0, 15).map((c) => ({ label: `${caseRef(c.number)} ${c.subject}`, detail: `${st[c.status] ?? c.status}${manage ? ` · ${c.employeeName}` : ''}`, href: `/helpdesk/${c.id}` })),
      sources: [{ label: 'Helpdesk', href: '/helpdesk' }],
    };
  }

  private async policyAnswer(question: string): Promise<IqAnswer> {
    const status = await this.ai.status();
    if (status.canUse && status.features.assistant?.available) {
      const r = await this.assistant.ask(question);
      return {
        intent: 'policy', confidence: r.answered ? 'matched' : 'low', title: r.answered ? 'From your help articles' : 'No help article covers this',
        summary: r.answer,
        how: r.answered ? 'The AI assistant answered only from the help articles listed below, which it cites.' : 'No published help article matched, so no AI model was asked.',
        sources: (r.sources as { articleId: string; title: string; cited: boolean }[]).filter((s) => s.cited || !r.answered).map((s) => ({ label: s.title, href: `/helpdesk?article=${s.articleId}` })),
        interactionId: r.interactionId,
      };
    }
    const words = question.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !['what', 'when', 'where', 'which', 'does', 'have', 'many', 'much', 'with', 'from', 'that', 'this', 'there', 'about', 'should', 'could', 'would'].includes(w)) ?? [];
    const rows = words.length
      ? await this.db.tenant((tx) => many<{ id: string; title: string; hits: number }>(
        tx,
        `select id, title, (select count(*) from unnest($1::text[]) w where lower(a.title || ' ' || a.body) like '%' || w || '%')::int as hits
           from helpdesk_articles a where a.published order by hits desc, a.updated_at desc limit 3`,
        [words.slice(0, 12)],
      ))
      : [];
    const found = rows.filter((r) => r.hits > 0);
    return {
      intent: 'policy', confidence: found.length ? 'matched' : 'low', title: found.length ? 'Help articles that may answer this' : 'No help article covers this',
      summary: found.length ? 'These published articles share the most words with your question.' : 'Try different words, or raise a request with HR.',
      how: 'Matched the words of your question against published help articles. The AI assistant is not switched on, so no answer was written for you.',
      sources: found.map((r) => ({ label: r.title, href: `/helpdesk?article=${r.id}` })),
      action: found.length ? undefined : { label: 'Ask HR', href: '/helpdesk', preview: [], note: 'Raising a request sends your question to the HR team.' },
    };
  }
}

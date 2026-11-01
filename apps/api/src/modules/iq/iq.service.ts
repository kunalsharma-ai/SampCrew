import { Injectable } from '@nestjs/common';
import { type BooleanFeatureKey, draftJobDescription, type IqAnswer, type IqMatch, IQ_SUGGESTIONS, matchIq } from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, type Subject } from '../../platform/authz/policy';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { AssistantService } from '../ai/assistant.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
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
  ) {}

  async ask(question: string): Promise<IqAnswer> {
    const m = matchIq(question);
    const how = (what: string) => (m.matched.length ? `Matched “${m.matched.join('”, “')}” to ${what}. ` : '');
    switch (m.intent) {
      case 'approvals': return this.approvalsAnswer(how('your approvals'));
      case 'onboarding_tasks': return this.onboardingAnswer(how('onboarding tasks'));
      case 'onboarding_checklist': return this.gated('core_hr', 'employees:update', 'onboarding checklists', () => this.checklistAnswer(how('onboarding checklists')));
      case 'on_leave': return this.gated('leave', 'leave:read', 'leave', (tx, s) => this.onLeaveAnswer(tx, s, m, how('people on leave')));
      case 'leave_trend': return this.gated('leave', 'leave:read', 'leave', (tx, s) => this.leaveTrendAnswer(tx, s, how('the leave trend')));
      case 'headcount': return this.gated('core_hr', 'employees:read', 'employee records', (tx, s) => this.headcountAnswer(tx, s, how('headcount')));
      case 'overtime': return this.gated('attendance_basic', 'attendance:read', 'attendance', (tx, s) => this.overtimeAnswer(tx, s, how('overtime by department')));
      case 'recruitment_summary': return this.gated('recruitment', 'requisitions:read', 'recruitment', (tx, s) => this.recruitmentAnswer(tx, s, m, how('the recruitment summary')));
      case 'draft_bid': return this.gated('recruitment', 'bids:manage', 'staffing bids', () => this.bidAction(m, how('a new staffing bid')));
      case 'draft_job': return this.gated('recruitment', 'requisitions:create', 'requisitions', (tx) => this.jobAction(tx, m, how('a new requisition')));
      case 'policy': return this.policyAnswer(question);
      default: return {
        intent: 'unknown', title: 'I am not sure what you need', confidence: 'low', sources: [],
        summary: 'IQ answers questions about approvals, onboarding, leave, headcount, overtime and recruitment, opens prefilled bids and requisitions, and finds help articles. Try one of these.',
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

  private async onLeaveAnswer(tx: Tx, _s: Subject, m: IqMatch, how: string): Promise<IqAnswer> {
    const r = range(m.params.period, 'week');
    const params: unknown[] = [r.from, r.to];
    const scope = await this.authz.predicate('leave:read', EMPLOYEE_SCOPE, params, tx);
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
      intent: 'on_leave', confidence: 'exact', title: rows.length ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'} on leave ${r.label}` : `Nobody you can see is on leave ${r.label}`,
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

  private async headcountAnswer(tx: Tx, _s: Subject, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
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
      intent: 'headcount', confidence: 'exact', title: `${total} ${total === 1 ? 'person' : 'people'} across ${rows.length} department${rows.length === 1 ? '' : 's'}`,
      summary: 'People who are employed today (on probation, active or serving notice), among those you can see.',
      how: `${how}Counted from employee records, by current department.`,
      table: { columns: ['Department', 'People', 'Joined in 90 days'], rows: rows.map((r) => [r.department, r.people, r.joined]) },
      sources: [{ label: 'Employees', href: '/employees' }, { label: 'Workforce Universe', href: '/insights/universe' }],
    };
  }

  private async overtimeAnswer(tx: Tx, _s: Subject, how: string): Promise<IqAnswer> {
    const params: unknown[] = [];
    const scope = await this.authz.predicate('attendance:read', EMPLOYEE_SCOPE, params, tx);
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

import { Injectable } from '@nestjs/common';
import { type BooleanFeatureKey, caseRef, draftJobDescription, type IqAnswer, type IqConversation, type IqMatch, type IqMessage, IQ_SUGGESTIONS, matchInContext } from '@crew/contracts';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantsFor, type Subject } from '../../platform/authz/policy';
import { ieq, MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { AiService } from '../ai/ai.service';
import { AssistantService } from '../ai/assistant.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import { HelpdeskService } from '../helpdesk/helpdesk.service';
import { Errors } from '../../platform/http/errors';
import { OnboardingService } from '../onboarding/onboarding.service';
import { REQ_FIELDS, visibleRequisitionIds } from '../recruitment/recruitment-common';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const today = () => iso(new Date());
/** The date n days before today, as YYYY-MM-DD (PostgreSQL's current_date - n). */
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** Narrows to the department named in the question (by current department), or adds nothing. */
async function inDept(tx: Tx, m: IqMatch, field = 'current_department_id'): Promise<Record<string, unknown>> {
  if (!m.params.department) return {};
  return { [field]: { $in: await tx.collection('departments').distinct<string>('id', { name: ieq(m.params.department) }) } };
}
const inName = (m: IqMatch) => (m.params.department ? ` in ${m.params.department}` : '');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (v: string | number, currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(v));

/**
 * SampCrew IQ answers. Every data answer is a query run as the asker, narrowed by the same permission scopes as the
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
        if (!(await tx.collection('iq_conversations').exists({ id: conversationId, membership_id: s.membershipId }))) throw Errors.notFound('Conversation');
        const last = await tx.collection('iq_messages').findOne({ conversation_id: conversationId }, { sort: { created_at: -1, id: -1 } });
        previous = last ? { question: last.question as string, match: last.match as IqMatch } : null;
      }
      const departments = (await tx.collection('departments').find({ archived_at: null }, { projection: { name: 1 } })).map((d) => d.name as string);
      return { previous, departments, membershipId: s.membershipId };
    });
    const m = matchInContext(question, ctx.previous?.match ?? null, ctx.departments);
    const answer = await this.answer(question, m);
    if (m.followUp && ctx.previous) answer.how = `Read as a follow-up to “${ctx.previous.question}”. ${answer.how}`;
    return this.db.tenant(async (tx) => {
      let id = conversationId;
      if (!id) {
        id = (await tx.collection('iq_conversations').insert({ membership_id: ctx.membershipId, title: question.slice(0, 120) })).id as string;
      } else {
        await tx.collection('iq_conversations').updateOne({ id }, { $set: { updated_at: new Date() } });
      }
      // Stored as plain JSON, as PostgreSQL's jsonb kept it (no undefined fields, dates as text).
      const msg = await tx.collection('iq_messages').insert({
        conversation_id: id, membership_id: ctx.membershipId, question, intent: answer.intent, match: JSON.parse(JSON.stringify(m)), answer: JSON.parse(JSON.stringify(answer)),
      });
      return { ...answer, conversationId: id, messageId: msg.id as string };
    });
  }

  /** The asker's own conversations, newest first. Nobody else's are ever listed. */
  async conversations(): Promise<IqConversation[]> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const list = await tx.collection('iq_conversations').find({ membership_id: s.membershipId }, { sort: { updated_at: -1 }, limit: 30 });
      const counts = new Map<string, number>();
      for (const x of await tx.collection('iq_messages').find({ conversation_id: { $in: list.map((c) => c.id) } }, { projection: { conversation_id: 1 } })) {
        counts.set(x.conversation_id, (counts.get(x.conversation_id) ?? 0) + 1);
      }
      return list.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at, questions: counts.get(c.id) ?? 0 }) as IqConversation);
    });
  }

  async conversation(id: string): Promise<{ id: string; title: string; messages: IqMessage[] }> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const conv = await tx.collection('iq_conversations').findOne({ id, membership_id: s.membershipId });
      if (!conv) throw Errors.notFound('Conversation');
      const c = { id: conv.id as string, title: conv.title as string };
      const messages = (await tx.collection('iq_messages').find({ conversation_id: id }, { sort: { created_at: 1, id: 1 } }))
        .map((x) => ({ id: x.id, question: x.question, answer: x.answer, createdAt: x.created_at }) as IqMessage);
      return { ...c, messages: messages.map((x) => ({ ...x, answer: { ...x.answer, conversationId: id, messageId: x.id } })) };
    });
  }

  async forget(id: string | null) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const deleted = await tx.collection('iq_conversations').delete(id ? { id, membership_id: s.membershipId } : { membership_id: s.membershipId });
      if (id && !deleted) throw Errors.notFound('Conversation');
      return { deleted };
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
      case 'goals': return this.gated('performance', 'performance:read', 'goals', (tx) => this.goalsAnswer(tx, m, how('goals')));
      case 'learning': return this.gated('learning', 'learning:read', 'learning', (tx) => this.learningAnswer(tx, m, how('training')));
      case 'cases': return this.gated('helpdesk', 'helpdesk:use', 'the helpdesk', (_tx, s) => this.casesAnswer(s, how('helpdesk cases')));
      case 'recruitment_summary': return this.gated('recruitment', 'requisitions:read', 'recruitment', (tx, s) => this.recruitmentAnswer(tx, s, m, how('the recruitment summary')));
      case 'draft_bid': return this.gated('staffing_bids', 'bids:manage', 'staffing bids', () => this.bidAction(m, how('a new staffing bid')));
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
      if (!e.features.has(feature)) return this.refusal(e.blocked[feature] === 'member_blocked' ? `You do not have access to ${area} in this workspace.` : e.blocked[feature] ? `${area[0]!.toUpperCase()}${area.slice(1)} is switched off for this workspace.` : `Your workspace's plan does not include ${area}.`);
      const s = await this.authz.subject(tx);
      if (!grantsFor(s, permission).length) return this.refusal(`Your role does not give you access to ${area}, so IQ cannot look this up for you.`);
      return fn(tx, s);
    });
  }

  /** Employees the asker's `permission` covers, narrowed to the department named in the question. */
  private async people(tx: Tx, permission: string, m: IqMatch | null, extra: Record<string, unknown> = {}): Promise<Map<string, Doc>> {
    const scope = await this.authz.filter(permission, EMPLOYEE_FIELDS, tx);
    const dept = m ? await inDept(tx, m) : {};
    return new Map((await tx.collection('employees').find({ $and: [scope, dept, extra] })).map((e) => [e.id as string, e]));
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
    const people = await this.people(tx, 'leave:read', m);
    const leave = await tx.collection('leave_requests').find({ employee_id: { $in: [...people.keys()] }, status: 'approved', start_date: { $lte: r.to }, end_date: { $gte: r.from } });
    const types = await fieldById(tx, 'leave_types', leave.map((l) => l.leave_type_id));
    const rows = leave
      .map((l) => ({ name: displayName(people.get(l.employee_id) as never), employeeId: l.employee_id as string, type: types.get(l.leave_type_id) ?? '', startDate: l.start_date as string, endDate: l.end_date as string, days: String(l.days) }))
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || byName(a, b))
      .slice(0, 100);
    return {
      intent: 'on_leave', confidence: 'exact', title: rows.length ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}${inName(m)} on leave ${r.label}` : `Nobody you can see${inName(m)} is on leave ${r.label}`,
      summary: `Approved leave overlapping ${fmtDate(r.from)} to ${fmtDate(r.to)}, for the people your leave access covers.`,
      how: `${how}Read from approved leave requests; pending requests are not counted.`,
      table: rows.length ? { columns: ['Person', 'Leave', 'From', 'To', 'Days'], rows: rows.map((x) => [x.name, x.type, fmtDate(x.startDate), fmtDate(x.endDate), Number(x.days)]) } : undefined,
      sources: [{ label: 'Leave', href: '/leave' }],
    };
  }

  private async leaveTrendAnswer(tx: Tx, _s: Subject, how: string): Promise<IqAnswer> {
    const people = await this.people(tx, 'leave:read', null);
    const now = new Date();
    const first = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)));
    const end = iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
    const byMonth = new Map<string, { days: number; requests: number }>();
    for (const l of await tx.collection('leave_requests').find({ employee_id: { $in: [...people.keys()] }, status: 'approved', start_date: { $gte: first, $lt: end } })) {
      const mo = (l.start_date as string).slice(0, 7);
      const x = byMonth.get(mo) ?? { days: 0, requests: 0 };
      byMonth.set(mo, { days: x.days + Number(l.days), requests: x.requests + 1 });
    }
    const months: string[] = [];
    for (let k = 5; k >= 0; k--) months.push(iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1))).slice(0, 7));
    const series = months.map((mo) => ({ mo, days: byMonth.get(mo)?.days ?? 0, requests: byMonth.get(mo)?.requests ?? 0 }));
    const firstHalf = series.slice(0, 3).reduce((t, x) => t + x.days, 0);
    const last = series.slice(3).reduce((t, x) => t + x.days, 0);
    const label = (mo: string) => new Date(`${mo}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const change = firstHalf === 0 ? (last === 0 ? 'no leave taken in either half' : 'up from none') : `${last >= firstHalf ? 'up' : 'down'} ${Math.abs(Math.round(((last - firstHalf) / firstHalf) * 100))}%`;
    return {
      intent: 'leave_trend', confidence: 'exact', title: 'Leave over the last six months',
      summary: `${last} days in the last three months against ${firstHalf} in the three before: ${change}.`,
      how: `${how}Approved leave days by the month they start, for the people your leave access covers.`,
      table: { columns: ['Month', 'Days', 'Requests'], rows: series.map((x) => [label(x.mo), x.days, x.requests]) },
      sources: [{ label: 'Leave', href: '/leave' }],
    };
  }

  private async headcountAnswer(tx: Tx, m: IqMatch, how: string): Promise<IqAnswer> {
    const people = [...(await this.people(tx, 'employees:read', m, { status: { $in: ['probation', 'active', 'notice'] } })).values()];
    const depts = await fieldById(tx, 'departments', people.map((e) => e.current_department_id));
    const since = daysAgo(90);
    const groups = new Map<string, { department: string; people: number; joined: number }>();
    for (const e of people) {
      const department = depts.get(e.current_department_id) ?? 'No department';
      const g = groups.get(department) ?? { department, people: 0, joined: 0 };
      g.people++;
      if (e.date_of_joining > since) g.joined++;
      groups.set(department, g);
    }
    const rows = [...groups.values()].sort((a, b) => b.people - a.people || a.department.localeCompare(b.department));
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
    const people = await this.people(tx, 'attendance:read', m);
    const depts = await fieldById(tx, 'departments', [...people.values()].map((e) => e.current_department_id));
    const split = daysAgo(30);
    const groups = new Map<string, { department: string; recent: number; before: number }>();
    for (const a of await tx.collection('attendance_days').find({ employee_id: { $in: [...people.keys()] }, work_date: { $gt: daysAgo(60), $lte: today() } }, { projection: { employee_id: 1, work_date: 1, overtime_minutes: 1 } })) {
      const department = depts.get(people.get(a.employee_id)!.current_department_id) ?? 'No department';
      const g = groups.get(department) ?? { department, recent: 0, before: 0 };
      if (a.work_date > split) g.recent += a.overtime_minutes ?? 0;
      else g.before += a.overtime_minutes ?? 0;
      groups.set(department, g);
    }
    const rows = [...groups.values()].filter((g) => g.recent + g.before > 0).sort((a, b) => (b.recent - b.before) - (a.recent - a.before));
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
    const scope = await this.authz.filter('requisitions:read', REQ_FIELDS, tx);
    const visible = await visibleRequisitionIds(tx, scope);
    const reqs = await tx.collection('job_requisitions').find(scope, { projection: { id: 1, status: 1 } });
    const apps = await tx.collection('applications').find(visible ? { requisition_id: { $in: visible } } : {}, { projection: { status: 1, applied_at: 1, decided_at: 1, stage_id: 1, candidate_id: 1 } });
    const within = (d: unknown) => d instanceof Date && iso(d) >= r.from && iso(d) <= r.to;
    const f = {
      applied: apps.filter((a) => within(a.applied_at)).length,
      inProcess: apps.filter((a) => a.status === 'active').length,
      hired: apps.filter((a) => a.status === 'hired' && within(a.decided_at)).length,
      rejected: apps.filter((a) => a.status === 'rejected' && within(a.decided_at)).length,
      openJobs: reqs.filter((x) => x.status === 'open').length,
    };
    // The stage counts are "now", so they take no dates.
    const stageDocs = await tx.collection('recruitment_stages').find({}, { sort: { position: 1 } });
    const perStage = new Map<string, number>();
    for (const a of apps) if (a.status === 'active') perStage.set(a.stage_id, (perStage.get(a.stage_id) ?? 0) + 1);
    const stages = stageDocs.filter((x) => perStage.has(x.id)).map((x) => ({ stage: x.name as string, n: perStage.get(x.id)! }));
    const inPeriod = apps.filter((a) => within(a.applied_at));
    const candidates = await fieldById(tx, 'candidates', inPeriod.map((a) => a.candidate_id), 'source');
    const bySource = new Map<string, number>();
    for (const a of inPeriod) { const src = candidates.get(a.candidate_id) ?? ''; bySource.set(src, (bySource.get(src) ?? 0) + 1); }
    const sources = [...bySource].map(([source, n]) => ({ source, n })).sort((a, b) => b.n - a.n).slice(0, 5);
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
    const org = ((await tx.collection('tenants').findOne({}))!.name as string).replace(/\s*\(Demo\)$/, '');
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
    const scope = await this.authz.filter('payroll:read', { membershipId: '_no_membership', legalEntityId: 'legal_entity_id', departmentId: '_no_department', locationId: '_no_location' }, tx);
    const docs = await tx.collection('payroll_runs').find({ $and: [scope, { status: { $ne: 'cancelled' } }] });
    const entities = await fieldById(tx, 'legal_entities', docs.map((d) => d.legal_entity_id));
    const runs = docs
      .map((d) => ({
        id: d.id as string, periodStart: d.period_start as string, periodEnd: d.period_end as string, status: d.status as string, employees: d.employee_count as number,
        gross: String(d.gross), net: String(d.net), employer: String(d.employer_contributions), currency: d.currency as string, entity: entities.get(d.legal_entity_id) ?? '',
      }))
      .sort((a, b) => b.periodEnd.localeCompare(a.periodEnd) || a.entity.localeCompare(b.entity))
      .slice(0, 6);
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
    const people = await this.people(tx, 'expenses:approve', m);
    const claims = await tx.collection('expense_claims').find({ employee_id: { $in: [...people.keys()] }, status: 'pending' }, { sort: { created_at: 1 }, limit: 50 });
    const categories = await fieldById(tx, 'expense_categories', claims.map((x) => x.category_id));
    const rows = claims.map((x) => ({
      name: displayName(people.get(x.employee_id) as never), category: categories.get(x.category_id) ?? '', spentOn: x.spent_on as string, amount: String(x.amount),
      currency: x.currency as string, days: dayDiff(today(), iso(x.created_at as Date)),
    }));
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
    const everyone = [...(await this.people(tx, 'employees:read', m)).values()];
    const leavers = everyone
      .filter((e) => e.status === 'exited' && e.last_working_day && e.last_working_day >= r.from && e.last_working_day <= r.to)
      .sort((a, b) => (b.last_working_day as string).localeCompare(a.last_working_day))
      .slice(0, 50);
    const depts = await fieldById(tx, 'departments', leavers.map((e) => e.current_department_id));
    const left = leavers.map((e) => ({
      name: displayName(e as never), id: e.id as string, department: depts.get(e.current_department_id) ?? null, lastDay: e.last_working_day as string,
      reason: (e.exit_reason as string | null) ?? null, tenure: Math.round((dayDiff(e.last_working_day, e.date_of_joining) / 365.25) * 10) / 10,
    }));
    const employedOn = (d: string, e: Doc) => e.date_of_joining <= d && (!e.last_working_day || e.last_working_day >= d);
    const avg = (everyone.filter((e) => employedOn(r.from, e)).length + everyone.filter((e) => e.status !== 'pre_boarding' && employedOn(r.to, e)).length) / 2;
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
    const list = [...(await this.people(tx, 'employees:read', m, { status: 'probation', probation_end_date: { $lte: r.to } })).values()]
      .sort((a, b) => (a.probation_end_date as string).localeCompare(b.probation_end_date)).slice(0, 50);
    const depts = await fieldById(tx, 'departments', list.map((e) => e.current_department_id));
    const rows = list.map((e) => ({
      id: e.id as string, name: displayName(e as never), department: depts.get(e.current_department_id) ?? null, ends: e.probation_end_date as string, overdue: e.probation_end_date < today(),
    }));
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
    const people = await this.people(tx, 'employees:read', m, { status: { $in: ['probation', 'active', 'notice'] } });
    // The joining date plus whole years; 29 February falls on 28 February in other years, as in PostgreSQL.
    const plusYears = (d: string, g: number) => {
      const [y, mo, day] = d.split('-').map(Number) as [number, number, number];
      const last = new Date(Date.UTC(y + g, mo, 0)).getUTCDate();
      return iso(new Date(Date.UTC(y + g, mo - 1, Math.min(day, last))));
    };
    const found: { id: string; name: string; on: string; years: number }[] = [];
    for (const e of people.values()) {
      if (!e.date_of_joining) continue;
      for (let g = 1; g <= 60; g++) {
        const day = plusYears(e.date_of_joining, g);
        if (day > r.to) break;
        if (day >= r.from) found.push({ id: e.id, name: displayName(e as never), on: day, years: g });
      }
    }
    const rows = found.sort((a, b) => a.on.localeCompare(b.on) || byName(a, b)).slice(0, 50);
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
    const people = await this.people(tx, 'attendance:read', m);
    const days = await tx.collection('attendance_days').find({
      employee_id: { $in: [...people.keys()] }, work_date: today(), $or: [{ status: { $in: ['absent', 'missing_punch'] } }, { late_minutes: { $gt: 0 } }],
    });
    const depts = await fieldById(tx, 'departments', [...people.values()].map((e) => e.current_department_id));
    const rows = days
      .map((a) => {
        const e = people.get(a.employee_id)!;
        return { name: displayName(e as never), department: depts.get(e.current_department_id) ?? null, status: a.status as string, late: (a.late_minutes as number) ?? 0 };
      })
      .sort((a, b) => a.status.localeCompare(b.status) || byName(a, b))
      .slice(0, 100);
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
    const people = await this.people(tx, 'performance:read', m);
    const rank = (c: string | null) => (c === 'off_track' ? 0 : c === 'at_risk' ? 1 : 2);
    const rows = (await tx.collection('goals').find({ employee_id: { $in: [...people.keys()] }, status: 'active' }))
      .map((g) => ({
        title: g.title as string, name: displayName(people.get(g.employee_id) as never), id: g.employee_id as string, progress: String(g.progress),
        confidence: (g.confidence as string | null) ?? null, ends: g.period_end as string,
      }))
      .sort((a, b) => rank(a.confidence) - rank(b.confidence) || a.ends.localeCompare(b.ends))
      .slice(0, 200);
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
    const people = await this.people(tx, 'learning:read', m);
    const list = await tx.collection('course_assignments').find({ employee_id: { $in: [...people.keys()] }, status: { $in: ['assigned', 'in_progress'] } });
    const courses = await fieldById(tx, 'courses', list.map((a) => a.course_id), 'title');
    const now = today();
    const rows = list
      .map((a) => ({
        name: displayName(people.get(a.employee_id) as never), course: courses.get(a.course_id) ?? '', due: (a.due_on as string | null) ?? null,
        overdue: !!a.due_on && a.due_on < now, status: a.status as string,
      }))
      .sort((a, b) => (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due.localeCompare(b.due)))
      .slice(0, 100);
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
      ? await this.db.tenant(async (tx) => {
        const list = words.slice(0, 12);
        return (await tx.collection('helpdesk_articles').find({ published: true }, { projection: { id: 1, title: 1, body: 1, updated_at: 1 } }))
          .map((a) => {
            const text = `${a.title} ${a.body}`.toLowerCase();
            return { id: a.id as string, title: a.title as string, hits: list.filter((w) => text.includes(w)).length, at: (a.updated_at as Date).getTime() };
          })
          .sort((a, b) => b.hits - a.hits || b.at - a.at)
          .slice(0, 3);
      })
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

import { Injectable } from '@nestjs/common';
import { type ArticleInput, type CaseInput, type CasePriority, type CaseStatus, type CategoryInput, caseRef, helpdeskMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, loadSubject } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { can, hasPermission, type Subject } from '../../platform/authz/policy';
import { ilike, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { OutboxService } from '../../platform/events/outbox.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { employeeNames, fieldById, memberNames } from '../employees/employee-view';
import { attrsOf, needEmployee, talentEmployee } from '../talent/talent-common';

interface CaseRow {
  id: string;
  number: number;
  employee_id: string;
  requester_membership_id: string | null;
  raised_by_membership_id: string;
  category_id: string;
  confidential: boolean;
  subject: string;
  priority: CasePriority;
  status: CaseStatus;
  assignee_membership_id: string | null;
  first_responded_at: Date | null;
  resolved_at: Date | null;
  created_at: Date;
  first_response_due_at: Date | null;
  resolution_due_at: Date | null;
}

type Role = 'requester' | 'handler';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2 };

/** Cases as lists and the detail view show them: the person, the category and the assignee by name. */
async function caseViews(tx: TenantTx, cases: Doc[]): Promise<Array<Record<string, unknown>>> {
  const [emps, cats, assignees] = await Promise.all([
    employeeNames(tx, cases.map((c) => c.employee_id)),
    fieldById(tx, 'helpdesk_categories', cases.map((c) => c.category_id)),
    memberNames(tx, cases.map((c) => c.assignee_membership_id)),
  ]);
  return cases.map((c) => ({
    id: c.id, number: c.number, employeeId: c.employee_id, employeeName: emps.get(c.employee_id)?.name ?? null, categoryId: c.category_id,
    categoryName: cats.get(c.category_id) ?? null, confidential: c.confidential, subject: c.subject, priority: c.priority, status: c.status,
    assigneeMembershipId: c.assignee_membership_id ?? null, assigneeName: c.assignee_membership_id ? (assignees.get(c.assignee_membership_id) ?? null) : null,
    firstResponseDueAt: c.first_response_due_at ?? null, resolutionDueAt: c.resolution_due_at ?? null, firstRespondedAt: c.first_responded_at ?? null,
    resolvedAt: c.resolved_at ?? null, closedAt: c.closed_at ?? null, reopenedCount: c.reopened_count, satisfaction: c.satisfaction ?? null,
    satisfactionComment: c.satisfaction_comment ?? null, createdAt: c.created_at, updatedAt: c.updated_at,
  }));
}

/** Matches the status filter of the case lists: 'active' is anything not closed. */
const statusFilter = (status: string) => (status === 'active' ? { status: { $ne: 'closed' } } : { status });

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** Adds the reference and response-target states that every list and detail view shows. */
function decorate<T extends Record<string, unknown>>(c: T) {
  const now = Date.now();
  const start = ms(c.createdAt as Date)!;
  return {
    ...c,
    ref: caseRef(c.number as number),
    firstResponse: helpdeskMath.targetState({ startMs: start, dueMs: ms(c.firstResponseDueAt as Date), doneMs: ms(c.firstRespondedAt as Date), nowMs: now }),
    resolution: helpdeskMath.targetState({ startMs: start, dueMs: ms(c.resolutionDueAt as Date), doneMs: ms(c.resolvedAt as Date), nowMs: now }),
  };
}

/**
 * HR helpdesk. People raise cases in a category; the category's handlers (or anyone with `helpdesk:manage`
 * over the person, for categories that are not confidential) work them. Confidential categories, such as a
 * grievance, are visible only to their named handlers and the person themself; managers never see cases.
 * Messages and history are insert-only; a closed case is final (database trigger).
 */
@Injectable()
export class HelpdeskService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxService,
  ) {}

  // Access -----------------------------------------------------------------------------------------------------

  private async handlersOf(tx: TenantTx, categoryId: string): Promise<string[]> {
    return (await tx.collection('helpdesk_category_handlers').find({ category_id: categoryId }, { sort: { position: 1 } })).map((r) => r.membership_id as string);
  }

  /** Whether a subject may handle a case about this employee, in this category. */
  private async mayHandle(tx: TenantTx, s: Subject, c: { employee_id: string; category_id: string; confidential: boolean; assignee_membership_id?: string | null }) {
    if (s.employeeId && s.employeeId === c.employee_id) return false;
    if (c.confidential) return (await this.handlersOf(tx, c.category_id)).includes(s.membershipId);
    if (c.assignee_membership_id === s.membershipId && hasPermission(s, 'helpdesk:manage').allowed) return true;
    return can(s, 'helpdesk:manage', attrsOf(await talentEmployee(tx, c.employee_id))).allowed;
  }

  /** Loads a case with the caller's role, or 404 when they may not see it. */
  private async load(tx: TenantTx, id: string): Promise<{ c: CaseRow; role: Role; s: Subject }> {
    const s = await this.authz.subject(tx);
    const c = (await tx.collection('helpdesk_cases').findOne({ id })) as CaseRow | undefined;
    if (!c) throw Errors.notFound('Case');
    if ((s.employeeId && c.employee_id === s.employeeId) || c.requester_membership_id === s.membershipId) return { c, role: 'requester', s };
    if (await this.mayHandle(tx, s, c)) return { c, role: 'handler', s };
    throw Errors.notFound('Case');
  }

  private async event(tx: TenantTx, caseId: string, by: string | null, action: string, from: string | null, to: string | null) {
    await tx.collection('helpdesk_events').insert({ case_id: caseId, by_membership_id: by, action, from_value: from, to_value: to });
  }

  /** Picks the category handler with the fewest open cases; ties go to the first listed. */
  private async autoAssignee(tx: TenantTx, categoryId: string, employeeMembershipId: string | null): Promise<string | null> {
    const handlers = await tx.collection('helpdesk_category_handlers').find({ category_id: categoryId, membership_id: { $ne: employeeMembershipId } }, { sort: { position: 1 } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: handlers.map((h) => h.membership_id) }, status: 'active' }));
    const candidates = handlers.filter((h) => active.has(h.membership_id));
    if (!candidates.length) return null;
    const open = new Map(
      (await tx.collection('helpdesk_cases').aggregate<{ id: string; n: number }>([
        { $match: { assignee_membership_id: { $in: candidates.map((h) => h.membership_id) }, status: { $nin: ['resolved', 'closed'] } } },
        { $group: { _id: '$assignee_membership_id', n: { $sum: 1 } } },
      ])).map((x) => [x.id, x.n]),
    );
    // Fewest open cases first; ties keep the handlers' order.
    return [...candidates].sort((a, b) => (open.get(a.membership_id) ?? 0) - (open.get(b.membership_id) ?? 0))[0]!.membership_id as string;
  }

  // Categories and articles -----------------------------------------------------------------------------------

  async categories(withHandlers = false) {
    return this.db.tenant(async (tx) => {
      if (withHandlers) await this.authz.require('helpdesk:configure', undefined, tx);
      const cats = await tx.collection('helpdesk_categories').find(withHandlers ? {} : { archived_at: null }, { sort: { archived_at: 1, name: 1 } });
      const articles = await tx.collection('helpdesk_articles').find({ published: true, category_id: { $in: cats.map((k) => k.id) } }, { projection: { category_id: 1 } });
      const rows = cats.map((k) => ({
        id: k.id as string, name: k.name, description: k.description ?? null, confidential: k.confidential, firstResponseHours: k.first_response_hours ?? null,
        resolutionHours: k.resolution_hours ?? null, archivedAt: k.archived_at ?? null, articleCount: articles.filter((a) => a.category_id === k.id).length,
      }));
      if (!withHandlers) return rows;
      const handlers = await tx.collection('helpdesk_category_handlers').find({}, { sort: { position: 1 } });
      const names = await memberNames(tx, handlers.map((h) => h.membership_id));
      return rows.map((r) => ({ ...r, handlers: handlers.filter((h) => h.category_id === r.id).map((h) => ({ membershipId: h.membership_id, name: names.get(h.membership_id) ?? null })) }));
    });
  }

  /** Members who can be named as handlers or assignees: everyone holding `helpdesk:manage`. */
  async handlers() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!hasPermission(s, 'helpdesk:manage').allowed && !hasPermission(s, 'helpdesk:configure').allowed) throw Errors.forbidden();
      const out = await this.helpdeskMembers(tx);
      const names = await memberNames(tx, out.map((x) => x.membershipId));
      return out.map((x) => ({ ...x, name: names.get(x.membershipId) ?? null })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    });
  }

  /** Active members holding `helpdesk:manage` through a role, once per scope they hold it with. */
  private async helpdeskMembers(tx: TenantTx, only?: string[]): Promise<Array<{ membershipId: string; scope: string }>> {
    const perms = await tx.collection('role_permissions').find({ permission: 'helpdesk:manage' }, { projection: { role_id: 1, scope: 1 } });
    const assignments = await tx.collection('role_assignments').find({ role_id: { $in: perms.map((p) => p.role_id) }, ...(only ? { membership_id: { $in: only } } : {}) }, { projection: { membership_id: 1, role_id: 1 } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: assignments.map((a) => a.membership_id) }, status: 'active' }));
    const seen = new Set<string>();
    const out: Array<{ membershipId: string; scope: string }> = [];
    for (const a of assignments) {
      if (!active.has(a.membership_id)) continue;
      for (const p of perms.filter((x) => x.role_id === a.role_id)) {
        const key = `${a.membership_id}:${p.scope}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ membershipId: a.membership_id, scope: p.scope });
      }
    }
    return out;
  }

  private async setHandlers(tx: TenantTx, categoryId: string, ids: string[]) {
    const ok = new Set((await this.helpdeskMembers(tx, ids)).map((v) => v.membershipId));
    const bad = ids.find((i) => !ok.has(i));
    if (bad) throw Errors.badRequest('not_a_handler', 'Every handler needs a role that can handle helpdesk cases');
    const handlers = tx.collection('helpdesk_category_handlers');
    await handlers.delete({ category_id: categoryId });
    await handlers.insertMany([...new Set(ids)].map((id, pos) => ({ category_id: categoryId, membership_id: id, position: pos })));
  }

  async createCategory(input: CategoryInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      const inserted = await tx.collection('helpdesk_categories').insert({
        name: input.name, description: input.description ?? null, confidential: input.confidential, first_response_hours: input.firstResponseHours ?? null, resolution_hours: input.resolutionHours ?? null,
      }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('category_exists', 'A category with this name already exists');
        throw err;
      });
      const r = { id: inserted.id as string };
      await this.setHandlers(tx, r!.id, input.handlerMembershipIds);
      await this.audit.record(tx, { action: 'helpdesk.category_created', resourceType: 'helpdesk_category', resourceId: r!.id, changes: { name: input.name, confidential: input.confidential, handlers: input.handlerMembershipIds.length } });
      return r;
    });
  }

  async updateCategory(id: string, input: CategoryInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      const before = await tx.collection('helpdesk_categories').findOne({ id, archived_at: null });
      if (!before) throw Errors.notFound('Category');
      // Existing cases keep the confidentiality they were raised with, so nobody suddenly gains or loses sight of them.
      await tx.collection('helpdesk_categories').updateOne({ id }, {
        $set: { name: input.name, description: input.description ?? null, confidential: input.confidential, first_response_hours: input.firstResponseHours ?? null, resolution_hours: input.resolutionHours ?? null },
      }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('category_exists', 'A category with this name already exists');
        throw err;
      });
      await this.setHandlers(tx, id, input.handlerMembershipIds);
      await this.audit.record(tx, { action: 'helpdesk.category_updated', resourceType: 'helpdesk_category', resourceId: id, changes: { name: input.name, confidential: input.confidential, handlers: input.handlerMembershipIds } });
      return { id };
    });
  }

  async archiveCategory(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      if (!(await tx.collection('helpdesk_categories').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } }))) throw Errors.notFound('Category');
      await this.audit.record(tx, { action: 'helpdesk.category_archived', resourceType: 'helpdesk_category', resourceId: id });
      return { id };
    });
  }

  async articles(q: { categoryId?: string; q?: string; all?: boolean }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const all = q.all === true && hasPermission(s, 'helpdesk:configure').allowed;
      const like = q.q ? ilike(q.q) : null;
      const docs = await tx.collection('helpdesk_articles').find(
        { $and: [all ? {} : { published: true }, q.categoryId ? { category_id: q.categoryId } : {}, like ? { $or: [{ title: like }, { body: like }] } : {}] },
        { sort: { title: 1 }, limit: 200 },
      );
      const cats = await fieldById(tx, 'helpdesk_categories', docs.map((a) => a.category_id));
      return docs.map((a) => ({ id: a.id, categoryId: a.category_id ?? null, categoryName: cats.get(a.category_id) ?? null, title: a.title, excerpt: (a.body as string).slice(0, 240), published: a.published, updatedAt: a.updated_at }));
    });
  }

  async article(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const doc = await tx.collection('helpdesk_articles').findOne({ id });
      const cat = doc?.category_id ? await tx.collection('helpdesk_categories').findOne({ id: doc.category_id }) : undefined;
      const a = doc && { id: doc.id, categoryId: doc.category_id ?? null, categoryName: cat?.name ?? null, title: doc.title, body: doc.body, published: doc.published as boolean, updatedAt: doc.updated_at };
      if (!a || (!a.published && !hasPermission(s, 'helpdesk:configure').allowed)) throw Errors.notFound('Article');
      return a;
    });
  }

  async saveArticle(id: string | null, input: ArticleInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      const s = await this.authz.subject(tx);
      if (input.categoryId && !(await tx.collection('helpdesk_categories').exists({ id: input.categoryId }))) throw Errors.badRequest('unknown_category', 'Choose an existing category');
      if (id) {
        const n = await tx.collection('helpdesk_articles').updateOne({ id }, { $set: { category_id: input.categoryId ?? null, title: input.title, body: input.body, published: input.published, updated_by_membership_id: s.membershipId } });
        if (!n) throw Errors.notFound('Article');
      } else {
        id = (await tx.collection('helpdesk_articles').insert({ category_id: input.categoryId ?? null, title: input.title, body: input.body, published: input.published, updated_by_membership_id: s.membershipId })).id as string;
      }
      await this.audit.record(tx, { action: 'helpdesk.article_saved', resourceType: 'helpdesk_article', resourceId: id, changes: { title: input.title, published: input.published } });
      return { id };
    });
  }

  async removeArticle(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      if (!(await tx.collection('helpdesk_articles').deleteOne({ id }))) throw Errors.notFound('Article');
      await this.audit.record(tx, { action: 'helpdesk.article_deleted', resourceType: 'helpdesk_article', resourceId: id });
    });
  }

  // Cases ------------------------------------------------------------------------------------------------------

  async list(q: { view: 'mine' | 'queue'; status?: 'active' | CaseStatus; assigned?: 'me' | 'unassigned' | 'all'; q?: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const status = q.status ?? 'active';
      if (q.view === 'mine') {
        if (!s.employeeId) return [];
        const rows = await caseViews(tx, await tx.collection('helpdesk_cases').find({ employee_id: s.employeeId, ...statusFilter(status) }, { sort: { created_at: -1 }, limit: 200 }));
        return rows.map(decorate);
      }
      if (!hasPermission(s, 'helpdesk:manage').allowed) throw Errors.forbidden();
      const scope = await this.authz.filter('helpdesk:manage', EMPLOYEE_FIELDS, tx);
      const inScope = await tx.collection('employees').distinct<string>('id', scope);
      const handled = await tx.collection('helpdesk_category_handlers').distinct<string>('category_id', { membership_id: s.membershipId });
      const assigned = q.assigned === 'me' ? { assignee_membership_id: s.membershipId } : q.assigned === 'unassigned' ? { assignee_membership_id: null } : {};
      const docs = await tx.collection('helpdesk_cases').find({
        $and: [
          { employee_id: { $ne: s.employeeId ?? null } },
          { $or: [{ confidential: true, category_id: { $in: handled } }, { confidential: false, $or: [{ employee_id: { $in: inScope } }, { assignee_membership_id: s.membershipId }] }] },
          statusFilter(status),
          assigned,
        ],
      });
      let rows = await caseViews(tx, docs);
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter((c) => [c.subject, c.employeeName, caseRef(c.number as number)].some((v) => String(v ?? '').toLowerCase().includes(needle)));
      }
      const at = (v: unknown) => (v ? new Date(v as Date).getTime() : 0);
      rows.sort((a, b) =>
        (PRIORITY_ORDER[a.priority as string] ?? 3) - (PRIORITY_ORDER[b.priority as string] ?? 3) ||
        at(a.firstRespondedAt ?? a.firstResponseDueAt ?? a.createdAt) - at(b.firstRespondedAt ?? b.firstResponseDueAt ?? b.createdAt) ||
        at(a.createdAt) - at(b.createdAt));
      return rows.slice(0, 500).map(decorate);
    });
  }

  async create(input: CaseInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const k = await tx.collection<{ id: string; name: string; confidential: boolean; first_response_hours: number | null; resolution_hours: number | null }>('helpdesk_categories')
        .findOne({ id: input.categoryId, archived_at: null });
      if (!k) throw Errors.badRequest('unknown_category', 'Choose one of the helpdesk categories');
      let employeeId: string;
      if (input.employeeId && input.employeeId !== s.employeeId) {
        // A handler logging a call or a walk-in for someone in their scope.
        employeeId = input.employeeId;
        const e = await talentEmployee(tx, employeeId);
        if (!(await this.mayHandle(tx, s, { employee_id: e.id, category_id: k.id, confidential: k.confidential }))) throw Errors.notFound('Employee');
      } else {
        await this.authz.require('helpdesk:use', undefined, tx);
        employeeId = needEmployee(s.employeeId);
      }
      const e = await talentEmployee(tx, employeeId);
      if (e.status === 'exited') throw Errors.badRequest('employee_exited', 'Cases can only be raised for current employees');
      const counters = tx.collection('helpdesk_counters');
      await counters.upsert({}, { last_number: 0 });
      const number = (await counters.updateAndGet({}, { $inc: { last_number: 1 } }))!.last_number as number;
      const now = Date.now();
      const fr = helpdeskMath.dueAt(now, k.first_response_hours, input.priority);
      const res = helpdeskMath.dueAt(now, k.resolution_hours, input.priority);
      const assignee = await this.autoAssignee(tx, k.id, e.membership_id);
      const c = await tx.collection('helpdesk_cases').insert({
        number, employee_id: e.id, requester_membership_id: e.membership_id, raised_by_membership_id: s.membershipId, category_id: k.id, confidential: k.confidential,
        subject: input.subject, description: input.description, priority: input.priority, assignee_membership_id: assignee,
        first_response_due_at: fr ? new Date(fr) : null, resolution_due_at: res ? new Date(res) : null, created_at: new Date(now),
      });
      await this.event(tx, c.id, s.membershipId, 'created', null, 'open');
      if (assignee) await this.event(tx, c.id, null, 'assigned', null, assignee);
      // The subject is not audited: case content stays in the helpdesk, where only handlers can read it.
      await this.audit.record(tx, { action: 'helpdesk.case_created', resourceType: 'helpdesk_case', resourceId: c.id, metadata: { ref: caseRef(number), category: k.name, confidential: k.confidential, onBehalf: e.id !== s.employeeId } });
      const notifyIds = assignee ? [assignee] : k.confidential ? await this.handlersOf(tx, k.id) : [];
      await this.notifications.notify(tx, { membershipIds: notifyIds, kind: 'helpdesk.case_new', title: `New helpdesk case ${caseRef(number)} in ${k.name}`, link: `/helpdesk/${c.id}` });
      if (e.id !== s.employeeId) {
        await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'helpdesk.case_logged', title: `HR logged case ${caseRef(number)} for you`, link: `/helpdesk/${c.id}` });
      }
      // Workflows can start from a new case, but never from a confidential one.
      if (!k.confidential) await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'helpdesk.case_created', { caseId: c.id, employeeId: e.id });
      return { id: c.id, ref: caseRef(number) };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      const doc = (await tx.collection('helpdesk_cases').findOne({ id }))!;
      const row: Record<string, unknown> = { ...(await caseViews(tx, [doc]))[0]!, description: doc.description, raisedByMembershipId: doc.raised_by_membership_id };
      const msgDocs = await tx.collection('helpdesk_messages').find({ case_id: id, ...(role === 'handler' ? {} : { internal: false }) }, { sort: { created_at: 1 } });
      const authors = await memberNames(tx, msgDocs.map((x) => x.author_membership_id));
      const messages = msgDocs.map((x) => ({
        id: x.id, body: x.body, internal: x.internal, createdAt: x.created_at, aiDrafted: !!x.ai_interaction_id, authorMembershipId: x.author_membership_id,
        authorName: authors.get(x.author_membership_id) ?? null, mine: x.author_membership_id === s.membershipId, fromHr: x.author_membership_id !== c.requester_membership_id,
      }));
      const history = role === 'handler'
        ? await (async () => {
            const events = await tx.collection('helpdesk_events').find({ case_id: id }, { sort: { created_at: 1 } });
            const names = await memberNames(tx, [...events.map((v) => v.by_membership_id), ...events.filter((v) => v.action === 'assigned').map((v) => v.to_value)]);
            return events.map((v) => ({
              action: v.action, from: v.from_value ?? null, to: v.to_value ?? null, createdAt: v.created_at, byName: v.by_membership_id ? (names.get(v.by_membership_id) ?? null) : null,
              toName: v.action === 'assigned' && v.to_value ? (names.get(v.to_value) ?? null) : null,
            }));
          })()
        : [];
      if (c.confidential && role === 'handler') {
        await this.audit.record(tx, { action: 'helpdesk.case_viewed', resourceType: 'helpdesk_case', resourceId: id, metadata: { ref: caseRef(c.number), confidential: true } });
      }
      const terminal = c.status === 'closed';
      return {
        ...decorate(row),
        role,
        messages,
        history,
        moves: terminal ? [] : helpdeskMath.allowedMoves(c.status, role),
        can: {
          reply: !terminal,
          internalNote: role === 'handler' && !terminal,
          assign: role === 'handler' && !terminal,
          rate: role === 'requester' && c.status === 'resolved' && row.satisfaction === null,
        },
      };
    });
  }

  /**
   * What an AI reply draft may see: the request and the public conversation, with people named only as
   * "the employee" and "HR". Internal notes are left out. Only a handler of the case gets it.
   */
  async draftContext(id: string) {
    return this.db.tenant(async (tx) => {
      const { c, role } = await this.load(tx, id);
      if (role !== 'handler') throw Errors.notFound('Case');
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      const k = (await tx.collection('helpdesk_categories').findOne({ id: c.category_id }))!;
      const desc = (await tx.collection('helpdesk_cases').findOne({ id }))!.description as string;
      const messages = (await tx.collection('helpdesk_messages').find({ case_id: id, internal: false }, { sort: { created_at: 1 } }))
        .map((x) => ({ fromHr: x.author_membership_id !== c.requester_membership_id, body: x.body as string }));
      return { ref: caseRef(c.number), category: k.name, confidential: c.confidential, subject: c.subject, description: desc, messages };
    });
  }

  async reply(id: string, body: string, internal: boolean, aiInteractionId?: string) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed. Raise a new case if you still need help.');
      if (internal && role !== 'handler') throw Errors.forbidden('Only HR can add internal notes');
      if (aiInteractionId) {
        // Only the handler's own draft for this very case can be linked.
        const d = await tx.collection('ai_interactions').exists({ id: aiInteractionId, feature: 'helpdesk_draft', status: 'ok', subject_id: id, membership_id: s.membershipId });
        if (role !== 'handler' || !d) throw Errors.badRequest('unknown_draft', 'That AI draft is not one of yours for this case');
      }
      await tx.collection('helpdesk_messages').insert({ case_id: id, author_membership_id: s.membershipId, body, internal, ai_interaction_id: aiInteractionId ?? null });
      const ref = caseRef(c.number);
      if (role === 'handler' && !internal) {
        // The first public reply counts as the first response, starts work on an open case and, if nobody has the
        // case yet, makes the person replying its assignee.
        await tx.collection('helpdesk_cases').updateOne({ id }, {
          $set: {
            first_responded_at: c.first_responded_at ?? new Date(), status: c.status === 'open' ? 'in_progress' : c.status,
            assignee_membership_id: c.assignee_membership_id ?? s.membershipId,
          },
        });
        if (c.status === 'open') await this.event(tx, id, s.membershipId, 'status', 'open', 'in_progress');
        if (!c.assignee_membership_id) await this.event(tx, id, s.membershipId, 'assigned', null, s.membershipId);
        await this.notifications.notify(tx, { membershipIds: [c.requester_membership_id], kind: 'helpdesk.reply', title: `HR replied on ${ref}`, link: `/helpdesk/${id}`, email: true });
      } else if (role === 'requester') {
        if (c.status === 'waiting_on_employee') {
          await tx.collection('helpdesk_cases').updateOne({ id }, { $set: { status: 'in_progress' } });
          await this.event(tx, id, s.membershipId, 'status', c.status, 'in_progress');
        } else await tx.collection('helpdesk_cases').updateOne({ id }, { $set: { updated_at: new Date() } });
        const to = c.assignee_membership_id ? [c.assignee_membership_id] : c.confidential ? await this.handlersOf(tx, c.category_id) : [];
        await this.notifications.notify(tx, { membershipIds: to, kind: 'helpdesk.reply', title: `New reply on ${ref}`, link: `/helpdesk/${id}` });
      }
      return { ok: true };
    });
  }

  async setStatus(id: string, status: CaseStatus, message?: string) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (!helpdeskMath.canMove(c.status, status, role)) {
        throw Errors.conflict('invalid_move', c.status === 'closed' ? 'This case is closed.' : `A case that is ${c.status.replace(/_/g, ' ')} cannot be moved to ${status.replace(/_/g, ' ')}.`);
      }
      if (status === 'resolved' && !message?.trim()) throw Errors.badRequest('resolution_required', 'Say how the case was resolved; the person sees it.');
      if (message?.trim()) await tx.collection('helpdesk_messages').insert({ case_id: id, author_membership_id: s.membershipId, body: message.trim(), internal: false });
      const reopen = status === 'open' || (status === 'in_progress' && c.status === 'resolved');
      const now = new Date();
      await tx.collection('helpdesk_cases').updateOne({ id }, {
        $set: {
          status,
          resolved_at: status === 'resolved' ? now : reopen ? null : c.resolved_at,
          ...(status === 'closed' ? { closed_at: now } : {}),
          ...(role === 'handler' && !c.first_responded_at && status !== 'closed' ? { first_responded_at: now } : {}),
        },
        ...(reopen ? { $inc: { reopened_count: 1 } } : {}),
      });
      await this.event(tx, id, s.membershipId, 'status', c.status, status);
      await this.audit.record(tx, { action: 'helpdesk.case_status', resourceType: 'helpdesk_case', resourceId: id, changes: { status: { from: c.status, to: status } } });
      const ref = caseRef(c.number);
      if (role === 'handler') {
        const title = status === 'resolved' ? `${ref} is resolved: confirm or reopen it` : status === 'waiting_on_employee' ? `HR needs more information on ${ref}` : `${ref} is now ${status.replace(/_/g, ' ')}`;
        await this.notifications.notify(tx, { membershipIds: [c.requester_membership_id], kind: 'helpdesk.status', title, link: `/helpdesk/${id}`, email: status === 'resolved' || status === 'waiting_on_employee' });
      } else {
        const to = c.assignee_membership_id ? [c.assignee_membership_id] : await this.handlersOf(tx, c.category_id);
        await this.notifications.notify(tx, { membershipIds: to, kind: 'helpdesk.status', title: status === 'open' ? `${ref} was reopened` : `${ref} was confirmed and closed`, link: `/helpdesk/${id}` });
      }
      return { status };
    });
  }

  async assign(id: string, assigneeMembershipId: string | null) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (role !== 'handler') throw Errors.forbidden();
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      if (assigneeMembershipId) {
        const m = await tx.collection<{ user_id: string; employee_id: string | null }>('memberships').findOne({ id: assigneeMembershipId, status: 'active' });
        if (!m) throw Errors.badRequest('unknown_assignee', 'Choose an active member');
        const them = await loadSubject(tx, assigneeMembershipId, m.user_id, true);
        if (!(await this.mayHandle(tx, them, { ...c, assignee_membership_id: null }))) {
          throw Errors.badRequest('assignee_cannot_handle', c.confidential ? 'Only the handlers of this confidential category can take the case.' : 'This person cannot handle cases for this employee.');
        }
      }
      await tx.collection('helpdesk_cases').updateOne({ id }, { $set: { assignee_membership_id: assigneeMembershipId } });
      await this.event(tx, id, s.membershipId, 'assigned', c.assignee_membership_id, assigneeMembershipId);
      await this.audit.record(tx, { action: 'helpdesk.case_assigned', resourceType: 'helpdesk_case', resourceId: id, changes: { assignee: { from: c.assignee_membership_id, to: assigneeMembershipId } } });
      if (assigneeMembershipId && assigneeMembershipId !== s.membershipId) {
        await this.notifications.notify(tx, { membershipIds: [assigneeMembershipId], kind: 'helpdesk.assigned', title: `${caseRef(c.number)} was assigned to you`, link: `/helpdesk/${id}` });
      }
      return { assigneeMembershipId };
    });
  }

  async setPriority(id: string, priority: CasePriority) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (role !== 'handler') throw Errors.forbidden();
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      const k = (await tx.collection<{ first_response_hours: number | null; resolution_hours: number | null }>('helpdesk_categories').findOne({ id: c.category_id }))!;
      const start = new Date(c.created_at).getTime();
      const fr = helpdeskMath.dueAt(start, k.first_response_hours, priority);
      const res = helpdeskMath.dueAt(start, k.resolution_hours, priority);
      await tx.collection('helpdesk_cases').updateOne({ id }, { $set: { priority, first_response_due_at: fr ? new Date(fr) : null, resolution_due_at: res ? new Date(res) : null } });
      await this.event(tx, id, s.membershipId, 'priority', c.priority, priority);
      return { priority };
    });
  }

  async setCategory(id: string, categoryId: string) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (role !== 'handler') throw Errors.forbidden();
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      const k = await tx.collection<{ id: string; name: string; confidential: boolean; first_response_hours: number | null; resolution_hours: number | null }>('helpdesk_categories')
        .findOne({ id: categoryId, archived_at: null });
      if (!k) throw Errors.badRequest('unknown_category', 'Choose one of the helpdesk categories');
      const start = new Date(c.created_at).getTime();
      const fr = helpdeskMath.dueAt(start, k.first_response_hours, c.priority);
      const res = helpdeskMath.dueAt(start, k.resolution_hours, c.priority);
      // A case moved into a confidential category becomes confidential, and goes to that category's handlers.
      const confidential = c.confidential || k.confidential;
      const keepAssignee = c.assignee_membership_id && (!confidential || (await this.handlersOf(tx, k.id)).includes(c.assignee_membership_id));
      const employeeMembership = (await talentEmployee(tx, c.employee_id)).membership_id;
      const assignee = keepAssignee ? c.assignee_membership_id : await this.autoAssignee(tx, k.id, employeeMembership);
      await tx.collection('helpdesk_cases').updateOne({ id }, {
        $set: { category_id: k.id, confidential, first_response_due_at: fr ? new Date(fr) : null, resolution_due_at: res ? new Date(res) : null, assignee_membership_id: assignee },
      });
      await this.event(tx, id, s.membershipId, 'category', c.category_id, k.id);
      if (assignee !== c.assignee_membership_id) {
        await this.event(tx, id, s.membershipId, 'assigned', c.assignee_membership_id, assignee);
        await this.notifications.notify(tx, { membershipIds: [assignee], kind: 'helpdesk.assigned', title: `${caseRef(c.number)} was assigned to you`, link: `/helpdesk/${id}` });
      }
      await this.audit.record(tx, { action: 'helpdesk.case_recategorised', resourceType: 'helpdesk_case', resourceId: id, changes: { category: { from: c.category_id, to: k.id }, confidential } });
      return { categoryId: k.id, confidential };
    });
  }

  async rate(id: string, rating: number, comment: string) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (role !== 'requester') throw Errors.forbidden('Only the person who raised the case can rate it');
      if (c.status !== 'resolved' && c.status !== 'closed') throw Errors.conflict('not_resolved', 'You can rate a case once it is resolved.');
      // A closed case is final, so the rating is given while it is resolved (the app asks when confirming).
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      const done = await tx.collection('helpdesk_cases').exists({ id, satisfaction: { $ne: null } });
      if (done) throw Errors.conflict('already_rated', 'You have already rated this case.');
      await tx.collection('helpdesk_cases').updateOne({ id }, { $set: { satisfaction: rating, satisfaction_comment: comment || null } });
      await this.event(tx, id, s.membershipId, 'rated', null, String(rating));
      return { rating };
    });
  }

  /** Closes cases resolved more than AUTO_CLOSE_DAYS ago that the person neither confirmed nor reopened. */
  async autoClose(tx: TenantTx): Promise<number> {
    const cases = tx.collection('helpdesk_cases');
    const due = await cases.find({ status: 'resolved', resolved_at: { $lt: new Date(Date.now() - helpdeskMath.AUTO_CLOSE_DAYS * 86_400_000) } }, { projection: { _id: 1 } });
    for (const r of due) {
      await cases.updateOne({ id: r.id, status: 'resolved' }, { $set: { status: 'closed', closed_at: new Date() } });
      await this.event(tx, r.id, null, 'status', 'resolved', 'closed');
    }
    return due.length;
  }

  /** Counts for the Web Portal and mobile home screens. */
  async summary() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const cases = tx.collection('helpdesk_cases');
      const mine = s.employeeId
        ? {
            open: await cases.count({ employee_id: s.employeeId, status: { $in: ['open', 'in_progress'] } }),
            waiting: await cases.count({ employee_id: s.employeeId, status: 'waiting_on_employee' }),
            resolved: await cases.count({ employee_id: s.employeeId, status: 'resolved' }),
          }
        : { open: 0, waiting: 0, resolved: 0 };
      const assigned = hasPermission(s, 'helpdesk:manage').allowed ? await cases.count({ assignee_membership_id: s.membershipId, status: { $in: ['open', 'in_progress'] } }) : null;
      return { mine, assignedToMe: assigned };
    });
  }
}

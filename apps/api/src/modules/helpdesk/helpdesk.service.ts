import { Injectable } from '@nestjs/common';
import { type ArticleInput, type CaseInput, type CasePriority, type CaseStatus, type CategoryInput, caseRef, helpdeskMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, loadSubject } from '../../platform/authz/authz.service';
import { can, hasPermission, type Subject } from '../../platform/authz/policy';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { attrsOf, nameOf, needEmployee, talentEmployee } from '../talent/talent-common';

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

const CASE_COLS = `c.id, c.number, c.employee_id as "employeeId", ${nameOf('e')} as "employeeName", c.category_id as "categoryId", k.name as "categoryName",
  c.confidential, c.subject, c.priority, c.status, c.assignee_membership_id as "assigneeMembershipId",
  coalesce(nullif(${nameOf('ae')}, ''), au.full_name) as "assigneeName", c.first_response_due_at as "firstResponseDueAt", c.resolution_due_at as "resolutionDueAt",
  c.first_responded_at as "firstRespondedAt", c.resolved_at as "resolvedAt", c.closed_at as "closedAt", c.reopened_count as "reopenedCount",
  c.satisfaction, c.satisfaction_comment as "satisfactionComment", c.created_at as "createdAt", c.updated_at as "updatedAt"`;
const CASE_FROM = `helpdesk_cases c join employees e on e.id = c.employee_id join helpdesk_categories k on k.id = c.category_id
  left join memberships am on am.id = c.assignee_membership_id left join users au on au.id = am.user_id left join employees ae on ae.id = am.employee_id`;

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
  ) {}

  // Access -----------------------------------------------------------------------------------------------------

  private async handlersOf(tx: Tx, categoryId: string): Promise<string[]> {
    return (await many<{ membership_id: string }>(tx, 'select membership_id from helpdesk_category_handlers where category_id = $1 order by position', [categoryId])).map((r) => r.membership_id);
  }

  /** Whether a subject may handle a case about this employee, in this category. */
  private async mayHandle(tx: Tx, s: Subject, c: { employee_id: string; category_id: string; confidential: boolean; assignee_membership_id?: string | null }) {
    if (s.employeeId && s.employeeId === c.employee_id) return false;
    if (c.confidential) return (await this.handlersOf(tx, c.category_id)).includes(s.membershipId);
    if (c.assignee_membership_id === s.membershipId && hasPermission(s, 'helpdesk:manage').allowed) return true;
    return can(s, 'helpdesk:manage', attrsOf(await talentEmployee(tx, c.employee_id))).allowed;
  }

  /** Loads a case with the caller's role, or 404 when they may not see it. */
  private async load(tx: Tx, id: string): Promise<{ c: CaseRow; role: Role; s: Subject }> {
    const s = await this.authz.subject(tx);
    const c = await one<CaseRow>(tx, 'select * from helpdesk_cases where id = $1', [id]);
    if (!c) throw Errors.notFound('Case');
    if ((s.employeeId && c.employee_id === s.employeeId) || c.requester_membership_id === s.membershipId) return { c, role: 'requester', s };
    if (await this.mayHandle(tx, s, c)) return { c, role: 'handler', s };
    throw Errors.notFound('Case');
  }

  private async event(tx: Tx, caseId: string, by: string | null, action: string, from: string | null, to: string | null) {
    await tx.query(`insert into helpdesk_events (tenant_id, case_id, by_membership_id, action, from_value, to_value) values (app_tenant_id(), $1, $2, $3, $4, $5)`, [caseId, by, action, from, to]);
  }

  /** Picks the category handler with the fewest open cases; ties go to the first listed. */
  private async autoAssignee(tx: Tx, categoryId: string, employeeMembershipId: string | null): Promise<string | null> {
    const r = await one<{ membership_id: string }>(
      tx,
      `select h.membership_id from helpdesk_category_handlers h join memberships m on m.id = h.membership_id and m.status = 'active'
        where h.category_id = $1 and h.membership_id is distinct from $2
        order by (select count(*) from helpdesk_cases c where c.assignee_membership_id = h.membership_id and c.status not in ('resolved', 'closed')), h.position
        limit 1`,
      [categoryId, employeeMembershipId],
    );
    return r?.membership_id ?? null;
  }

  // Categories and articles -----------------------------------------------------------------------------------

  async categories(withHandlers = false) {
    return this.db.tenant(async (tx) => {
      if (withHandlers) await this.authz.require('helpdesk:configure', undefined, tx);
      const rows = await many<Record<string, unknown> & { id: string }>(
        tx,
        `select k.id, k.name, k.description, k.confidential, k.first_response_hours as "firstResponseHours", k.resolution_hours as "resolutionHours",
                k.archived_at as "archivedAt",
                (select count(*)::int from helpdesk_articles a where a.category_id = k.id and a.published) as "articleCount"
           from helpdesk_categories k where $1 or k.archived_at is null order by k.archived_at nulls first, k.name`,
        [withHandlers],
      );
      if (!withHandlers) return rows;
      const handlers = await many<{ category_id: string; membership_id: string; name: string }>(
        tx,
        `select h.category_id, h.membership_id, coalesce(nullif(${nameOf('e')}, ''), u.full_name) as name
           from helpdesk_category_handlers h join memberships m on m.id = h.membership_id join users u on u.id = m.user_id
           left join employees e on e.id = m.employee_id order by h.position`,
      );
      return rows.map((r) => ({ ...r, handlers: handlers.filter((h) => h.category_id === r.id).map((h) => ({ membershipId: h.membership_id, name: h.name })) }));
    });
  }

  /** Members who can be named as handlers or assignees: everyone holding `helpdesk:manage`. */
  async handlers() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!hasPermission(s, 'helpdesk:manage').allowed && !hasPermission(s, 'helpdesk:configure').allowed) throw Errors.forbidden();
      return many(
        tx,
        `select distinct m.id as "membershipId", coalesce(nullif(${nameOf('e')}, ''), u.full_name) as name, rp.scope
           from memberships m join users u on u.id = m.user_id left join employees e on e.id = m.employee_id
           join role_assignments ra on ra.membership_id = m.id join role_permissions rp on rp.role_id = ra.role_id and rp.permission = 'helpdesk:manage'
          where m.status = 'active' order by name`,
      );
    });
  }

  private async setHandlers(tx: Tx, categoryId: string, ids: string[]) {
    const valid = await many<{ id: string }>(
      tx,
      `select m.id from memberships m join role_assignments ra on ra.membership_id = m.id
         join role_permissions rp on rp.role_id = ra.role_id and rp.permission = 'helpdesk:manage'
        where m.id = any($1::uuid[]) and m.status = 'active'`,
      [ids],
    );
    const ok = new Set(valid.map((v) => v.id));
    const bad = ids.find((i) => !ok.has(i));
    if (bad) throw Errors.badRequest('not_a_handler', 'Every handler needs a role that can handle helpdesk cases');
    await tx.query('delete from helpdesk_category_handlers where category_id = $1', [categoryId]);
    let pos = 0;
    for (const id of [...new Set(ids)]) {
      await tx.query('insert into helpdesk_category_handlers (tenant_id, category_id, membership_id, position) values (app_tenant_id(), $1, $2, $3)', [categoryId, id, pos++]);
    }
  }

  async createCategory(input: CategoryInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      const r = await one<{ id: string }>(
        tx,
        `insert into helpdesk_categories (tenant_id, name, description, confidential, first_response_hours, resolution_hours)
         values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [input.name, input.description, input.confidential, input.firstResponseHours, input.resolutionHours],
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('category_exists', 'A category with this name already exists');
        throw err;
      });
      await this.setHandlers(tx, r!.id, input.handlerMembershipIds);
      await this.audit.record(tx, { action: 'helpdesk.category_created', resourceType: 'helpdesk_category', resourceId: r!.id, changes: { name: input.name, confidential: input.confidential, handlers: input.handlerMembershipIds.length } });
      return r;
    });
  }

  async updateCategory(id: string, input: CategoryInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      const before = await one<{ confidential: boolean }>(tx, 'select confidential from helpdesk_categories where id = $1 and archived_at is null', [id]);
      if (!before) throw Errors.notFound('Category');
      // Existing cases keep the confidentiality they were raised with, so nobody suddenly gains or loses sight of them.
      await tx.query(
        `update helpdesk_categories set name = $2, description = $3, confidential = $4, first_response_hours = $5, resolution_hours = $6 where id = $1`,
        [id, input.name, input.description, input.confidential, input.firstResponseHours, input.resolutionHours],
      ).catch((err: { code?: string }) => {
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
      const r = await tx.query('update helpdesk_categories set archived_at = now() where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Category');
      await this.audit.record(tx, { action: 'helpdesk.category_archived', resourceType: 'helpdesk_category', resourceId: id });
      return { id };
    });
  }

  async articles(q: { categoryId?: string; q?: string; all?: boolean }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const all = q.all === true && hasPermission(s, 'helpdesk:configure').allowed;
      return many(
        tx,
        `select a.id, a.category_id as "categoryId", k.name as "categoryName", a.title, left(a.body, 240) as excerpt, a.published, a.updated_at as "updatedAt"
           from helpdesk_articles a left join helpdesk_categories k on k.id = a.category_id
          where ($1 or a.published) and ($2::uuid is null or a.category_id = $2)
            and ($3::text is null or a.title ilike '%' || $3 || '%' or a.body ilike '%' || $3 || '%')
          order by a.title limit 200`,
        [all, q.categoryId ?? null, q.q?.replace(/[%_\\]/g, (m) => `\\${m}`) || null],
      );
    });
  }

  async article(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const a = await one<{ published: boolean }>(
        tx,
        `select a.id, a.category_id as "categoryId", k.name as "categoryName", a.title, a.body, a.published, a.updated_at as "updatedAt"
           from helpdesk_articles a left join helpdesk_categories k on k.id = a.category_id where a.id = $1`,
        [id],
      );
      if (!a || (!a.published && !hasPermission(s, 'helpdesk:configure').allowed)) throw Errors.notFound('Article');
      return a;
    });
  }

  async saveArticle(id: string | null, input: ArticleInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      const s = await this.authz.subject(tx);
      if (input.categoryId && !(await one(tx, 'select 1 from helpdesk_categories where id = $1', [input.categoryId]))) throw Errors.badRequest('unknown_category', 'Choose an existing category');
      if (id) {
        const r = await tx.query(`update helpdesk_articles set category_id = $2, title = $3, body = $4, published = $5, updated_by_membership_id = $6 where id = $1`, [id, input.categoryId, input.title, input.body, input.published, s.membershipId]);
        if (!r.rowCount) throw Errors.notFound('Article');
      } else {
        id = (await one<{ id: string }>(tx, `insert into helpdesk_articles (tenant_id, category_id, title, body, published, updated_by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
          [input.categoryId, input.title, input.body, input.published, s.membershipId]))!.id;
      }
      await this.audit.record(tx, { action: 'helpdesk.article_saved', resourceType: 'helpdesk_article', resourceId: id, changes: { title: input.title, published: input.published } });
      return { id };
    });
  }

  async removeArticle(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:configure', undefined, tx);
      const r = await tx.query('delete from helpdesk_articles where id = $1', [id]);
      if (!r.rowCount) throw Errors.notFound('Article');
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
        const rows = await many<Record<string, unknown>>(
          tx,
          `select ${CASE_COLS} from ${CASE_FROM} where c.employee_id = $1
             and (case when $2 = 'active' then c.status <> 'closed' else c.status = $2 end) order by c.created_at desc limit 200`,
          [s.employeeId, status],
        );
        return rows.map(decorate);
      }
      if (!hasPermission(s, 'helpdesk:manage').allowed) throw Errors.forbidden();
      const params: unknown[] = [s.membershipId, s.employeeId ?? null, status, q.assigned ?? 'all', q.q ? q.q.replace(/[%_\\]/g, (m) => `\\${m}`) : null];
      const pred = await this.authz.predicate('helpdesk:manage', EMPLOYEE_SCOPE, params, tx);
      const rows = await many<Record<string, unknown>>(
        tx,
        `select ${CASE_COLS} from ${CASE_FROM}
          where c.employee_id is distinct from $2
            and (case when c.confidential then exists (select 1 from helpdesk_category_handlers h where h.category_id = c.category_id and h.membership_id = $1)
                      else (${pred}) or c.assignee_membership_id = $1 end)
            and (case when $3 = 'active' then c.status <> 'closed' else c.status = $3 end)
            and (case $4 when 'me' then c.assignee_membership_id = $1 when 'unassigned' then c.assignee_membership_id is null else true end)
            and ($5::text is null or c.subject ilike '%' || $5 || '%' or ${nameOf('e')} ilike '%' || $5 || '%' or ('HR-' || lpad(c.number::text, 4, '0')) ilike '%' || $5 || '%')
          order by case c.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                   coalesce(c.first_responded_at, c.first_response_due_at, c.created_at), c.created_at
          limit 500`,
        params,
      );
      return rows.map(decorate);
    });
  }

  async create(input: CaseInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const k = await one<{ id: string; name: string; confidential: boolean; first_response_hours: number | null; resolution_hours: number | null }>(
        tx, 'select id, name, confidential, first_response_hours, resolution_hours from helpdesk_categories where id = $1 and archived_at is null', [input.categoryId],
      );
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
      const number = (await one<{ n: number }>(
        tx,
        `insert into helpdesk_counters (tenant_id, last_number) values (app_tenant_id(), 1)
         on conflict (tenant_id) do update set last_number = helpdesk_counters.last_number + 1 returning last_number as n`,
      ))!.n;
      const now = Date.now();
      const fr = helpdeskMath.dueAt(now, k.first_response_hours, input.priority);
      const res = helpdeskMath.dueAt(now, k.resolution_hours, input.priority);
      const assignee = await this.autoAssignee(tx, k.id, e.membership_id);
      const c = (await one<{ id: string }>(
        tx,
        `insert into helpdesk_cases (tenant_id, number, employee_id, requester_membership_id, raised_by_membership_id, category_id, confidential, subject,
                                     description, priority, assignee_membership_id, first_response_due_at, resolution_due_at, created_at)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [number, e.id, e.membership_id, s.membershipId, k.id, k.confidential, input.subject, input.description, input.priority, assignee,
          fr ? new Date(fr) : null, res ? new Date(res) : null, new Date(now)],
      ))!;
      await this.event(tx, c.id, s.membershipId, 'created', null, 'open');
      if (assignee) await this.event(tx, c.id, null, 'assigned', null, assignee);
      // The subject is not audited: case content stays in the helpdesk, where only handlers can read it.
      await this.audit.record(tx, { action: 'helpdesk.case_created', resourceType: 'helpdesk_case', resourceId: c.id, metadata: { ref: caseRef(number), category: k.name, confidential: k.confidential, onBehalf: e.id !== s.employeeId } });
      const notifyIds = assignee ? [assignee] : k.confidential ? await this.handlersOf(tx, k.id) : [];
      await this.notifications.notify(tx, { membershipIds: notifyIds, kind: 'helpdesk.case_new', title: `New helpdesk case ${caseRef(number)} in ${k.name}`, link: `/helpdesk/${c.id}` });
      if (e.id !== s.employeeId) {
        await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'helpdesk.case_logged', title: `HR logged case ${caseRef(number)} for you`, link: `/helpdesk/${c.id}` });
      }
      return { id: c.id, ref: caseRef(number) };
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      const row = (await one<Record<string, unknown>>(tx, `select ${CASE_COLS}, c.description, c.raised_by_membership_id as "raisedByMembershipId" from ${CASE_FROM} where c.id = $1`, [id]))!;
      const messages = await many(
        tx,
        `select x.id, x.body, x.internal, x.created_at as "createdAt", x.author_membership_id as "authorMembershipId",
                coalesce(nullif(${nameOf('e')}, ''), u.full_name) as "authorName", (x.author_membership_id = $3) as mine,
                (x.author_membership_id is distinct from $2) as "fromHr"
           from helpdesk_messages x join memberships m on m.id = x.author_membership_id join users u on u.id = m.user_id
           left join employees e on e.id = m.employee_id
          where x.case_id = $1 and ($4 or not x.internal) order by x.created_at`,
        [id, c.requester_membership_id, s.membershipId, role === 'handler'],
      );
      const history = role === 'handler'
        ? await many(
            tx,
            `select v.action, v.from_value as "from", v.to_value as "to", v.created_at as "createdAt",
                    coalesce(nullif(${nameOf('e')}, ''), u.full_name) as "byName",
                    case when v.action = 'assigned' then (select coalesce(nullif(${nameOf('e2')}, ''), u2.full_name) from memberships m2 join users u2 on u2.id = m2.user_id left join employees e2 on e2.id = m2.employee_id where m2.id::text = v.to_value) end as "toName"
               from helpdesk_events v left join memberships m on m.id = v.by_membership_id left join users u on u.id = m.user_id left join employees e on e.id = m.employee_id
              where v.case_id = $1 order by v.created_at`,
            [id],
          )
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

  async reply(id: string, body: string, internal: boolean) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed. Raise a new case if you still need help.');
      if (internal && role !== 'handler') throw Errors.forbidden('Only HR can add internal notes');
      await tx.query(`insert into helpdesk_messages (tenant_id, case_id, author_membership_id, body, internal) values (app_tenant_id(), $1, $2, $3, $4)`, [id, s.membershipId, body, internal]);
      const ref = caseRef(c.number);
      if (role === 'handler' && !internal) {
        // The first public reply counts as the first response, starts work on an open case and, if nobody has the
        // case yet, makes the person replying its assignee.
        await tx.query(
          `update helpdesk_cases set first_responded_at = coalesce(first_responded_at, now()),
                  status = case when status = 'open' then 'in_progress' else status end,
                  assignee_membership_id = coalesce(assignee_membership_id, $2) where id = $1`,
          [id, s.membershipId],
        );
        if (c.status === 'open') await this.event(tx, id, s.membershipId, 'status', 'open', 'in_progress');
        if (!c.assignee_membership_id) await this.event(tx, id, s.membershipId, 'assigned', null, s.membershipId);
        await this.notifications.notify(tx, { membershipIds: [c.requester_membership_id], kind: 'helpdesk.reply', title: `HR replied on ${ref}`, link: `/helpdesk/${id}`, email: true });
      } else if (role === 'requester') {
        if (c.status === 'waiting_on_employee') {
          await tx.query(`update helpdesk_cases set status = 'in_progress' where id = $1`, [id]);
          await this.event(tx, id, s.membershipId, 'status', c.status, 'in_progress');
        } else await tx.query('update helpdesk_cases set updated_at = now() where id = $1', [id]);
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
      if (message?.trim()) await tx.query(`insert into helpdesk_messages (tenant_id, case_id, author_membership_id, body, internal) values (app_tenant_id(), $1, $2, $3, false)`, [id, s.membershipId, message.trim()]);
      const reopen = status === 'open' || (status === 'in_progress' && c.status === 'resolved');
      await tx.query(
        `update helpdesk_cases set status = $2,
            resolved_at = case when $2 = 'resolved' then now() when $3 then null else resolved_at end,
            closed_at = case when $2 = 'closed' then now() else closed_at end,
            first_responded_at = case when $4 and first_responded_at is null and $2 <> 'closed' then now() else first_responded_at end,
            reopened_count = reopened_count + case when $3 then 1 else 0 end
          where id = $1`,
        [id, status, reopen, role === 'handler'],
      );
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
        const m = await one<{ user_id: string; employee_id: string | null }>(tx, `select user_id, employee_id from memberships where id = $1 and status = 'active'`, [assigneeMembershipId]);
        if (!m) throw Errors.badRequest('unknown_assignee', 'Choose an active member');
        const them = await loadSubject(tx, assigneeMembershipId, m.user_id, true);
        if (!(await this.mayHandle(tx, them, { ...c, assignee_membership_id: null }))) {
          throw Errors.badRequest('assignee_cannot_handle', c.confidential ? 'Only the handlers of this confidential category can take the case.' : 'This person cannot handle cases for this employee.');
        }
      }
      await tx.query('update helpdesk_cases set assignee_membership_id = $2 where id = $1', [id, assigneeMembershipId]);
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
      const k = (await one<{ first_response_hours: number | null; resolution_hours: number | null }>(tx, 'select first_response_hours, resolution_hours from helpdesk_categories where id = $1', [c.category_id]))!;
      const start = new Date(c.created_at).getTime();
      const fr = helpdeskMath.dueAt(start, k.first_response_hours, priority);
      const res = helpdeskMath.dueAt(start, k.resolution_hours, priority);
      await tx.query('update helpdesk_cases set priority = $2, first_response_due_at = $3, resolution_due_at = $4 where id = $1', [id, priority, fr ? new Date(fr) : null, res ? new Date(res) : null]);
      await this.event(tx, id, s.membershipId, 'priority', c.priority, priority);
      return { priority };
    });
  }

  async setCategory(id: string, categoryId: string) {
    return this.db.tenant(async (tx) => {
      const { c, role, s } = await this.load(tx, id);
      if (role !== 'handler') throw Errors.forbidden();
      if (c.status === 'closed') throw Errors.conflict('case_closed', 'This case is closed.');
      const k = await one<{ id: string; name: string; confidential: boolean; first_response_hours: number | null; resolution_hours: number | null }>(
        tx, 'select id, name, confidential, first_response_hours, resolution_hours from helpdesk_categories where id = $1 and archived_at is null', [categoryId],
      );
      if (!k) throw Errors.badRequest('unknown_category', 'Choose one of the helpdesk categories');
      const start = new Date(c.created_at).getTime();
      const fr = helpdeskMath.dueAt(start, k.first_response_hours, c.priority);
      const res = helpdeskMath.dueAt(start, k.resolution_hours, c.priority);
      // A case moved into a confidential category becomes confidential, and goes to that category's handlers.
      const confidential = c.confidential || k.confidential;
      const keepAssignee = c.assignee_membership_id && (!confidential || (await this.handlersOf(tx, k.id)).includes(c.assignee_membership_id));
      const employeeMembership = (await talentEmployee(tx, c.employee_id)).membership_id;
      const assignee = keepAssignee ? c.assignee_membership_id : await this.autoAssignee(tx, k.id, employeeMembership);
      await tx.query(
        'update helpdesk_cases set category_id = $2, confidential = $3, first_response_due_at = $4, resolution_due_at = $5, assignee_membership_id = $6 where id = $1',
        [id, k.id, confidential, fr ? new Date(fr) : null, res ? new Date(res) : null, assignee],
      );
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
      const done = await one(tx, 'select 1 from helpdesk_cases where id = $1 and satisfaction is not null', [id]);
      if (done) throw Errors.conflict('already_rated', 'You have already rated this case.');
      await tx.query('update helpdesk_cases set satisfaction = $2, satisfaction_comment = $3 where id = $1', [id, rating, comment || null]);
      await this.event(tx, id, s.membershipId, 'rated', null, String(rating));
      return { rating };
    });
  }

  /** Closes cases resolved more than AUTO_CLOSE_DAYS ago that the person neither confirmed nor reopened. */
  async autoClose(tx: Tx): Promise<number> {
    const rows = await many<{ id: string }>(
      tx,
      `update helpdesk_cases set status = 'closed', closed_at = now()
        where status = 'resolved' and resolved_at < now() - make_interval(days => $1) returning id`,
      [helpdeskMath.AUTO_CLOSE_DAYS],
    );
    for (const r of rows) await this.event(tx, r.id, null, 'status', 'resolved', 'closed');
    return rows.length;
  }

  /** Counts for the Web Portal and mobile home screens. */
  async summary() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const mine = s.employeeId
        ? (await one<{ open: number; waiting: number; resolved: number }>(
            tx,
            `select count(*) filter (where status in ('open', 'in_progress'))::int as open, count(*) filter (where status = 'waiting_on_employee')::int as waiting,
                    count(*) filter (where status = 'resolved')::int as resolved from helpdesk_cases where employee_id = $1`,
            [s.employeeId],
          ))!
        : { open: 0, waiting: 0, resolved: 0 };
      const assigned = hasPermission(s, 'helpdesk:manage').allowed
        ? (await one<{ n: number }>(tx, `select count(*)::int as n from helpdesk_cases where assignee_membership_id = $1 and status in ('open', 'in_progress')`, [s.membershipId]))!.n
        : null;
      return { mine, assignedToMe: assigned };
    });
  }
}

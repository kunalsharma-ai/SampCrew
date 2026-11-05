import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { onboardingTemplateInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';

interface TemplateTask {
  title: string;
  description?: string;
  owner: 'hr' | 'manager' | 'employee' | 'it';
  dueOffsetDays: number;
}

const TASK_COLUMNS = `t.id, t.employee_id as "employeeId", t.title, t.description, t.owner, t.assignee_membership_id as "assigneeMembershipId",
  au.full_name as "assigneeName", t.due_on as "dueOn", t.status, t.completed_at as "completedAt", cu.full_name as "completedBy", t.sort,
  trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName", e.employee_code as "employeeCode",
  (t.status = 'open' and t.due_on < current_date) as "overdue"`;
const TASK_FROM = `from onboarding_tasks t
  join employees e on e.id = t.employee_id
  left join memberships am on am.id = t.assignee_membership_id left join users au on au.id = am.user_id
  left join memberships cm on cm.id = t.completed_by_membership_id left join users cu on cu.id = cm.user_id`;

/**
 * Onboarding checklists. A template is copied into concrete tasks when someone is hired, each assigned to a
 * person: the hiring HR user, the new joiner's manager, the joiner themselves, or the IT queue (HR admins).
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  listTemplates() {
    return this.db.tenant((tx) =>
      many(tx, `select id, name, description, tasks, is_default as "isDefault", created_at as "createdAt" from onboarding_templates where archived_at is null order by is_default desc, name`),
    );
  }

  async createTemplate(input: z.infer<typeof onboardingTemplateInput>) {
    return this.db.tenant(async (tx) => {
      if (input.isDefault) await tx.query('update onboarding_templates set is_default = false where is_default');
      const row = (await one<{ id: string }>(
        tx, `insert into onboarding_templates (tenant_id, name, description, tasks, is_default) values (app_tenant_id(), $1, $2, $3, $4) returning id`,
        [input.name, input.description ?? null, JSON.stringify(input.tasks), input.isDefault],
      ))!;
      await this.audit.record(tx, { action: 'onboarding_template.created', resourceType: 'onboarding_template', resourceId: row.id, changes: { name: input.name, tasks: input.tasks.length } });
      return { id: row.id, ...input };
    });
  }

  async updateTemplate(id: string, input: z.infer<typeof onboardingTemplateInput>) {
    return this.db.tenant(async (tx) => {
      const before = await one(tx, 'select 1 from onboarding_templates where id = $1 and archived_at is null for update', [id]);
      if (!before) throw Errors.notFound('Onboarding template');
      if (input.isDefault) await tx.query('update onboarding_templates set is_default = false where is_default and id <> $1', [id]);
      await tx.query('update onboarding_templates set name = $2, description = $3, tasks = $4, is_default = $5 where id = $1', [id, input.name, input.description ?? null, JSON.stringify(input.tasks), input.isDefault]);
      await this.audit.record(tx, { action: 'onboarding_template.updated', resourceType: 'onboarding_template', resourceId: id, changes: { name: input.name, tasks: input.tasks.length } });
      return { id, ...input };
    });
  }

  async archiveTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update onboarding_templates set archived_at = now(), is_default = false where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Onboarding template');
      await this.audit.record(tx, { action: 'onboarding_template.archived', resourceType: 'onboarding_template', resourceId: id });
    });
  }

  /** Copies a template's tasks onto a new joiner. Runs inside the hiring transaction. */
  async instantiate(tx: Tx, employeeId: string, templateId: string) {
    const tpl = await one<{ tasks: TemplateTask[] }>(tx, 'select tasks from onboarding_templates where id = $1 and archived_at is null', [templateId]);
    if (!tpl) throw Errors.badRequest('invalid_template', 'Onboarding template not found');
    const e = (await one<{ membership_id: string | null; manager_membership_id: string | null; date_of_joining: string }>(
      tx, `select e.membership_id, mgr.membership_id as manager_membership_id, e.date_of_joining from employees e
             left join employees mgr on mgr.id = e.current_manager_employee_id where e.id = $1`, [employeeId],
    ))!;
    const hr = requestContext.tenantActor().membershipId;
    for (const [i, t] of tpl.tasks.entries()) {
      const assignee = t.owner === 'manager' ? e.manager_membership_id ?? hr : t.owner === 'employee' ? e.membership_id : t.owner === 'hr' ? hr : null;
      await tx.query(
        `insert into onboarding_tasks (tenant_id, employee_id, template_id, title, description, owner, assignee_membership_id, due_on, sort)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7::date + $8::int, $9)`,
        [employeeId, templateId, t.title, t.description ?? null, t.owner, assignee, e.date_of_joining, t.dueOffsetDays ?? 0, i],
      );
    }
    const others = [...new Set(tpl.tasks.filter((t) => t.owner === 'manager').map(() => e.manager_membership_id))].filter((m) => m && m !== hr);
    await this.notifications.notify(tx, { membershipIds: others, kind: 'onboarding.assigned', title: 'You have onboarding tasks for a new joiner', link: '/tasks' });
  }

  /** Employee's tasks pick up the login once the invitation creates it. */
  async assignEmployeeTasks(tx: Tx, employeeId: string, membershipId: string) {
    await tx.query(`update onboarding_tasks set assignee_membership_id = $2 where employee_id = $1 and owner = 'employee' and assignee_membership_id is null`, [employeeId, membershipId]);
  }

  /** Tasks for one employee. Visible to people who can read the employee record. */
  async forEmployee(employeeId: string) {
    return this.db.tenant(async (tx) => {
      await this.requireEmployee(tx, employeeId, 'employees:read');
      return many(tx, `select ${TASK_COLUMNS} ${TASK_FROM} where t.employee_id = $1 order by t.sort`, [employeeId]);
    });
  }

  /** Open tasks assigned to me, plus unassigned IT tasks when I can manage employees. */
  async mine() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const itQueue = grantsFor(s, 'employees:update').some((g) => g.scope === 'tenant');
      return many(
        tx,
        `select ${TASK_COLUMNS} ${TASK_FROM}
          where t.status = 'open' and (t.assignee_membership_id = $1 or ($2 and t.assignee_membership_id is null and t.owner = 'it'))
          order by t.due_on nulls last, t.sort limit 200`,
        [actor.membershipId, itQueue],
      );
    });
  }

  async setStatus(taskId: string, status: 'open' | 'done' | 'skipped') {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const t = await one<{ id: string; employee_id: string; assignee_membership_id: string | null; owner: string; status: string; title: string }>(
        tx, 'select id, employee_id, assignee_membership_id, owner, status, title from onboarding_tasks where id = $1 for update', [taskId],
      );
      if (!t) throw Errors.notFound('Task');
      // The assignee can complete their own task; anyone who can update the employee can complete any of theirs.
      if (t.assignee_membership_id !== actor.membershipId) await this.requireEmployee(tx, t.employee_id, 'employees:update', true);
      if (status === 'skipped' && t.assignee_membership_id === actor.membershipId && t.owner === 'employee') {
        await this.requireEmployee(tx, t.employee_id, 'employees:update', true);
      }
      await tx.query(
        `update onboarding_tasks set status = $2, completed_by_membership_id = case when $2 = 'open' then null else $3::uuid end,
            completed_at = case when $2 = 'open' then null else now() end where id = $1`,
        [taskId, status, actor.membershipId],
      );
      await this.audit.record(tx, { action: `onboarding_task.${status === 'open' ? 'reopened' : status}`, resourceType: 'employee', resourceId: t.employee_id, metadata: { taskId, title: t.title } });
      return one(tx, `select ${TASK_COLUMNS} ${TASK_FROM} where t.id = $1`, [taskId]);
    });
  }

  private async requireEmployee(tx: Tx, employeeId: string, permission: string, broadOnly = false) {
    const e = await one<{ id: string; membership_id: string | null; le: string | null; d: string | null; l: string | null }>(
      tx, `select id, membership_id, current_legal_entity_id as le, current_department_id as d, current_location_id as l from employees where id = $1`, [employeeId],
    );
    if (!e) throw Errors.notFound('Employee');
    const attrs = { employeeId: e.id, membershipId: e.membership_id, legalEntityId: e.le, departmentId: e.d, locationId: e.l };
    if (broadOnly) {
      const s = await this.authz.subject(tx);
      if (!grantsFor(s, permission).some((g) => g.scope !== 'own' && grantCovers(s, g, attrs))) {
        await this.authz.require('employees:read', attrs, tx); // not found when they cannot see the employee at all
        throw Errors.forbidden();
      }
      return;
    }
    await this.authz.require(permission, attrs, tx);
  }
}

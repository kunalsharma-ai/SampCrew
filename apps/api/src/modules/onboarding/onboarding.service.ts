import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { onboardingTemplateInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { employeeNames } from '../employees/employee-view';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';

interface TemplateTask {
  title: string;
  description?: string;
  owner: 'hr' | 'manager' | 'employee' | 'it';
  dueOffsetDays: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Onboarding tasks as the API shows them: assignee and completer names, the joiner, and whether it is overdue. */
async function taskViews(tx: TenantTx, tasks: Doc[]) {
  const people = await employeeNames(tx, tasks.map((t) => t.employee_id));
  const names = await membershipUserNames(tx, tasks.flatMap((t) => [t.assignee_membership_id, t.completed_by_membership_id]));
  const today = new Date().toISOString().slice(0, 10);
  return tasks
    .filter((t) => people.has(t.employee_id))
    .map((t) => ({
      id: t.id,
      employeeId: t.employee_id,
      title: t.title,
      description: t.description ?? null,
      owner: t.owner,
      assigneeMembershipId: t.assignee_membership_id ?? null,
      assigneeName: names.get(t.assignee_membership_id) ?? null,
      dueOn: t.due_on ?? null,
      status: t.status,
      completedAt: t.completed_at ?? null,
      completedBy: names.get(t.completed_by_membership_id) ?? null,
      sort: t.sort,
      employeeName: people.get(t.employee_id)!.name,
      employeeCode: people.get(t.employee_id)!.doc.employee_code,
      overdue: t.status === 'open' && !!t.due_on && t.due_on < today,
    }));
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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
    return this.db.tenant(async (tx) =>
      (await tx.collection('onboarding_templates').find({ archived_at: null }, { sort: { is_default: -1, name: 1 } })).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? null,
        tasks: t.tasks,
        isDefault: t.is_default,
        createdAt: t.created_at,
      })),
    );
  }

  async createTemplate(input: z.infer<typeof onboardingTemplateInput>) {
    return this.db.tenant(async (tx) => {
      if (input.isDefault) await tx.collection('onboarding_templates').update({ is_default: true }, { $set: { is_default: false } });
      const row = await tx.collection('onboarding_templates').insert({ name: input.name, description: input.description ?? null, tasks: input.tasks, is_default: input.isDefault });
      await this.audit.record(tx, { action: 'onboarding_template.created', resourceType: 'onboarding_template', resourceId: row.id, changes: { name: input.name, tasks: input.tasks.length } });
      return { id: row.id, ...input };
    });
  }

  async updateTemplate(id: string, input: z.infer<typeof onboardingTemplateInput>) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('onboarding_templates').exists({ id, archived_at: null }))) throw Errors.notFound('Onboarding template');
      if (input.isDefault) await tx.collection('onboarding_templates').update({ is_default: true, id: { $ne: id } }, { $set: { is_default: false } });
      await tx.collection('onboarding_templates').updateOne({ id }, { $set: { name: input.name, description: input.description ?? null, tasks: input.tasks, is_default: input.isDefault } });
      await this.audit.record(tx, { action: 'onboarding_template.updated', resourceType: 'onboarding_template', resourceId: id, changes: { name: input.name, tasks: input.tasks.length } });
      return { id, ...input };
    });
  }

  async archiveTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      const n = await tx.collection('onboarding_templates').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date(), is_default: false } });
      if (!n) throw Errors.notFound('Onboarding template');
      await this.audit.record(tx, { action: 'onboarding_template.archived', resourceType: 'onboarding_template', resourceId: id });
    });
  }

  /** Copies a template's tasks onto a new joiner. Runs inside the hiring transaction. */
  async instantiate(tx: TenantTx, employeeId: string, templateId: string) {
    const tpl = (await tx.collection('onboarding_templates').findOne({ id: templateId, archived_at: null })) as { tasks: TemplateTask[] } | undefined;
    if (!tpl) throw Errors.badRequest('invalid_template', 'Onboarding template not found');
    const joiner = (await tx.collection('employees').findOne({ id: employeeId }))!;
    const mgr = joiner.current_manager_employee_id ? await tx.collection('employees').findOne({ id: joiner.current_manager_employee_id }) : undefined;
    const e = { membership_id: (joiner.membership_id as string | null) ?? null, manager_membership_id: (mgr?.membership_id as string | null | undefined) ?? null, date_of_joining: joiner.date_of_joining as string };
    const hr = requestContext.tenantActor().membershipId;
    for (const [i, t] of tpl.tasks.entries()) {
      const assignee = t.owner === 'manager' ? e.manager_membership_id ?? hr : t.owner === 'employee' ? e.membership_id : t.owner === 'hr' ? hr : null;
      await tx.collection('onboarding_tasks').insert({
        employee_id: employeeId,
        template_id: templateId,
        title: t.title,
        description: t.description ?? null,
        owner: t.owner,
        assignee_membership_id: assignee,
        due_on: addDays(e.date_of_joining, t.dueOffsetDays ?? 0),
        sort: i,
      });
    }
    const others = [...new Set(tpl.tasks.filter((t) => t.owner === 'manager').map(() => e.manager_membership_id))].filter((m) => m && m !== hr);
    await this.notifications.notify(tx, { membershipIds: others, kind: 'onboarding.assigned', title: 'You have onboarding tasks for a new joiner', link: '/tasks' });
  }

  /** Employee's tasks pick up the login once the invitation creates it. */
  async assignEmployeeTasks(tx: TenantTx, employeeId: string, membershipId: string) {
    await tx.collection('onboarding_tasks').update({ employee_id: employeeId, owner: 'employee', assignee_membership_id: null }, { $set: { assignee_membership_id: membershipId } });
  }

  /** Tasks for one employee. Visible to people who can read the employee record. */
  async forEmployee(employeeId: string) {
    return this.db.tenant(async (tx) => {
      await this.requireEmployee(tx, employeeId, 'employees:read');
      return taskViews(tx, await tx.collection('onboarding_tasks').find({ employee_id: employeeId }, { sort: { sort: 1 } }));
    });
  }

  /** Open tasks assigned to me, plus unassigned IT tasks when I can manage employees. */
  async mine() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const itQueue = grantsFor(s, 'employees:update').some((g) => g.scope === 'tenant');
      const tasks = await tx.collection('onboarding_tasks').find({
        status: 'open',
        $or: [{ assignee_membership_id: actor.membershipId }, ...(itQueue ? [{ assignee_membership_id: null, owner: 'it' }] : [])],
      });
      // Due date first (undated last), then checklist order.
      tasks.sort((a, b) => (a.due_on ?? '9999') < (b.due_on ?? '9999') ? -1 : (a.due_on ?? '9999') > (b.due_on ?? '9999') ? 1 : a.sort - b.sort);
      return taskViews(tx, tasks.slice(0, 200));
    });
  }

  async setStatus(taskId: string, status: 'open' | 'done' | 'skipped') {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const t = await tx.collection('onboarding_tasks').findOne({ id: taskId });
      if (!t) throw Errors.notFound('Task');
      // The assignee can complete their own task; anyone who can update the employee can complete any of theirs.
      if (t.assignee_membership_id !== actor.membershipId) await this.requireEmployee(tx, t.employee_id, 'employees:update', true);
      if (status === 'skipped' && t.assignee_membership_id === actor.membershipId && t.owner === 'employee') {
        await this.requireEmployee(tx, t.employee_id, 'employees:update', true);
      }
      await tx.collection('onboarding_tasks').updateOne(
        { id: taskId },
        { $set: { status, completed_by_membership_id: status === 'open' ? null : actor.membershipId, completed_at: status === 'open' ? null : new Date() } },
      );
      await this.audit.record(tx, { action: `onboarding_task.${status === 'open' ? 'reopened' : status}`, resourceType: 'employee', resourceId: t.employee_id, metadata: { taskId, title: t.title } });
      return (await taskViews(tx, [(await tx.collection('onboarding_tasks').findOne({ id: taskId }))!]))[0];
    });
  }

  private async requireEmployee(tx: TenantTx, employeeId: string, permission: string, broadOnly = false) {
    const e = await tx.collection('employees').findOne({ id: employeeId });
    if (!e) throw Errors.notFound('Employee');
    const attrs = { employeeId: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null };
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

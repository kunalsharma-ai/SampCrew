import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  displayStatus,
  type documentVerifyInput,
  fileAllowed,
  OPEN_TASK_STATUSES,
  type TaskCategory,
  type TaskDocumentSpec,
  type TaskInput,
  type taskListQuery,
  type taskProgressInput,
  type taskReviewInput,
  type TaskStatus,
  type taskUpdateInput,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, grantCovers, grantsFor, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { DocumentsService, type UploadedFile } from '../documents/documents.service';
import { employeeAttrs, EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Which permission lets someone assign, review and see tasks of a category for people in their scope. */
const CATEGORY_PERMISSION: Record<TaskCategory, string> = { hr: 'tasks:hr', manager: 'tasks:assign' };
const CATEGORY_LABEL: Record<TaskCategory, string> = { hr: 'HR task', manager: 'Manager task' };

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

function attrsOfEmployee(e: Doc) {
  return employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null });
}

/** Covers the employee with a grant wider than their own record (people never assign tasks to themselves). */
function coversOther(s: Subject, permission: string, e: Doc) {
  const attrs = attrsOfEmployee(e);
  return grantsFor(s, permission).some((g) => g.scope !== 'own' && grantCovers(s, g, attrs));
}

/**
 * Employee tasks: HR Tasks and Manager Tasks. HR assigns HR Tasks (forms, acknowledgements, documents to upload);
 * a document the employee uploads is filed in their documents with verification pending, and HR verifies it through
 * the approvals engine ('document_verification'), so it also shows in Approvals. The reporting manager (or anyone
 * whose tasks:assign covers the person) assigns Manager Tasks and accepts or reopens them. Every change is kept in
 * the task's history and in the audit trail.
 */
@Injectable()
export class TasksService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit() {
    this.approvals.register('document_verification', {
      permission: 'tasks:hr',
      configurePermission: 'tasks:hr',
      defaultSteps: [{ type: 'role', role: 'hr_admin' }],
      fallbackRole: 'hr_admin',
      label: 'Document verification',
      link: (taskId) => `/tasks/${taskId}`,
      attributes: async (tx, taskId) => {
        const t = await tx.collection('employee_tasks').findOne({ id: taskId });
        const e = t && (await tx.collection('employees').findOne({ id: t.employee_id }));
        if (!e) throw Errors.notFound('Task');
        return attrsOfEmployee(e);
      },
      details: async (tx, taskId) => {
        const t = await tx.collection('employee_tasks').findOne({ id: taskId });
        const d = t?.document_id ? await tx.collection('employee_documents').findOne({ id: t.document_id }) : undefined;
        return t ? { task: t.title, document: d?.title ?? null, fileName: d?.file_name ?? null, documentId: d?.id ?? null, submittedAt: t.submitted_at ?? null } : null;
      },
      // The uploaded file itself, so the approver can open and download it from Approvals (the same signed,
      // audited download the task page uses).
      documents: async (tx, taskId) => {
        const t = await tx.collection('employee_tasks').findOne({ id: taskId }, { projection: { document_id: 1 } });
        const d = t?.document_id ? await tx.collection('employee_documents').findOne({ id: t.document_id }, { projection: { id: 1, title: 1, file_name: 1 } }) : undefined;
        return d ? [{ name: (d.file_name as string | null) ?? (d.title as string | null) ?? 'Document', href: `/files/${d.id}` }] : [];
      },
      onApproved: (tx, req) => this.documentDecided(tx, req.resource_id, req.id, 'verified'),
      onRejected: (tx, req) => this.documentDecided(tx, req.resource_id, req.id, 'rejected'),
    });
  }

  // Views ---------------------------------------------------------------------------------------------------------

  private async views(tx: TenantTx, tasks: Doc[], s?: Subject) {
    const people = new Map((await tx.collection('employees').find({ id: { $in: [...new Set(tasks.map((t) => t.employee_id))] } })).map((e) => [e.id as string, e]));
    const names = await membershipUserNames(tx, tasks.flatMap((t) => [t.assigned_by_membership_id, ...(t.history ?? []).map((h: Doc) => h.by)]));
    const depts = await fieldById(tx, 'departments', [...people.values()].map((e) => e.current_department_id));
    const docs = new Map((await tx.collection('employee_documents').find({ id: { $in: tasks.map((t) => t.document_id).filter(Boolean) } })).map((d) => [d.id as string, d]));
    const today = istToday();
    return tasks.map((t) => {
      const e = people.get(t.employee_id);
      const d = t.document_id ? docs.get(t.document_id) : undefined;
      const mine = !!s?.employeeId && s.employeeId === t.employee_id;
      return {
        id: t.id as string,
        category: t.category as TaskCategory,
        kind: t.kind as string,
        title: t.title as string,
        description: (t.description ?? null) as string | null,
        priority: t.priority as string,
        status: t.status as TaskStatus,
        displayStatus: displayStatus(t.status, t.due_on ?? null, today),
        overdue: displayStatus(t.status, t.due_on ?? null, today) === 'overdue',
        isNew: !t.seen_at && t.status === 'new',
        dueOn: (t.due_on ?? null) as string | null,
        assignedAt: t.created_at,
        assignedBy: names.get(t.assigned_by_membership_id) ?? null,
        assignedByMe: t.assigned_by_membership_id === requestContext.tenantActor().membershipId,
        employeeId: t.employee_id as string,
        employeeName: e ? displayName(e as never) : null,
        employeeCode: (e?.employee_code ?? null) as string | null,
        departmentName: depts.get(e?.current_department_id) ?? null,
        employeeRemarks: (t.employee_remarks ?? null) as string | null,
        reviewerRemarks: (t.reviewer_remarks ?? null) as string | null,
        submittedAt: t.submitted_at ?? null,
        completedAt: t.completed_at ?? null,
        acknowledgedAt: t.acknowledged_at ?? null,
        document: t.kind === 'document' ? { spec: t.document_spec as TaskDocumentSpec, ...(d ? {
          id: d.id as string, title: d.title as string, fileName: d.file_name as string, sizeBytes: d.size_bytes as number, contentType: d.content_type as string,
          verificationStatus: (d.verification_status ?? null) as string | null, verificationRemarks: (d.verification_remarks ?? null) as string | null, verifiedAt: d.verified_at ?? null,
        } : { id: null }) } : null,
        verificationRequestId: (t.verification_request_id ?? null) as string | null,
        isMine: mine,
        history: ((t.history ?? []) as Doc[]).map((h) => ({ at: h.at, by: names.get(h.by) ?? null, action: h.action as string, status: (h.status ?? null) as string | null, remarks: (h.remarks ?? null) as string | null })),
      };
    });
  }

  private entry(action: string, status: string | null, remarks?: string | null) {
    return { at: new Date(), by: requestContext.tenantActor().membershipId, action, status, remarks: remarks ?? null };
  }

  private async load(tx: TenantTx, id: string) {
    const t = await tx.collection('employee_tasks').findOne({ id });
    if (!t) throw Errors.notFound('Task');
    const e = (await tx.collection('employees').findOne({ id: t.employee_id }))!;
    const s = await this.authz.subject(tx);
    const isEmployee = !!s.employeeId && s.employeeId === t.employee_id;
    const isAssigner = t.assigned_by_membership_id === requestContext.tenantActor().membershipId;
    const canManage = isAssigner || coversOther(s, CATEGORY_PERMISSION[t.category as TaskCategory], e);
    if (!isEmployee && !canManage) throw Errors.notFound('Task');
    return { t, e, s, isEmployee, canManage: canManage && !isEmployee };
  }

  // Reading -------------------------------------------------------------------------------------------------------

  /** My tasks (scope mine), or the tasks I can manage for other people (scope assigned). */
  async list(q: z.infer<typeof taskListQuery>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const statusFilter =
        q.status === 'open' ? { status: { $in: [...OPEN_TASK_STATUSES] } } : q.status === 'review' ? { status: 'pending_review' } : q.status === 'done' ? { status: { $in: ['completed', 'cancelled'] } } : {};
      const cat = q.category ? { category: q.category } : {};
      if (q.scope === 'mine') {
        if (!s.employeeId) return [];
        const tasks = await tx.collection('employee_tasks').find({ employee_id: s.employeeId, ...cat, ...statusFilter }, { sort: { created_at: -1 }, limit: 300 });
        return this.views(tx, tasks, s);
      }
      // People whose tasks I can manage: by category permission over them, plus anything I assigned.
      const or: Doc[] = [{ assigned_by_membership_id: actor.membershipId }];
      for (const c of ['hr', 'manager'] as TaskCategory[]) {
        if (q.category && q.category !== c) continue;
        if (!grantsFor(s, CATEGORY_PERMISSION[c]).some((g) => g.scope !== 'own')) continue;
        const scope = await this.authz.filter(CATEGORY_PERMISSION[c], EMPLOYEE_FIELDS, tx);
        const ids = await tx.collection('employees').distinct<string>('id', scope);
        or.push({ category: c, employee_id: { $in: ids.filter((id) => id !== s.employeeId) } });
      }
      const tasks = await tx.collection('employee_tasks').find({ $or: or, ...cat, ...statusFilter }, { sort: { created_at: -1 }, limit: 500 });
      return this.views(tx, tasks, s);
    });
  }

  /** Counts for the HR Tasks and Manager Tasks tabs, the menu badge and the home dashboard. */
  async counts() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const out = { hr: { open: 0, new: 0, overdue: 0, review: 0 }, manager: { open: 0, new: 0, overdue: 0, review: 0 }, toReview: 0, documentsToVerify: 0 };
      if (s.employeeId) {
        const today = istToday();
        for (const t of await tx.collection('employee_tasks').find({ employee_id: s.employeeId, status: { $in: [...OPEN_TASK_STATUSES, 'pending_review'] } }, { projection: { category: 1, status: 1, due_on: 1, seen_at: 1 } })) {
          const c = out[t.category as TaskCategory];
          if (t.status === 'pending_review') c.review += 1;
          else c.open += 1;
          if (!t.seen_at && t.status === 'new') c.new += 1;
          if (displayStatus(t.status, t.due_on ?? null, today) === 'overdue') c.overdue += 1;
        }
      }
      const actor = requestContext.tenantActor();
      out.toReview = await tx.collection('employee_tasks').count({ assigned_by_membership_id: actor.membershipId, status: 'pending_review', kind: { $ne: 'document' } });
      if (grantsFor(s, 'tasks:hr').some((g) => g.scope !== 'own')) {
        const scope = await this.authz.filter('tasks:hr', EMPLOYEE_FIELDS, tx);
        const ids = (await tx.collection('employees').distinct<string>('id', scope)).filter((id) => id !== s.employeeId);
        out.documentsToVerify = await tx.collection('employee_tasks').count({ kind: 'document', status: 'pending_review', employee_id: { $in: ids } });
      }
      return out;
    });
  }

  /** People I can give tasks of each category to (never myself), for the assign form. */
  async assignable() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const out: Record<TaskCategory, { id: string; name: string; code: string | null; departmentName: string | null; designationName: string | null }[]> = { hr: [], manager: [] };
      for (const c of ['hr', 'manager'] as TaskCategory[]) {
        if (!grantsFor(s, CATEGORY_PERMISSION[c]).some((g) => g.scope !== 'own')) continue;
        const scope = await this.authz.filter(CATEGORY_PERMISSION[c], EMPLOYEE_FIELDS, tx);
        const rows = (await tx.collection('employees').find({ ...scope, status: { $nin: ['exited'] } }, { sort: { first_name: 1 }, limit: 2000 })).filter((e) => e.id !== s.employeeId);
        const depts = await fieldById(tx, 'departments', rows.map((e) => e.current_department_id));
        const desig = await fieldById(tx, 'designations', rows.map((e) => e.current_designation_id));
        out[c] = rows.map((e) => ({ id: e.id, name: displayName(e as never), code: e.employee_code ?? null, departmentName: depts.get(e.current_department_id) ?? null, designationName: desig.get(e.current_designation_id) ?? null }));
      }
      return out;
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const { t, s, canManage } = await this.load(tx, id);
      const [view] = await this.views(tx, [t], s);
      const trail = t.verification_request_id ? await this.approvals.trail(tx, t.verification_request_id) : [];
      return { ...view!, canManage, approvalTrail: trail };
    });
  }

  // Changes -------------------------------------------------------------------------------------------------------

  async create(input: TaskInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const permission = CATEGORY_PERMISSION[input.category];
      const people = await tx.collection('employees').find({ id: { $in: input.employeeIds } });
      if (people.length !== new Set(input.employeeIds).size) throw Errors.notFound('Employee');
      for (const e of people) {
        if (e.id === s.employeeId) throw Errors.badRequest('self_assign', 'You cannot assign a task to yourself');
        if (!coversOther(s, permission, e)) {
          if (!can(s, 'employees:read', attrsOfEmployee(e)).allowed) throw Errors.notFound('Employee');
          throw Errors.forbidden(input.category === 'hr' ? 'Only HR can assign HR tasks to this person' : 'You can assign Manager tasks only to people in your team');
        }
        if (!e.membership_id) throw Errors.badRequest('no_login', `${displayName(e as never)} has no SampCrew login yet, so they cannot see tasks`);
      }
      const rows = [];
      for (const e of people) {
        const row = await tx.collection('employee_tasks').insert({
          employee_id: e.id, assignee_membership_id: e.membership_id, category: input.category, kind: input.kind, title: input.title, description: input.description ?? null,
          priority: input.priority, due_on: input.dueOn ?? null, document_spec: input.kind === 'document' ? input.document : null, assigned_by_membership_id: actor.membershipId,
          status: 'new', history: [this.entry('assigned', 'new')],
        });
        rows.push(row);
        await this.audit.record(tx, { action: 'task.assigned', resourceType: 'employee', resourceId: e.id, metadata: { taskId: row.id, category: input.category, kind: input.kind, title: input.title } });
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id],
          kind: 'task.assigned',
          title: `New ${input.category === 'hr' ? 'HR task' : 'task from your manager'}: ${input.title}`,
          body: `${actor.label} assigned it to you${input.dueOn ? `, due ${input.dueOn}` : ''}. Priority: ${input.priority}.`,
          link: `/tasks/${row.id}`,
          email: input.priority === 'high' || input.priority === 'urgent',
        });
      }
      return this.views(tx, rows, s);
    });
  }

  async update(id: string, input: z.infer<typeof taskUpdateInput>) {
    return this.db.tenant(async (tx) => {
      const { t, s, canManage } = await this.load(tx, id);
      if (!canManage) throw Errors.forbidden('Only the person who assigned this task, or HR, can change it');
      if (['completed', 'cancelled'].includes(t.status)) throw Errors.conflict('invalid_state', 'This task is closed');
      const set: Doc = {};
      if (input.title !== undefined) set.title = input.title;
      if (input.description !== undefined) set.description = input.description;
      if (input.priority !== undefined) set.priority = input.priority;
      if (input.dueOn !== undefined) set.due_on = input.dueOn;
      if (!Object.keys(set).length) return (await this.views(tx, [t], s))[0];
      await tx.collection('employee_tasks').updateOne({ id }, { $set: set, $push: { history: this.entry('edited', t.status, Object.keys(set).join(', ')) } });
      await this.audit.record(tx, { action: 'task.updated', resourceType: 'employee', resourceId: t.employee_id, metadata: { taskId: id, fields: Object.keys(set) } });
      await this.notifications.notify(tx, { membershipIds: [t.assignee_membership_id], kind: 'task.updated', title: `Task changed: ${set.title ?? t.title}`, link: `/tasks/${id}` });
      return (await this.views(tx, [(await tx.collection('employee_tasks').findOne({ id }))!], s))[0];
    });
  }

  /** The employee opened the task: it is no longer counted as new. */
  async seen(id: string) {
    return this.db.tenant(async (tx) => {
      const { t, isEmployee } = await this.load(tx, id);
      if (isEmployee && !t.seen_at) {
        await tx.collection('employee_tasks').updateOne({ id }, { $set: { seen_at: new Date(), ...(t.status === 'new' ? { status: 'not_started' } : {}) } });
      }
      return { ok: true };
    });
  }

  /** The employee moves their task along, adds remarks, or finishes it. */
  async progress(id: string, input: z.infer<typeof taskProgressInput>) {
    return this.db.tenant(async (tx) => {
      const { t, s, isEmployee } = await this.load(tx, id);
      if (!isEmployee) throw Errors.forbidden('Only the person the task is for can update its progress');
      if (['completed', 'cancelled'].includes(t.status)) throw Errors.conflict('invalid_state', 'This task is closed');
      if (t.kind === 'document' && (input.status === 'pending_review' || input.status === 'completed')) {
        throw Errors.badRequest('upload_required', 'Upload the document; HR verifies it to complete the task');
      }
      if (t.status === 'pending_review' && input.status !== 'pending_review') throw Errors.conflict('invalid_state', 'This task is waiting for review');
      const set: Doc = { status: input.status, employee_remarks: input.remarks ?? t.employee_remarks ?? null, seen_at: t.seen_at ?? new Date() };
      if (input.status === 'completed') {
        set.completed_at = new Date();
        if (t.kind === 'acknowledgement') set.acknowledged_at = new Date();
      }
      if (input.status === 'pending_review') set.submitted_at = new Date();
      await tx.collection('employee_tasks').updateOne({ id }, { $set: set, $push: { history: this.entry(t.kind === 'acknowledgement' && input.status === 'completed' ? 'acknowledged' : 'progress', input.status, input.remarks) } });
      await this.audit.record(tx, { action: `task.${input.status}`, resourceType: 'employee', resourceId: t.employee_id, metadata: { taskId: id } });
      if (input.status === 'pending_review' || input.status === 'completed') {
        await this.notifications.notify(tx, {
          membershipIds: [t.assigned_by_membership_id],
          kind: 'task.updated',
          title: `${displayName((await tx.collection('employees').findOne({ id: t.employee_id })) as never)} ${input.status === 'completed' ? (t.kind === 'acknowledgement' ? 'acknowledged' : 'completed') : 'sent for review'}: ${t.title}`,
          body: input.remarks ?? undefined,
          link: `/tasks/${id}`,
        });
      }
      return (await this.views(tx, [(await tx.collection('employee_tasks').findOne({ id }))!], s))[0];
    });
  }

  /** The assigner (or HR) accepts the work, sends it back with a reason, or cancels the task. */
  async review(id: string, input: z.infer<typeof taskReviewInput>) {
    return this.db.tenant(async (tx) => {
      const { t, s, canManage } = await this.load(tx, id);
      if (!canManage) throw Errors.forbidden('Only the person who assigned this task, or HR, can review it');
      if (t.status === 'cancelled') throw Errors.conflict('invalid_state', 'This task is cancelled');
      if (input.action === 'complete' && t.kind === 'document' && t.status !== 'completed') throw Errors.badRequest('verify_document', 'Verify the uploaded document to complete this task');
      if (input.action === 'complete' && t.status === 'completed') throw Errors.conflict('invalid_state', 'This task is already completed');
      if (input.action === 'reopen' && !['completed', 'pending_review'].includes(t.status)) throw Errors.conflict('invalid_state', 'Only completed tasks or tasks in review can be reopened');
      const status = input.action === 'complete' ? 'completed' : input.action === 'reopen' ? 'reopened' : 'cancelled';
      const set: Doc = { status, reviewer_remarks: input.remarks ?? null };
      if (status === 'completed') set.completed_at = new Date();
      if (status === 'reopened') set.completed_at = null;
      // A pending document check is withdrawn when the task is cancelled or sent back.
      if (status !== 'completed' && t.verification_request_id && t.status === 'pending_review') {
        await this.approvals.cancel(tx, t.verification_request_id);
        if (t.document_id) await tx.collection('employee_documents').updateOne({ id: t.document_id, verification_status: 'pending' }, { $set: { verification_status: 'rejected', verification_remarks: input.remarks ?? null } });
      }
      await tx.collection('employee_tasks').updateOne({ id }, { $set: set, $push: { history: this.entry(input.action === 'complete' ? 'accepted' : input.action === 'reopen' ? 'reopened' : 'cancelled', status, input.remarks) } });
      await this.audit.record(tx, { action: `task.${status}`, resourceType: 'employee', resourceId: t.employee_id, metadata: { taskId: id, remarks: input.remarks ?? null } });
      await this.notifications.notify(tx, {
        membershipIds: [t.assignee_membership_id],
        kind: status === 'reopened' ? 'task.reopened' : 'task.updated',
        title: status === 'completed' ? `Task accepted: ${t.title}` : status === 'reopened' ? `Task reopened: ${t.title}` : `Task cancelled: ${t.title}`,
        body: input.remarks ?? undefined,
        link: `/tasks/${id}`,
      });
      return (await this.views(tx, [(await tx.collection('employee_tasks').findOne({ id }))!], s))[0];
    });
  }

  /** The employee uploads the document a task asks for. It is filed in their documents and goes to HR to verify. */
  async upload(id: string, file: UploadedFile | undefined, remarks?: string | null) {
    DocumentsService.check(file);
    return this.db.tenant(async (tx) => {
      const { t, s, isEmployee } = await this.load(tx, id);
      if (!isEmployee) throw Errors.forbidden('Only the person the task is for can upload its document');
      if (t.kind !== 'document') throw Errors.badRequest('not_document_task', 'This task does not ask for a document');
      if (!['new', 'not_started', 'in_progress', 'reopened'].includes(t.status)) {
        throw Errors.conflict('invalid_state', t.status === 'pending_review' ? 'HR is checking your last upload' : 'This task is closed');
      }
      const spec = t.document_spec as TaskDocumentSpec;
      const bad = fileAllowed(spec, file.mimetype, file.size);
      if (bad) throw Errors.badRequest('file_not_allowed', bad);
      const doc = await this.documents.store(tx, t.employee_id, { category: spec.category, title: t.title, visibility: 'employee' }, file, { verification_status: 'pending', task_id: id });
      await tx.collection('employee_tasks').updateOne(
        { id },
        { $set: { status: 'pending_review', document_id: doc.id, submitted_at: new Date(), employee_remarks: remarks ?? t.employee_remarks ?? null, seen_at: t.seen_at ?? new Date() }, $push: { history: this.entry('uploaded', 'pending_review', remarks ?? file.originalname) } },
      );
      const requestId = await this.approvals.start(tx, { resourceType: 'document_verification', resourceId: id, subjectEmployeeId: t.employee_id, summary: `${t.title}: ${doc.fileName}` });
      await tx.collection('employee_tasks').updateOne({ id }, { $set: { verification_request_id: requestId } });
      return (await this.views(tx, [(await tx.collection('employee_tasks').findOne({ id }))!], s))[0];
    });
  }

  /** HR verifies or rejects the uploaded document (the same decision as in Approvals). */
  async verify(id: string, input: z.infer<typeof documentVerifyInput>) {
    const reqId = await this.db.tenant(async (tx) => {
      const { t, canManage } = await this.load(tx, id);
      if (!canManage) throw Errors.notFound('Task');
      if (t.status !== 'pending_review' || !t.verification_request_id) throw Errors.conflict('invalid_state', 'There is no upload waiting for verification');
      return t.verification_request_id as string;
    });
    await this.approvals.decide(reqId, input.decision === 'verify' ? 'approve' : 'reject', input.remarks ?? undefined);
    return this.get(id);
  }

  /** Called by the approvals engine when HR decides a document check (from the task or from Approvals). */
  private async documentDecided(tx: TenantTx, taskId: string, requestId: string, result: 'verified' | 'rejected') {
    const t = await tx.collection('employee_tasks').findOne({ id: taskId });
    if (!t) return;
    const step = await tx.collection('approval_steps').findOne({ request_id: requestId, status: result === 'verified' ? 'approved' : 'rejected' }, { sort: { seq: -1 } });
    const remarks = (step?.comment ?? null) as string | null;
    const by = requestContext.tenantActor().membershipId;
    if (t.document_id) {
      await tx.collection('employee_documents').updateOne({ id: t.document_id }, { $set: { verification_status: result, verification_remarks: remarks, verified_at: new Date(), verified_by_membership_id: by } });
    }
    const status = result === 'verified' ? 'completed' : 'reopened';
    await tx.collection('employee_tasks').updateOne(
      { id: taskId },
      { $set: { status, reviewer_remarks: remarks, ...(status === 'completed' ? { completed_at: new Date() } : {}) }, $push: { history: this.entry(result === 'verified' ? 'document_verified' : 'document_rejected', status, remarks) } },
    );
    await this.audit.record(tx, { action: `task.document_${result}`, resourceType: 'employee', resourceId: t.employee_id, metadata: { taskId, documentId: t.document_id ?? null, remarks } });
  }
}

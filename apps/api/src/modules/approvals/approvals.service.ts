import { Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, loadSubject } from '../../platform/authz/authz.service';
import { can, type ResourceAttributes } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';

export type StepDef = { type: 'manager' } | { type: 'skip_level_manager' } | { type: 'role'; role: string };

export interface ApprovalRequestRow {
  id: string;
  resource_type: string;
  resource_id: string;
  subject_employee_id: string | null;
  requested_by_membership_id: string | null;
  summary: string;
  status: string;
}

/** What a module tells the engine about its approvable resource. */
export interface ApprovalHandler {
  /** Permission an approver needs over the resource (checked with ABAC on every decision). */
  permission: string;
  /** Permission needed to change this resource type's approval chain. */
  configurePermission: string;
  defaultSteps: StepDef[];
  /** Fallback when no step resolves to a person (no manager, or the only approver is the requester). */
  fallbackRole: string;
  label: string;
  link: (resourceId: string) => string;
  attributes: (tx: TenantTx, resourceId: string) => Promise<ResourceAttributes>;
  onApproved: (tx: TenantTx, req: ApprovalRequestRow) => Promise<void>;
  onRejected: (tx: TenantTx, req: ApprovalRequestRow) => Promise<void>;
}

interface StepRow {
  id: string;
  seq: number;
  kind: string;
  approver_membership_id: string | null;
  approver_role_key: string | null;
  status: string;
}

/**
 * The approvals engine shared by every module. A request is a chain of steps resolved when it starts:
 * the employee's manager, their manager's manager, or anyone holding a role whose access covers the record.
 * Nobody approves their own request. Decisions are authorised again at decision time, so a person who has
 * since lost access or moved out of scope cannot act.
 */
@Injectable()
export class ApprovalsService {
  private readonly handlers = new Map<string, ApprovalHandler>();

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  register(resourceType: string, handler: ApprovalHandler) {
    this.handlers.set(resourceType, handler);
  }

  private handler(type: string) {
    const h = this.handlers.get(type);
    if (!h) throw Errors.badRequest('unknown_approval_type', `No approval flow for ${type}`);
    return h;
  }

  async steps(tx: TenantTx, resourceType: string): Promise<StepDef[]> {
    const row = await tx.collection<{ steps: StepDef[] }>('approval_policies').findOne({ resource_type: resourceType });
    return row?.steps ?? this.handler(resourceType).defaultSteps;
  }

  /** Starts an approval in the caller's transaction and notifies the first approver(s). */
  async start(tx: TenantTx, input: { resourceType: string; resourceId: string; subjectEmployeeId: string | null; summary: string; steps?: StepDef[] }): Promise<string> {
    const h = this.handler(input.resourceType);
    const actor = requestContext.tenantActor();
    // A caller can set the chain for one request (a workflow's approval step names its own approver).
    const defs = input.steps ?? await this.steps(tx, input.resourceType);

    // Some requests (for example an offer to a candidate) are not about an employee; manager steps then resolve to
    // nobody and the role steps or the fallback role decide.
    const subjectDoc = input.subjectEmployeeId ? await tx.collection('employees').findOne({ id: input.subjectEmployeeId }) : null;
    if (subjectDoc === undefined) throw Errors.notFound('Employee');
    const subject = { manager_id: (subjectDoc?.current_manager_employee_id as string | null | undefined) ?? null, membership_id: (subjectDoc?.membership_id as string | null | undefined) ?? null };
    // A manager counts only while their login is active.
    const managerOf = async (employeeId: string | null) => {
      if (!employeeId) return undefined;
      const e = await tx.collection('employees').findOne({ id: employeeId });
      if (!e?.membership_id || !(await tx.collection('memberships').exists({ id: e.membership_id, status: 'active' }))) return undefined;
      return { id: e.id as string, membership_id: e.membership_id as string, manager_id: (e.current_manager_employee_id as string | null) ?? null };
    };

    const requester = actor.membershipId;
    const resolved: { kind: StepDef['type']; membershipId: string | null; role: string | null }[] = [];
    const manager = await managerOf(subject.manager_id);
    for (const d of defs) {
      if (d.type === 'role') resolved.push({ kind: 'role', membershipId: null, role: d.role });
      else {
        const person = d.type === 'manager' ? manager : await managerOf(manager?.manager_id ?? null);
        // Unresolvable or self-approval steps are dropped; the fallback below guarantees someone else decides.
        if (person?.membership_id && person.membership_id !== requester && person.membership_id !== subject.membership_id) {
          resolved.push({ kind: d.type, membershipId: person.membership_id, role: null });
        }
      }
    }
    if (!resolved.length) resolved.push({ kind: 'role', membershipId: null, role: h.fallbackRole });

    const req = await tx.collection('approval_requests').insert({
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      subject_employee_id: input.subjectEmployeeId,
      requested_by_membership_id: requester,
      summary: input.summary,
    });
    await tx.collection('approval_steps').insertMany(
      resolved.map((st, i) => ({ request_id: req.id, seq: i + 1, kind: st.kind, approver_membership_id: st.membershipId, approver_role_key: st.role, status: i === 0 ? 'pending' : 'waiting' })),
    );
    await this.notifyApprovers(tx, req.id);
    return req.id;
  }

  /** People who can act on the request's current step. Role steps are narrowed to holders whose scope covers the record. */
  private async currentApprovers(tx: TenantTx, requestId: string): Promise<string[]> {
    const req = (await tx.collection<ApprovalRequestRow>('approval_requests').findOne({ id: requestId }))!;
    const step = await tx.collection<StepRow>('approval_steps').findOne({ request_id: requestId, status: 'pending' });
    if (!step) return [];
    if (step.approver_membership_id) return [step.approver_membership_id];
    const h = this.handler(req.resource_type);
    const attrs = await h.attributes(tx, req.resource_id);
    const eligible = async (role: string) => {
      const roleRow = await tx.collection('roles').findOne({ key: role });
      const holderIds = roleRow ? await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: roleRow.id }) : [];
      const holders = (await tx.collection('memberships').find({ id: { $in: holderIds }, status: 'active' }, { projection: { user_id: 1 } })).map((m) => ({
        membership_id: m.id as string,
        user_id: m.user_id as string,
      }));
      const out: string[] = [];
      for (const holder of holders) {
        if (holder.membership_id === req.requested_by_membership_id) continue;
        // MFA is checked when they decide; here we only need to know whether the record is in their scope.
        const s = await loadSubject(tx, holder.membership_id, holder.user_id, true);
        if (s.employeeId && s.employeeId === req.subject_employee_id) continue;
        if (can(s, h.permission, attrs).allowed) out.push(holder.membership_id);
      }
      return out;
    };
    const out = await eligible(step.approver_role_key!);
    // When nobody in the role can act (e.g. the only HR admin is the requester), workspace owners decide.
    return out.length || step.approver_role_key === 'tenant_owner' ? out : eligible('tenant_owner');
  }

  private async notifyApprovers(tx: TenantTx, requestId: string) {
    const req = (await tx.collection<ApprovalRequestRow>('approval_requests').findOne({ id: requestId }))!;
    const h = this.handler(req.resource_type);
    await this.notifications.notify(tx, {
      membershipIds: await this.currentApprovers(tx, requestId),
      kind: 'approval.requested',
      title: `${h.label} waiting for your approval`,
      body: req.summary,
      link: '/approvals',
      email: true,
    });
  }

  /** Approve or reject the current step. */
  async decide(requestId: string, decision: 'approve' | 'reject', comment?: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const req = await tx.collection<ApprovalRequestRow>('approval_requests').findOne({ id: requestId });
      if (!req) throw Errors.notFound('Approval');
      // Two approvers deciding at once: one commits, the other is retried and then sees the decision.
      await tx.collection('approval_requests').lock({ id: requestId });
      const h = this.handler(req.resource_type);
      // Nobody may decide on their own request or on a request about themselves.
      const subject = await this.authz.subject(tx);
      if (req.requested_by_membership_id === actor.membershipId || (subject.employeeId && subject.employeeId === req.subject_employee_id)) {
        throw Errors.forbidden('You cannot approve your own request');
      }
      if (req.status !== 'pending') throw Errors.conflict('invalid_state', `This request is already ${req.status}`);
      const step = (await tx.collection<StepRow>('approval_steps').findOne({ request_id: requestId, status: 'pending' }))!;
      const approvers = await this.currentApprovers(tx, requestId);
      if (!approvers.includes(actor.membershipId)) throw Errors.notFound('Approval');
      // Re-check the permission with the caller's live session (including MFA requirements).
      await this.authz.require(h.permission, await h.attributes(tx, req.resource_id), tx);

      await tx.collection('approval_steps').updateOne(
        { id: step.id },
        { $set: { status: decision === 'approve' ? 'approved' : 'rejected', decided_by_membership_id: actor.membershipId, decided_at: new Date(), comment: comment ?? null } },
      );
      let final: 'approved' | 'rejected' | null = null;
      if (decision === 'reject') {
        await tx.collection('approval_steps').update({ request_id: requestId, status: 'waiting' }, { $set: { status: 'cancelled' } });
        final = 'rejected';
      } else {
        const next = await tx.collection('approval_steps').findOne({ request_id: requestId, status: 'waiting' }, { sort: { seq: 1 } });
        if (next) await tx.collection('approval_steps').updateOne({ id: next.id }, { $set: { status: 'pending' } });
        else final = 'approved';
      }
      await this.audit.record(tx, {
        action: `approval.${decision === 'approve' ? 'step_approved' : 'rejected'}`,
        resourceType: req.resource_type,
        resourceId: req.resource_id,
        metadata: { approvalId: requestId, step: step.seq, comment: comment ?? null },
      });
      if (final) {
        await tx.collection('approval_requests').updateOne({ id: requestId }, { $set: { status: final, decided_at: new Date() } });
        const updated = { ...req, status: final };
        if (final === 'approved') await h.onApproved(tx, updated);
        else await h.onRejected(tx, updated);
        const subjectEmployee = req.subject_employee_id ? await tx.collection('employees').findOne({ id: req.subject_employee_id }) : undefined;
        const requesterIds = [req.requested_by_membership_id, subjectEmployee?.membership_id as string | null | undefined];
        await this.notifications.notify(tx, {
          membershipIds: requesterIds,
          kind: `approval.${final}`,
          title: `${h.label} ${final}`,
          body: `${req.summary}${comment ? `\nComment: ${comment}` : ''}`,
          link: h.link(req.resource_id),
          email: true,
        });
      } else {
        await this.notifyApprovers(tx, requestId);
      }
      return { id: requestId, status: final ?? 'pending' };
    });
  }

  /** Withdraws a pending request (called by the owning module, e.g. when leave is cancelled). */
  async cancel(tx: TenantTx, requestId: string) {
    await tx.collection('approval_steps').update({ request_id: requestId, status: { $in: ['pending', 'waiting'] } }, { $set: { status: 'cancelled' } });
    await tx.collection('approval_requests').updateOne({ id: requestId, status: 'pending' }, { $set: { status: 'cancelled', decided_at: new Date() } });
  }

  /** Requests waiting for the caller, newest first. */
  async inbox() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const steps = await tx.collection('approval_steps').find({ status: 'pending', $or: [{ approver_membership_id: actor.membershipId }, { approver_role_key: { $ne: null } }] });
      const stepOf = new Map(steps.map((st) => [st.request_id as string, st]));
      const requests = await tx.collection('approval_requests').find({ id: { $in: [...stepOf.keys()] }, status: 'pending' }, { sort: { created_at: -1 }, limit: 200 });
      const counts = new Map<string, number>();
      for (const st of await tx.collection('approval_steps').find({ request_id: { $in: requests.map((x) => x.id) } }, { projection: { request_id: 1 } })) {
        counts.set(st.request_id, (counts.get(st.request_id) ?? 0) + 1);
      }
      const requesters = await membershipUserNames(tx, requests.map((x) => x.requested_by_membership_id));
      const subjects = new Map(
        (await tx.collection('employees').find({ id: { $in: requests.map((x) => x.subject_employee_id).filter(Boolean) } }, { projection: { first_name: 1, last_name: 1 } })).map((e) => [
          e.id as string,
          `${e.first_name} ${e.last_name ?? ''}`.trim() || null,
        ]),
      );
      const candidates = requests.map((x) => ({
        id: x.id as string,
        resourceType: x.resource_type as string,
        resourceId: x.resource_id as string,
        summary: x.summary as string,
        createdAt: x.created_at,
        stepSeq: stepOf.get(x.id)!.seq as number,
        stepCount: counts.get(x.id) ?? 0,
        requestedBy: requesters.get(x.requested_by_membership_id) ?? null,
        subjectName: subjects.get(x.subject_employee_id) ?? null,
        viaRole: (stepOf.get(x.id)!.approver_role_key as string | null) ?? null,
      }));
      const out = [];
      for (const c of candidates) {
        if ((await this.currentApprovers(tx, c.id)).includes(actor.membershipId)) out.push({ ...c, link: this.handler(c.resourceType).link(c.resourceId), label: this.handler(c.resourceType).label });
      }
      return out;
    });
  }

  /** The chain for one resource, for showing progress on the record itself. */
  async trail(tx: TenantTx, requestId: string) {
    const steps = await tx.collection('approval_steps').find({ request_id: requestId }, { sort: { seq: 1 } });
    const names = await membershipUserNames(tx, steps.flatMap((st) => [st.approver_membership_id, st.decided_by_membership_id]));
    return steps.map((st) => ({
      seq: st.seq,
      kind: st.kind,
      status: st.status,
      role: st.approver_role_key ?? null,
      approver: names.get(st.approver_membership_id) ?? null,
      decidedBy: names.get(st.decided_by_membership_id) ?? null,
      decidedAt: st.decided_at ?? null,
      comment: st.comment ?? null,
    }));
  }

  async policy(resourceType: string) {
    const h = this.handler(resourceType);
    await this.authz.require(h.configurePermission);
    return this.db.tenant(async (tx) => ({ resourceType, steps: await this.steps(tx, resourceType), fallbackRole: h.fallbackRole }));
  }

  async setPolicy(resourceType: string, steps: StepDef[]) {
    const h = this.handler(resourceType);
    await this.authz.require(h.configurePermission);
    return this.db.tenant(async (tx) => {
      for (const s of steps) {
        if (s.type === 'role' && !(await tx.collection('roles').exists({ key: s.role }))) throw Errors.badRequest('unknown_role', `There is no role ${s.role}`);
      }
      const before = await this.steps(tx, resourceType);
      await tx.collection('approval_policies').upsert({ resource_type: resourceType }, { resource_type: resourceType, steps }, { $set: { steps } });
      await this.audit.record(tx, { action: 'approval_policy.updated', resourceType: 'approval_policy', resourceId: resourceType, changes: { from: before, to: steps } });
      return { resourceType, steps };
    });
  }
}

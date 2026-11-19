import { Injectable } from '@nestjs/common';
import {
  BUILT_IN_APPROVAL_CATEGORIES, approvalStatusMessage, categorizeApproval, type ApprovalCategoryDef, type ApprovalCategoryInput, type ApprovalMeta, type ApprovalView,
} from '@crew/contracts';
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
  /** The deciding comment, when the request was just approved or rejected. */
  comment?: string | null;
}

/** A supporting document shown with a request (a receipt, a medical note), opened through the Web Portal. */
export interface ApprovalDocument { name: string; href: string }

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
  /** Extra facts the approver needs to decide, shown with the item in the inbox (for example same-day leave). */
  details?: (tx: TenantTx, resourceId: string) => Promise<Record<string, unknown> | null>;
  /** Supporting documents (receipts, attachments) to show with the request. */
  documents?: (tx: TenantTx, resourceId: string) => Promise<ApprovalDocument[]>;
  /**
   * Approve automatically when the requester is the workspace's only Owner and nobody else can decide a step (a
   * one-person workspace would otherwise wait forever). Recorded in the audit trail as approval.auto_approved.
   */
  autoApproveSoleOwner?: boolean;
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
  async start(tx: TenantTx, input: { resourceType: string; resourceId: string; subjectEmployeeId: string | null; summary: string; steps?: StepDef[]; meta?: ApprovalMeta }): Promise<string> {
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
      meta: input.meta ?? null,
      category: categorizeApproval(input.resourceType, input.meta, await this.customCategories(tx)),
    });
    await tx.collection('approval_steps').insertMany(
      resolved.map((st, i) => ({ request_id: req.id, seq: i + 1, kind: st.kind, approver_membership_id: st.membershipId, approver_role_key: st.role, status: i === 0 ? 'pending' : 'waiting' })),
    );
    if (h.autoApproveSoleOwner && (await this.autoApprove(tx, req.id, requester))) return req.id;
    await this.notifications.signal(tx, [requester], 'approvals.changed');
    const approvers = await this.notifyApprovers(tx, req.id);
    // The person asking hears straight away that it went for approval, and to whom, so a request is never sent
    // into silence. When they cannot see it themselves (an offer, say), nobody is told here.
    const tellRequester = subject.membership_id ?? (input.subjectEmployeeId ? null : requester);
    if (tellRequester && !approvers.includes(tellRequester)) {
      const who = (await this.waitingOn(tx, [req.id])).get(req.id);
      await this.notifications.notify(tx, {
        membershipIds: [tellRequester],
        kind: 'approval.submitted',
        title: `${h.label} submitted`,
        body: `Your request has been submitted successfully. ${await this.stageMessage(tx, req.id, who)} You will be told when it is decided.`,
        link: h.link(input.resourceId),
        resource: { type: input.resourceType, id: input.resourceId },
      });
    }
    return req.id;
  }

  /** "Your request is awaiting manager approval (Asha)." for the request's current step. */
  private async stageMessage(tx: TenantTx, requestId: string, who?: string | null): Promise<string> {
    const step = await tx.collection<StepRow>('approval_steps').findOne({ request_id: requestId, status: 'pending' });
    if (!step) return approvalStatusMessage('approved', null);
    const stage = step.kind === 'manager' || step.kind === 'skip_level_manager' ? 'manager' : /^hr_/.test(step.approver_role_key ?? '') ? 'hr' : 'other';
    return approvalStatusMessage('pending', { stage, who: who ?? null });
  }

  /** HR's own approval categories, active ones only, in their order. */
  async customCategories(tx: TenantTx): Promise<ApprovalCategoryDef[]> {
    const rows = await tx.collection('approval_categories').find({ active: true }, { sort: { position: 1, created_at: 1 } });
    return rows.map((r) => ({ key: r.key, label: r.label, description: r.description, icon: r.icon, color: r.color, rule: r.rule, builtIn: false }));
  }

  /** Active owners of the workspace. */
  private async owners(tx: TenantTx): Promise<string[]> {
    const role = await tx.collection('roles').findOne({ key: 'tenant_owner' });
    if (!role) return [];
    const ids = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: role.id });
    return (await tx.collection('memberships').find({ id: { $in: ids }, status: 'active' }, { projection: { _id: 1 } })).map((m) => m.id as string);
  }

  /**
   * Approves the request's steps one by one while nobody but the requester could decide them and the requester is
   * the only Owner. Returns true when the whole request was approved this way.
   */
  private async autoApprove(tx: TenantTx, requestId: string, requester: string): Promise<boolean> {
    const owners = await this.owners(tx);
    if (owners.length !== 1 || owners[0] !== requester) return false;
    const req = (await tx.collection<ApprovalRequestRow>('approval_requests').findOne({ id: requestId }))!;
    const h = this.handler(req.resource_type);
    const note = 'Approved automatically: you are the only Owner of this workspace and nobody else can approve it.';
    for (;;) {
      const step = await tx.collection<StepRow>('approval_steps').findOne({ request_id: requestId, status: 'pending' });
      if (!step) break;
      if ((await this.currentApprovers(tx, requestId)).length) return false;
      await tx.collection('approval_steps').updateOne({ id: step.id }, { $set: { status: 'approved', decided_by_membership_id: requester, decided_at: new Date(), comment: note } });
      const next = await tx.collection('approval_steps').findOne({ request_id: requestId, status: 'waiting' }, { sort: { seq: 1 } });
      if (next) await tx.collection('approval_steps').updateOne({ id: next.id }, { $set: { status: 'pending' } });
    }
    await tx.collection('approval_requests').updateOne({ id: requestId }, { $set: { status: 'approved', decided_at: new Date(), auto_approved: true } });
    await this.audit.record(tx, {
      action: 'approval.auto_approved', resourceType: req.resource_type, resourceId: req.resource_id,
      metadata: { approvalId: requestId, reason: 'sole_owner', summary: req.summary },
    });
    await h.onApproved(tx, { ...req, status: 'approved', comment: note });
    await this.notifications.notify(tx, {
      membershipIds: [requester], kind: 'approval.auto_approved', title: `${h.label} approved automatically`,
      body: `${req.summary}\n${note}`, link: h.link(req.resource_id), resource: { type: req.resource_type, id: req.resource_id },
    });
    return true;
  }

  /**
   * Who each pending request is waiting for, as people's names (up to three, then "and N more"), for the person
   * who asked. Requests that are not pending are left out.
   */
  async waitingOn(tx: TenantTx, requestIds: (string | null | undefined)[]): Promise<Map<string, string>> {
    const ids = [...new Set(requestIds.filter((x): x is string => !!x))];
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const pending = await tx.collection<ApprovalRequestRow>('approval_requests').find({ id: { $in: ids }, status: 'pending' }, { projection: { _id: 1 } });
    for (const r of pending) {
      const people = await this.currentApprovers(tx, r.id);
      const names = [...(await membershipUserNames(tx, people.slice(0, 3))).values()].filter(Boolean) as string[];
      if (!names.length) {
        out.set(r.id, 'an approver (nobody can approve it yet: ask HR to check the approval settings)');
        continue;
      }
      const more = people.length - names.length;
      out.set(r.id, more > 0 ? `${names.join(', ')} and ${more} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0]!);
    }
    return out;
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

  private async notifyApprovers(tx: TenantTx, requestId: string): Promise<string[]> {
    const req = (await tx.collection<ApprovalRequestRow>('approval_requests').findOne({ id: requestId }))!;
    const h = this.handler(req.resource_type);
    const approvers = await this.currentApprovers(tx, requestId);
    await this.notifications.notify(tx, {
      membershipIds: approvers,
      kind: 'approval.requested',
      title: `You have a new request awaiting your approval: ${h.label.toLowerCase()}`,
      body: req.summary,
      link: `/approvals/${requestId}`,
      email: true,
      priority: 'high',
      actorMembershipId: req.requested_by_membership_id,
      resource: { type: 'approval_request', id: requestId },
    });
    await this.notifications.signal(tx, approvers, 'approvals.changed');
    return approvers;
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
        const updated = { ...req, status: final, comment: comment ?? null };
        if (final === 'approved') await h.onApproved(tx, updated);
        else await h.onRejected(tx, updated);
        const subjectEmployee = req.subject_employee_id ? await tx.collection('employees').findOne({ id: req.subject_employee_id }) : undefined;
        const requesterIds = [req.requested_by_membership_id, subjectEmployee?.membership_id as string | null | undefined];
        await this.notifications.notify(tx, {
          membershipIds: requesterIds,
          kind: `approval.${final}`,
          title: `${h.label} ${final}`,
          body: `${approvalStatusMessage(final, null)}\n${req.summary}${comment ? `\nRemarks: ${comment}` : ''}`,
          link: h.link(req.resource_id),
          email: true,
          priority: final === 'rejected' ? 'high' : 'normal',
          actorMembershipId: actor.membershipId,
          resource: { type: req.resource_type, id: req.resource_id },
        });
        await this.notifications.signal(tx, [...requesterIds, actor.membershipId], 'approvals.changed');
      } else {
        const next = await this.notifyApprovers(tx, requestId);
        // The person asking sees where it is now: "Your request is pending HR approval."
        const subjectEmployee = req.subject_employee_id ? await tx.collection('employees').findOne({ id: req.subject_employee_id }) : undefined;
        const asker = (subjectEmployee?.membership_id as string | undefined) ?? (req.subject_employee_id ? null : req.requested_by_membership_id);
        if (asker && !next.includes(asker)) {
          const who = (await this.waitingOn(tx, [requestId])).get(requestId);
          await this.notifications.notify(tx, {
            membershipIds: [asker], kind: 'approval.progressed', title: `${h.label}: step ${step.seq} approved`,
            body: `${await this.stageMessage(tx, requestId, who)}\n${req.summary}`, link: h.link(req.resource_id), actorMembershipId: actor.membershipId,
            resource: { type: req.resource_type, id: req.resource_id },
          });
        }
        await this.notifications.signal(tx, [asker, actor.membershipId], 'approvals.changed');
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
      const custom = await this.customCategories(tx);
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
        category: (x.category as string | undefined) ?? categorizeApproval(x.resource_type, x.meta, custom),
        ref: approvalRef(x.id),
      }));
      const out = [];
      for (const c of candidates) {
        if (!(await this.currentApprovers(tx, c.id)).includes(actor.membershipId)) continue;
        const h = this.handler(c.resourceType);
        out.push({ ...c, link: h.link(c.resourceId), label: h.label, details: h.details ? await h.details(tx, c.resourceId) : null });
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

  /** Every request type that goes through approvals, with its chain when the caller may change it. */
  async types() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const out = [];
      for (const [resourceType, h] of this.handlers) {
        const canConfigure = s.grants.some((g) => g.permission === h.configurePermission);
        out.push({ resourceType, label: h.label, canConfigure, fallbackRole: h.fallbackRole, steps: canConfigure ? await this.steps(tx, resourceType) : null, autoApproveSoleOwner: Boolean(h.autoApproveSoleOwner) });
      }
      return out.sort((a, b) => a.label.localeCompare(b.label));
    });
  }

  // Approvals page: category cards, lists and one request ------------------------------------------------------

  /** Every category the page shows: HR's own (active or not) and the built-in ones. */
  async categories() {
    return this.db.tenant(async (tx) => {
      const custom = await tx.collection('approval_categories').find({}, { sort: { position: 1, created_at: 1 } });
      return [
        ...custom.map((r) => ({ key: r.key as string, label: r.label as string, description: r.description as string, icon: r.icon as string, color: r.color as string, rule: r.rule, builtIn: false, active: r.active as boolean })),
        ...BUILT_IN_APPROVAL_CATEGORIES.map((c) => ({ ...c, active: true })),
      ];
    });
  }

  async saveCategory(input: ApprovalCategoryInput, existingKey?: string) {
    await this.authz.require('org:manage');
    if (BUILT_IN_APPROVAL_CATEGORIES.some((c) => c.key === input.key)) throw Errors.conflict('category_key_taken', 'A built-in category already uses this key. Choose another one.');
    return this.db.tenant(async (tx) => {
      const rule = {
        resourceTypes: input.resourceTypes, leaveTypeCodes: input.leaveTypeCodes, expenseCategoryIds: input.expenseCategoryIds,
        ...(input.paid === null ? {} : { paid: input.paid }), ...(input.halfDay === null ? {} : { halfDay: input.halfDay }),
      };
      const fields = { key: input.key, label: input.label, description: input.description, icon: input.icon, color: input.color, rule, active: input.active };
      const table = tx.collection('approval_categories');
      if (existingKey) {
        if (!(await table.exists({ key: existingKey }))) throw Errors.notFound('Approval category');
        if (existingKey !== input.key && (await table.exists({ key: input.key }))) throw Errors.conflict('category_key_taken', 'Another category already uses this key');
        await table.updateOne({ key: existingKey }, { $set: fields });
        if (existingKey !== input.key) await tx.collection('approval_requests').update({ category: existingKey }, { $set: { category: input.key } });
      } else {
        if (await table.exists({ key: input.key })) throw Errors.conflict('category_key_taken', 'Another category already uses this key');
        await table.insert({ ...fields, position: await table.count({}) });
      }
      // Pending requests are placed again, so a new card picks up what is already waiting.
      const custom = await this.customCategories(tx);
      for (const r of await tx.collection('approval_requests').find({ status: 'pending' }, { projection: { resource_type: 1, meta: 1, category: 1 } })) {
        const key = categorizeApproval(r.resource_type, r.meta, custom);
        if (key !== r.category) await tx.collection('approval_requests').updateOne({ id: r.id }, { $set: { category: key } });
      }
      await this.audit.record(tx, { action: existingKey ? 'approval_category.updated' : 'approval_category.created', resourceType: 'approval_category', resourceId: input.key, changes: input });
      return { key: input.key };
    });
  }

  async deleteCategory(key: string) {
    await this.authz.require('org:manage');
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('approval_categories').deleteOne({ key }))) throw Errors.notFound('Approval category');
      const custom = await this.customCategories(tx);
      for (const r of await tx.collection('approval_requests').find({ category: key }, { projection: { resource_type: 1, meta: 1 } })) {
        await tx.collection('approval_requests').updateOne({ id: r.id }, { $set: { category: categorizeApproval(r.resource_type, r.meta, custom) } });
      }
      await this.audit.record(tx, { action: 'approval_category.deleted', resourceType: 'approval_category', resourceId: key });
    });
  }

  /** The requests one view covers, newest first: waiting for me, decided by me, or my own (and those about me). */
  private async viewRequests(tx: TenantTx, view: ApprovalView, limit = 2000) {
    const actor = requestContext.tenantActor();
    if (view === 'waiting') {
      const steps = await tx.collection('approval_steps').find({ status: 'pending', $or: [{ approver_membership_id: actor.membershipId }, { approver_role_key: { $ne: null } }] }, { projection: { request_id: 1 } });
      const reqs = await tx.collection('approval_requests').find({ id: { $in: steps.map((st) => st.request_id) }, status: 'pending' }, { sort: { created_at: -1 }, limit: 500 });
      const out = [];
      for (const r of reqs) if ((await this.currentApprovers(tx, r.id)).includes(actor.membershipId)) out.push(r);
      return out;
    }
    if (view === 'decided') {
      const ids = await tx.collection('approval_steps').distinct<string>('request_id', { decided_by_membership_id: actor.membershipId });
      return tx.collection('approval_requests').find({ id: { $in: ids } }, { sort: { created_at: -1 }, limit });
    }
    const subject = await this.authz.subject(tx);
    return tx.collection('approval_requests').find(
      { $or: [{ requested_by_membership_id: actor.membershipId }, ...(subject.employeeId ? [{ subject_employee_id: subject.employeeId }] : [])] },
      { sort: { created_at: -1 }, limit },
    );
  }

  /** Category cards for one view: total, pending, approved and rejected requests, and the latest few in each. */
  async overview(view: ApprovalView) {
    return this.db.tenant(async (tx) => {
      const rows = await this.viewRequests(tx, view);
      const custom = await this.customCategories(tx);
      const keyOf = (r: Record<string, unknown>) => (r.category as string | undefined) ?? categorizeApproval(r.resource_type as string, r.meta as ApprovalMeta, custom);
      const cards = new Map<string, { total: number; pending: number; approved: number; rejected: number; cancelled: number; recent: { id: string; summary: string; status: string; createdAt: string }[] }>();
      for (const r of rows) {
        const k = keyOf(r);
        const c = cards.get(k) ?? { total: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0, recent: [] };
        c.total++;
        c[r.status as 'pending' | 'approved' | 'rejected' | 'cancelled']++;
        if (c.recent.length < 3) c.recent.push({ id: r.id, summary: r.summary, status: r.status, createdAt: r.created_at });
        cards.set(k, c);
      }
      const defs = [...custom, ...BUILT_IN_APPROVAL_CATEGORIES];
      return {
        view,
        total: rows.length,
        pending: rows.filter((r) => r.status === 'pending').length,
        categories: defs.map((d) => ({ key: d.key, label: d.label, description: d.description, icon: d.icon, color: d.color, builtIn: d.builtIn, ...(cards.get(d.key) ?? { total: 0, pending: 0, approved: 0, rejected: 0, cancelled: 0, recent: [] }) })),
      };
    });
  }

  /** Requests in one view and (optionally) one category, with what each is waiting on. */
  async list(q: { view: ApprovalView; category?: string; status?: string; q?: string; limit: number }) {
    return this.db.tenant(async (tx) => {
      const custom = await this.customCategories(tx);
      let rows = await this.viewRequests(tx, q.view);
      if (q.category) rows = rows.filter((r) => ((r.category as string | undefined) ?? categorizeApproval(r.resource_type, r.meta, custom)) === q.category);
      if (q.status) rows = rows.filter((r) => r.status === q.status);
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter((r) => (r.summary as string).toLowerCase().includes(needle) || approvalRef(r.id).toLowerCase().includes(needle));
      }
      rows = rows.slice(0, q.limit);
      return this.describe(tx, rows, custom);
    });
  }

  private async describe(tx: TenantTx, rows: Record<string, any>[], custom: ApprovalCategoryDef[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const waiting = await this.waitingOn(tx, rows.map((r) => r.id));
    const names = await membershipUserNames(tx, rows.map((r) => r.requested_by_membership_id));
    const subjects = new Map(
      (await tx.collection('employees').find({ id: { $in: rows.map((r) => r.subject_employee_id).filter(Boolean) } }, { projection: { first_name: 1, last_name: 1 } }))
        .map((e) => [e.id as string, `${e.first_name} ${e.last_name ?? ''}`.trim()]),
    );
    const stepRows = await tx.collection<StepRow & { request_id: string }>('approval_steps').find({ request_id: { $in: rows.map((r) => r.id) } }, { sort: { seq: 1 } });
    const stepsOf = new Map<string, StepRow[]>();
    for (const st of stepRows) stepsOf.set(st.request_id, [...(stepsOf.get(st.request_id) ?? []), st]);
    const defs = new Map([...custom, ...BUILT_IN_APPROVAL_CATEGORIES].map((d) => [d.key, d]));
    return rows.map((r) => {
      const h = this.handlers.get(r.resource_type);
      const steps = stepsOf.get(r.id) ?? [];
      const current = steps.find((st) => st.status === 'pending');
      const category = (r.category as string | undefined) ?? categorizeApproval(r.resource_type, r.meta, custom);
      const stage = current ? (current.kind === 'role' ? (/^hr_/.test(current.approver_role_key ?? '') ? 'hr' : 'other') : 'manager') : null;
      return {
        id: r.id as string,
        ref: approvalRef(r.id),
        resourceType: r.resource_type as string,
        resourceId: r.resource_id as string,
        label: h?.label ?? r.resource_type,
        category,
        categoryLabel: defs.get(category)?.label ?? category,
        summary: r.summary as string,
        status: r.status as string,
        autoApproved: Boolean(r.auto_approved),
        statusMessage: approvalStatusMessage(r.status, stage ? { stage: stage as 'manager' | 'hr' | 'other', who: waiting.get(r.id) ?? null } : null),
        waitingOn: waiting.get(r.id) ?? null,
        stepSeq: current?.seq ?? null,
        stepCount: steps.length,
        requestedBy: names.get(r.requested_by_membership_id) ?? null,
        subjectName: subjects.get(r.subject_employee_id) ?? null,
        createdAt: r.created_at,
        decidedAt: r.decided_at ?? null,
        link: h ? h.link(r.resource_id) : null,
      };
    });
  }

  /**
   * One request with everything needed to decide or follow it: details, documents, the chain and its remarks.
   * Visible to the requester, the person it is about, anyone who can decide it or decided a step, and people whose
   * access covers the record.
   */
  async detail(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('approval_requests').findOne({ id });
      if (!r) throw Errors.notFound('Approval');
      const h = this.handler(r.resource_type);
      const subject = await this.authz.subject(tx);
      const approvers = r.status === 'pending' ? await this.currentApprovers(tx, id) : [];
      const own = r.requested_by_membership_id === actor.membershipId || (subject.employeeId && subject.employeeId === r.subject_employee_id);
      const decidedByMe = await tx.collection('approval_steps').exists({ request_id: id, decided_by_membership_id: actor.membershipId });
      const covers = can(subject, h.permission, await h.attributes(tx, r.resource_id)).allowed;
      if (!own && !decidedByMe && !approvers.includes(actor.membershipId) && !covers) throw Errors.notFound('Approval');
      const [row] = await this.describe(tx, [r], await this.customCategories(tx));
      // Opening the request clears the notices that point at it.
      await this.notifications.markReadByLink(tx, actor.membershipId, `/approvals/${id}`);
      const trail = await this.trail(tx, id);
      const decisive = [...trail].reverse().find((st) => st.status === 'approved' || st.status === 'rejected');
      return {
        ...row!,
        details: h.details ? await h.details(tx, r.resource_id) : null,
        documents: h.documents ? await h.documents(tx, r.resource_id) : [],
        trail,
        finalDecision: r.status === 'pending' ? null : { status: r.status, at: r.decided_at ?? null, by: r.status === 'cancelled' ? null : decisive?.decidedBy ?? null, remarks: decisive?.comment ?? null },
        canDecide: approvers.includes(actor.membershipId) && !own,
        mine: Boolean(own),
      };
    });
  }
}

/** A short, human reference for a request (APR-3F9A21), stable because it comes from the id. */
export function approvalRef(id: string): string {
  return `APR-${id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

import { Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, loadSubject } from '../../platform/authz/authz.service';
import { can, type ResourceAttributes } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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
  attributes: (tx: Tx, resourceId: string) => Promise<ResourceAttributes>;
  onApproved: (tx: Tx, req: ApprovalRequestRow) => Promise<void>;
  onRejected: (tx: Tx, req: ApprovalRequestRow) => Promise<void>;
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

  async steps(tx: Tx, resourceType: string): Promise<StepDef[]> {
    const row = await one<{ steps: StepDef[] }>(tx, 'select steps from approval_policies where resource_type = $1', [resourceType]);
    return row?.steps ?? this.handler(resourceType).defaultSteps;
  }

  /** Starts an approval in the caller's transaction and notifies the first approver(s). */
  async start(tx: Tx, input: { resourceType: string; resourceId: string; subjectEmployeeId: string; summary: string }): Promise<string> {
    const h = this.handler(input.resourceType);
    const actor = requestContext.tenantActor();
    const defs = await this.steps(tx, input.resourceType);

    const subject = await one<{ manager_id: string | null; membership_id: string | null }>(
      tx, 'select current_manager_employee_id as manager_id, membership_id from employees where id = $1', [input.subjectEmployeeId],
    );
    if (!subject) throw Errors.notFound('Employee');
    const managerOf = async (employeeId: string | null) =>
      employeeId ? await one<{ id: string; membership_id: string | null; manager_id: string | null }>(
        tx, `select e.id, e.membership_id, e.current_manager_employee_id as manager_id from employees e
              join memberships m on m.id = e.membership_id where e.id = $1 and m.status = 'active'`, [employeeId],
      ) : undefined;

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

    const req = (await one<{ id: string }>(
      tx,
      `insert into approval_requests (tenant_id, resource_type, resource_id, subject_employee_id, requested_by_membership_id, summary)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [actor.tenantId, input.resourceType, input.resourceId, input.subjectEmployeeId, requester, input.summary],
    ))!;
    for (const [i, s] of resolved.entries()) {
      await tx.query(
        `insert into approval_steps (tenant_id, request_id, seq, kind, approver_membership_id, approver_role_key, status) values ($1, $2, $3, $4, $5, $6, $7)`,
        [actor.tenantId, req.id, i + 1, s.kind, s.membershipId, s.role, i === 0 ? 'pending' : 'waiting'],
      );
    }
    await this.notifyApprovers(tx, req.id);
    return req.id;
  }

  /** People who can act on the request's current step. Role steps are narrowed to holders whose scope covers the record. */
  private async currentApprovers(tx: Tx, requestId: string): Promise<string[]> {
    const req = (await one<ApprovalRequestRow>(tx, 'select * from approval_requests where id = $1', [requestId]))!;
    const step = await one<StepRow>(tx, `select * from approval_steps where request_id = $1 and status = 'pending'`, [requestId]);
    if (!step) return [];
    if (step.approver_membership_id) return [step.approver_membership_id];
    const h = this.handler(req.resource_type);
    const attrs = await h.attributes(tx, req.resource_id);
    const eligible = async (role: string) => {
      const holders = await many<{ membership_id: string; user_id: string }>(
        tx,
        `select distinct ra.membership_id, m.user_id from role_assignments ra join roles r on r.id = ra.role_id
           join memberships m on m.id = ra.membership_id where r.key = $1 and m.status = 'active'`,
        [role],
      );
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

  private async notifyApprovers(tx: Tx, requestId: string) {
    const req = (await one<ApprovalRequestRow>(tx, 'select * from approval_requests where id = $1', [requestId]))!;
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
      const req = await one<ApprovalRequestRow>(tx, 'select * from approval_requests where id = $1 for update', [requestId]);
      if (!req) throw Errors.notFound('Approval');
      const h = this.handler(req.resource_type);
      // Nobody may decide on their own request or on a request about themselves.
      const subject = await this.authz.subject(tx);
      if (req.requested_by_membership_id === actor.membershipId || (subject.employeeId && subject.employeeId === req.subject_employee_id)) {
        throw Errors.forbidden('You cannot approve your own request');
      }
      if (req.status !== 'pending') throw Errors.conflict('invalid_state', `This request is already ${req.status}`);
      const step = (await one<StepRow>(tx, `select * from approval_steps where request_id = $1 and status = 'pending' for update`, [requestId]))!;
      const approvers = await this.currentApprovers(tx, requestId);
      if (!approvers.includes(actor.membershipId)) throw Errors.notFound('Approval');
      // Re-check the permission with the caller's live session (including MFA requirements).
      await this.authz.require(h.permission, await h.attributes(tx, req.resource_id), tx);

      await tx.query(
        `update approval_steps set status = $2, decided_by_membership_id = $3, decided_at = now(), comment = $4 where id = $1`,
        [step.id, decision === 'approve' ? 'approved' : 'rejected', actor.membershipId, comment ?? null],
      );
      let final: 'approved' | 'rejected' | null = null;
      if (decision === 'reject') {
        await tx.query(`update approval_steps set status = 'cancelled' where request_id = $1 and status = 'waiting'`, [requestId]);
        final = 'rejected';
      } else {
        const next = await one<{ id: string }>(tx, `select id from approval_steps where request_id = $1 and status = 'waiting' order by seq limit 1`, [requestId]);
        if (next) await tx.query(`update approval_steps set status = 'pending' where id = $1`, [next.id]);
        else final = 'approved';
      }
      await this.audit.record(tx, {
        action: `approval.${decision === 'approve' ? 'step_approved' : 'rejected'}`,
        resourceType: req.resource_type,
        resourceId: req.resource_id,
        metadata: { approvalId: requestId, step: step.seq, comment: comment ?? null },
      });
      if (final) {
        await tx.query(`update approval_requests set status = $2, decided_at = now() where id = $1`, [requestId, final]);
        const updated = { ...req, status: final };
        if (final === 'approved') await h.onApproved(tx, updated);
        else await h.onRejected(tx, updated);
        const requesterIds = [req.requested_by_membership_id, (await one<{ membership_id: string | null }>(tx, 'select membership_id from employees where id = $1', [req.subject_employee_id]))?.membership_id];
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
  async cancel(tx: Tx, requestId: string) {
    await tx.query(`update approval_steps set status = 'cancelled' where request_id = $1 and status in ('pending', 'waiting')`, [requestId]);
    await tx.query(`update approval_requests set status = 'cancelled', decided_at = now() where id = $1 and status = 'pending'`, [requestId]);
  }

  /** Requests waiting for the caller, newest first. */
  async inbox() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const candidates = await many<{ id: string; resourceType: string; resourceId: string; summary: string; createdAt: string; stepSeq: number; stepCount: number; requestedBy: string | null; subjectName: string | null; viaRole: string | null }>(
        tx,
        `select r.id, r.resource_type as "resourceType", r.resource_id as "resourceId", r.summary, r.created_at as "createdAt",
                s.seq as "stepSeq", (select count(*)::int from approval_steps x where x.request_id = r.id) as "stepCount",
                ru.full_name as "requestedBy", nullif(trim(e.first_name || ' ' || e.last_name), '') as "subjectName", s.approver_role_key as "viaRole"
           from approval_requests r
           join approval_steps s on s.request_id = r.id and s.status = 'pending'
           left join memberships rm on rm.id = r.requested_by_membership_id left join users ru on ru.id = rm.user_id
           left join employees e on e.id = r.subject_employee_id
          where r.status = 'pending' and (s.approver_membership_id = $1 or s.approver_role_key is not null)
          order by r.created_at desc limit 200`,
        [actor.membershipId],
      );
      const out = [];
      for (const c of candidates) {
        if ((await this.currentApprovers(tx, c.id)).includes(actor.membershipId)) out.push({ ...c, link: this.handler(c.resourceType).link(c.resourceId), label: this.handler(c.resourceType).label });
      }
      return out;
    });
  }

  /** The chain for one resource, for showing progress on the record itself. */
  async trail(tx: Tx, requestId: string) {
    return many(
      tx,
      `select s.seq, s.kind, s.status, s.approver_role_key as "role", au.full_name as "approver", du.full_name as "decidedBy", s.decided_at as "decidedAt", s.comment
         from approval_steps s
         left join memberships am on am.id = s.approver_membership_id left join users au on au.id = am.user_id
         left join memberships dm on dm.id = s.decided_by_membership_id left join users du on du.id = dm.user_id
        where s.request_id = $1 order by s.seq`,
      [requestId],
    );
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
        if (s.type === 'role' && !(await one(tx, 'select 1 from roles where key = $1', [s.role]))) throw Errors.badRequest('unknown_role', `There is no role ${s.role}`);
      }
      const before = await this.steps(tx, resourceType);
      await tx.query(
        `insert into approval_policies (tenant_id, resource_type, steps) values (app_tenant_id(), $1, $2)
         on conflict (tenant_id, resource_type) do update set steps = excluded.steps`,
        [resourceType, JSON.stringify(steps)],
      );
      await this.audit.record(tx, { action: 'approval_policy.updated', resourceType: 'approval_policy', resourceId: resourceType, changes: { from: before, to: steps } });
      return { resourceType, steps };
    });
  }
}

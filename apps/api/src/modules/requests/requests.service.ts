import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  REQUEST_KIND_DEFS, leaveRef, requestDays, requestDateLabel, requestRef, requestStatusMessage, requestTitle, requestWhen,
  type LeaveRequestInput, type RequestInput, type RequestKind, type RequestLeaveApplicationInput, type RequestPerson, type RequestStatus, type RequestView,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService, type ApprovalRequestRow } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { memberIdentities } from '../communication/identity';
import { displayName } from '../employees/employee-view';
import { employeeAttrs } from '../employees/employee-attrs';
import { LeaveService } from '../leave/leave.service';
import { leaveApplicationEmail } from './leave-application-email';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const todayUtc = () => new Date().toISOString().slice(0, 10);
/** Request kinds whose approval changes how attendance counts the days (work from home counts as present at home). */
const ATTENDANCE_KINDS = new Set<RequestKind>(['wfh', 'late_coming', 'on_duty']);

/**
 * Requests (28 November 2026). Anyone signed in to a workspace, at any level, raises a request (work from home, early
 * leave, late coming, comp off, leave, half day, on duty, shift change, other) with a reason, dates and times, and
 * loops in the people who should decide it: their reporting manager, their HR, the Super Workspace or anyone else
 * (at least one of them must have authority over the person). Each looped person gets it in Approvals at the same
 * time and decides with a comment (a rejection needs one); everyone must approve. The requester sees every comment.
 *
 * An approved leave or half-day request asks the person to apply for the leave on a pre-filled leave application
 * form, which goes to the same people as a real leave application (balances, calendar, attendance) and by email.
 */
@Injectable()
export class RequestsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly attendance: AttendanceService,
    private readonly leave: LeaveService,
    private readonly entitlements: EntitlementsService,
  ) {}

  onModuleInit() {
    this.approvals.register('staff_request', {
      // Looped people decide because they were named. Anyone else needs approval rights over the person (an
      // escalated request, or HR opening it to look).
      permission: 'leave:approve',
      configurePermission: 'org:manage',
      defaultSteps: [],
      fallbackRole: 'hr_workspace',
      label: 'Request',
      chainSetByModule: 'Each request goes to the people its requester looped in, so it has no chain to set here.',
      rejectNeedsReason: true,
      quiet: true,
      approverTitle: (req) => {
        const kind = (req.meta?.tag as RequestKind | undefined) ?? 'other';
        return `New ${(REQUEST_KIND_DEFS[kind]?.label ?? 'request').toLowerCase()} request for your approval`;
      },
      link: (id) => `/requests/${id}`,
      attributes: async (tx, id) => {
        const r = await tx.collection('staff_requests').findOne({ id });
        const e = r?.employee_id ? await tx.collection('employees').findOne({ id: r.employee_id }) : null;
        return e
          ? employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null })
          : { membershipId: r?.requester_membership_id ?? null };
      },
      details: async (tx, id) => {
        const r = await tx.collection('staff_requests').findOne({ id });
        if (!r) return null;
        const def = REQUEST_KIND_DEFS[r.kind as RequestKind];
        const who = (await this.peopleOf(tx, [r.requester_membership_id])).get(r.requester_membership_id);
        const leaveType = r.leave_type_id ? await tx.collection('leave_types').findOne({ id: r.leave_type_id }, { projection: { name: 1 } }) : null;
        return {
          requestForm: [
            { label: 'Request', value: requestTitle(r.kind, r.title) },
            { label: 'Raised by', value: who ? `${who.name} (${who.levelLabel}${who.designation ? `, ${who.designation}` : ''})` : '—' },
            ...(who?.employeeCode ? [{ label: 'Employee code', value: who.employeeCode }] : []),
            { label: 'When', value: requestWhen({ kind: r.kind, startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time }) },
            ...(r.worked_on ? [{ label: 'Worked on', value: requestDateLabel(r.worked_on) }] : []),
            ...(leaveType ? [{ label: 'Leave type', value: leaveType.name as string }] : []),
            { label: 'Reason', value: r.reason },
          ],
          requestKind: r.kind, requestKindLabel: def.label, requestColor: def.color, requestIcon: def.icon,
        };
      },
      onApproved: (tx, req) => this.closed(tx, req, 'approved'),
      onRejected: (tx, req) => this.closed(tx, req, 'rejected'),
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------------------------------------

  /** Name, level, workspace, designation, department and employee code of members. */
  private async peopleOf(tx: TenantTx, membershipIds: unknown[]): Promise<Map<string, RequestPerson>> {
    const ids = [...new Set(membershipIds.filter((x): x is string => typeof x === 'string' && !!x))];
    if (!ids.length) return new Map();
    const who = await memberIdentities(tx, ids);
    const emps = await tx.collection('employees').find({ membership_id: { $in: ids } }, { projection: { membership_id: 1, current_department_id: 1, current_designation_id: 1 } });
    const [depts, desigs] = await Promise.all([
      tx.collection('departments').find({ id: { $in: [...new Set(emps.map((e) => e.current_department_id).filter(Boolean))] } }, { projection: { name: 1 } }),
      tx.collection('designations').find({ id: { $in: [...new Set(emps.map((e) => e.current_designation_id).filter(Boolean))] } }, { projection: { name: 1 } }),
    ]);
    const dn = new Map(depts.map((d) => [d.id as string, d.name as string]));
    const gn = new Map(desigs.map((d) => [d.id as string, d.name as string]));
    const byMember = new Map(emps.map((e) => [e.membership_id as string, e]));
    const out = new Map<string, RequestPerson>();
    for (const id of ids) {
      const i = who.get(id);
      const e = byMember.get(id);
      out.set(id, {
        membershipId: id, name: i?.name ?? 'Unnamed', level: i?.level ?? 'employee', levelLabel: i?.levelLabel ?? 'Employee Workspace', workspace: i?.workspace ?? null,
        designation: e ? gn.get(e.current_designation_id) ?? null : null, department: e ? dn.get(e.current_department_id) ?? null : null, employeeCode: i?.employeeCode ?? null,
      });
    }
    return out;
  }

  /** Active holders of a level's role, optionally only those whose HR Workspace constraint matches. */
  private async holders(tx: TenantTx, roleKey: 'super_workspace' | 'hr_workspace', match?: (hrWorkspaceIds: string[]) => boolean): Promise<string[]> {
    const role = await tx.collection('roles').findOne({ key: roleKey, is_system: true }, { projection: { _id: 1 } });
    if (!role) return [];
    const rows = (await tx.collection('role_assignments').find({ role_id: role.id }, { projection: { membership_id: 1, constraints: 1 } }))
      .filter((a) => !match || match(((a.constraints?.hrWorkspaceIds as string[] | undefined) ?? [])));
    const ids = [...new Set(rows.map((a) => a.membership_id as string))];
    return (await tx.collection('memberships').find({ id: { $in: ids }, status: 'active' }, { projection: { _id: 1 } })).map((m) => m.id as string);
  }

  /**
   * Of these logins, the ones who approve leave for the requester: a role (or the level's own grants) that approves
   * leave company-wide, or for the requester's legal entity. Ordered: department heads first (the head of HR before
   * the HR team), then the others.
   */
  private async leaveApprovers(tx: TenantTx, ids: string[], legalEntityId: string | null): Promise<string[]> {
    if (!ids.length) return [];
    const rolePerms = new Map((await tx.collection('role_permissions').find({ permission: 'leave:approve' }, { projection: { role_id: 1, scope: 1 } })).map((r) => [r.role_id as string, r.scope]));
    const covers = (scope: unknown, constraints: Record<string, unknown> | undefined) => {
      if (scope === 'tenant' || scope === 'department') return true;
      if (scope !== 'entity') return false;
      const entities = (constraints?.legalEntityIds as string[] | undefined) ?? [];
      return !entities.length || (legalEntityId !== null && entities.includes(legalEntityId));
    };
    const out = new Set<string>();
    for (const a of await tx.collection('role_assignments').find({ membership_id: { $in: ids } }, { projection: { membership_id: 1, role_id: 1, constraints: 1 } })) {
      // A workspace level's own grants (Workspace Permissions) win over the role's template.
      const c = a.constraints as Record<string, unknown> | undefined;
      const grants = c?.grants as Record<string, string> | undefined;
      if (covers(grants ? grants['leave:approve'] : rolePerms.get(a.role_id as string), c)) out.add(a.membership_id as string);
    }
    const heads = new Set((await tx.collection('departments').find({ head_membership_id: { $in: [...out] } }, { projection: { head_membership_id: 1 } })).map((d) => d.head_membership_id as string));
    return ids.filter((id) => out.has(id)).sort((a, b) => Number(heads.has(b)) - Number(heads.has(a)));
  }

  /** The requester's employee record and the people they would usually loop in: reporting manager, HR, Super Workspace. */
  private async circle(tx: TenantTx, membershipId: string) {
    const employee = await tx.collection('employees').findOne({ membership_id: membershipId });
    const activeMember = async (empId: string | null | undefined) => {
      if (!empId) return null;
      const m = await tx.collection('employees').findOne({ id: empId }, { projection: { membership_id: 1, current_manager_employee_id: 1 } });
      if (!m?.membership_id || !(await tx.collection('memberships').exists({ id: m.membership_id, status: 'active' }))) return null;
      return { membershipId: m.membership_id as string, managerId: (m.current_manager_employee_id as string | null) ?? null };
    };
    const manager = await activeMember(employee?.current_manager_employee_id);
    const skip = await activeMember(manager?.managerId);
    const hrWs = (employee?.hr_workspace_id as string | null | undefined) ?? null;
    let hr = hrWs ? await this.holders(tx, 'hr_workspace', (w) => w.includes(hrWs)) : [];
    // The company's HR team when the person's HR Workspace has nobody (or they are in the central group).
    if (!hr.length) hr = await this.holders(tx, 'hr_workspace', (w) => !w.length);
    const supers = await this.holders(tx, 'super_workspace');
    const notMe = (x: string) => x !== membershipId;
    // "Your HR" is the HR people who look after leave (a role that approves leave beyond their own team), not every
    // HR Workspace login (a recruiter or payroll lead is HR Workspace too). They come first; the rest follow.
    const ranked = await this.leaveApprovers(tx, hr, (employee?.current_legal_entity_id as string | null | undefined) ?? null);
    const hrApprovers = new Set(ranked);
    hr = [...ranked, ...hr.filter((x) => !hrApprovers.has(x))];
    return {
      employee,
      manager: manager && notMe(manager.membershipId) ? manager.membershipId : null,
      skipManager: skip && notMe(skip.membershipId) ? skip.membershipId : null,
      hr: hr.filter(notMe),
      hrApprovers,
      supers: supers.filter(notMe),
      allHr: (await this.holders(tx, 'hr_workspace')).filter(notMe),
    };
  }

  /** The request types, who the caller is, the people suggested to loop in, and their leave types (for leave requests). */
  options() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const c = await this.circle(tx, actor.membershipId);
      const ids = [actor.membershipId, c.manager, c.skipManager, ...c.hr.slice(0, 6), ...c.supers.slice(0, 4)];
      const people = await this.peopleOf(tx, ids);
      const tag = (id: string | null, role: RequestPerson['role'], roleLabel: string) => (id && people.get(id) ? [{ ...people.get(id)!, role, roleLabel }] : []);
      const suggested = [
        ...tag(c.manager, 'manager', 'Your reporting manager'),
        ...c.hr.slice(0, 6).flatMap((id) => tag(id, 'hr', c.hrApprovers.has(id) ? 'Your HR' : 'HR Workspace')),
        ...c.supers.slice(0, 4).filter((id) => id !== c.manager).flatMap((id) => tag(id, 'super', 'Super Workspace')),
        ...(c.skipManager && c.skipManager !== c.manager && !c.supers.includes(c.skipManager) ? tag(c.skipManager, 'manager', "Your manager's manager") : []),
      ];
      const seen = new Set<string>();
      const leaveTypes = c.employee
        ? (await this.leave.balancesIn(tx, c.employee.id, Number(todayUtc().slice(0, 4))).catch(() => []))
          .map((b) => ({ id: b.leaveTypeId, name: b.name as string, code: b.code as string, color: b.color as string, available: b.available, notAssigned: b.notAssigned, allowHalfDay: Boolean(b.allowHalfDay), kind: b.kind }))
        : [];
      return {
        kinds: Object.values(REQUEST_KIND_DEFS),
        me: people.get(actor.membershipId)!,
        hasEmployeeRecord: Boolean(c.employee),
        suggested: suggested.filter((p) => !seen.has(p.membershipId) && seen.add(p.membershipId)),
        leaveTypes,
      };
    });
  }

  /** Anyone active in the workspace, to loop into a request (search by name, level, code, department, designation). */
  people(q?: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const members = await tx.collection('memberships').find({ status: 'active', id: { $ne: actor.membershipId } }, { projection: { _id: 1 }, limit: 3000 });
      const people = await this.peopleOf(tx, members.map((m) => m.id));
      const needle = q?.trim().toLowerCase();
      return {
        items: [...people.values()]
          .filter((p) => !needle || [p.name, p.levelLabel, p.workspace, p.employeeCode, p.department, p.designation].some((f) => (f ?? '').toLowerCase().includes(needle)))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 50),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Raising and reading requests
  // ---------------------------------------------------------------------------------------------------------

  create(input: RequestInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const ids = input.approverMembershipIds;
      if (ids.includes(actor.membershipId)) throw Errors.badRequest('self_approver', 'You cannot loop yourself in to approve your own request');
      const active = await tx.collection('memberships').find({ id: { $in: ids }, status: 'active' }, { projection: { _id: 1 } });
      if (active.length !== ids.length) throw Errors.badRequest('unknown_approver', 'Someone you looped in is not an active member of this workspace');
      const c = await this.circle(tx, actor.membershipId);
      // At least one looped person must have authority over the requester: their manager (or the manager above),
      // an HR Workspace person or the Super Workspace. Otherwise anyone could have a colleague approve their request.
      const authority = new Set([c.manager, c.skipManager, ...c.allHr, ...c.supers].filter(Boolean) as string[]);
      if (authority.size && !ids.some((id) => authority.has(id))) {
        throw Errors.badRequest('no_authority', 'Loop in your reporting manager, your HR or the Super Workspace too: at least one of the people must be able to approve for you.');
      }
      if (input.leaveTypeId && !(await tx.collection('leave_types').exists({ id: input.leaveTypeId, archived_at: null }))) throw Errors.badRequest('invalid_leave_type', 'That leave type does not exist or is switched off');
      const end = input.endDate ?? input.startDate;
      // One request of a kind at a time for the same days.
      if (await tx.collection('staff_requests').exists({ requester_membership_id: actor.membershipId, kind: input.kind, status: { $in: ['pending', 'approved'] }, start_date: { $lte: end }, end_date: { $gte: input.startDate } })) {
        throw Errors.conflict('overlapping_request', `You already have a ${REQUEST_KIND_DEFS[input.kind].label.toLowerCase()} request for these dates. Open it from your requests instead.`);
      }
      const row = await tx.collection('staff_requests').insert({
        kind: input.kind, title: input.title?.trim() || null, reason: input.reason, start_date: input.startDate, end_date: end,
        start_time: input.startTime ?? null, end_time: input.endTime ?? null, worked_on: input.workedOn ?? null, leave_type_id: input.leaveTypeId ?? null,
        requester_membership_id: actor.membershipId, employee_id: (c.employee?.id as string | undefined) ?? null, approver_membership_ids: ids,
      });
      const me = (await this.peopleOf(tx, [actor.membershipId])).get(actor.membershipId)!;
      const when = requestWhen({ kind: input.kind, startDate: input.startDate, endDate: end, startTime: input.startTime, endTime: input.endTime });
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'staff_request', resourceId: row.id, subjectEmployeeId: (c.employee?.id as string | undefined) ?? null,
        steps: ids.map((m) => ({ type: 'person' as const, membershipId: m, stage: 1 })),
        summary: `${me.name} (${me.levelLabel}): ${requestTitle(input.kind, input.title)}, ${when}. "${input.reason}"`,
        meta: { tag: input.kind },
      });
      await tx.collection('staff_requests').updateOne({ id: row.id }, { $set: { approval_request_id: approvalId } });
      const names = await this.peopleOf(tx, ids);
      await this.notifications.notify(tx, {
        membershipIds: [actor.membershipId], kind: 'request.submitted', title: `${REQUEST_KIND_DEFS[input.kind].label} request sent`,
        body: `${when}. Sent to ${ids.map((id) => names.get(id)?.name ?? 'someone').join(', ')}. You will be told as each of them decides.`,
        link: `/requests/${row.id}`, resource: { type: 'staff_request', id: row.id as string }, includeActor: true,
      });
      await this.audit.record(tx, {
        action: 'staff_request.submitted', resourceType: 'staff_request', resourceId: row.id,
        changes: { kind: input.kind, startDate: input.startDate, endDate: end, startTime: input.startTime ?? null, endTime: input.endTime ?? null, approvers: ids },
        metadata: { reference: requestRef(row.id as string) },
      });
      return this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id: row.id }))!);
    });
  }

  /** The caller's own requests, newest first, with counts for the tabs. */
  mine(q: { status?: RequestStatus; kind?: RequestKind; limit: number }) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const all = await tx.collection('staff_requests').find({ requester_membership_id: actor.membershipId }, { sort: { created_at: -1 }, limit: 1000 });
      const rows = all.filter((r) => (!q.status || r.status === q.status) && (!q.kind || r.kind === q.kind)).slice(0, q.limit);
      const count = (s: string) => all.filter((r) => r.status === s).length;
      return {
        counts: { all: all.length, pending: count('pending'), approved: count('approved'), rejected: count('rejected'), cancelled: count('cancelled') },
        items: await this.viewsOf(tx, rows),
      };
    });
  }

  get(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.visible(tx, id, actor.membershipId);
      return this.viewOf(tx, r);
    });
  }

  /** The requester, the people looped in, and the Super Workspace may open a request; anyone else sees nothing. */
  private async visible(tx: TenantTx, id: string, membershipId: string) {
    const r = await tx.collection('staff_requests').findOne({ id });
    if (!r) throw Errors.notFound('Request');
    if (r.requester_membership_id === membershipId || (r.approver_membership_ids as string[]).includes(membershipId)) return r;
    const s = await this.authz.subject(tx);
    if (hasPermission(s, 'leave:configure').allowed || (r.approval_request_id && (await this.approvals.approversOf(tx, r.approval_request_id)).includes(membershipId))) return r;
    throw Errors.notFound('Request');
  }

  private async viewOf(tx: TenantTx, r: Doc): Promise<RequestView> {
    return (await this.viewsOf(tx, [r]))[0]!;
  }

  private async viewsOf(tx: TenantTx, rows: Doc[]): Promise<RequestView[]> {
    if (!rows.length) return [];
    const actor = requestContext.tenantActor();
    const people = await this.peopleOf(tx, rows.flatMap((r) => [r.requester_membership_id, ...(r.approver_membership_ids as string[])]));
    const steps = await tx.collection('approval_steps').find({ request_id: { $in: rows.map((r) => r.approval_request_id).filter(Boolean) } }, { projection: { request_id: 1, approver_membership_id: 1, status: 1, comment: 1, decided_at: 1, decided_by_membership_id: 1, kind: 1 } });
    const leaves = await tx.collection('leave_requests').find({ id: { $in: rows.map((r) => r.leave_request_id).filter(Boolean) } }, { projection: { status: 1, days: 1, leave_type_id: 1 } });
    const types = await tx.collection('leave_types').find({ id: { $in: [...new Set([...rows.map((r) => r.leave_type_id), ...leaves.map((l) => l.leave_type_id)].filter(Boolean))] } }, { projection: { name: 1 } });
    const typeName = new Map(types.map((t) => [t.id as string, t.name as string]));
    const leaveOf = new Map(leaves.map((l) => [l.id as string, l]));
    const today = todayUtc();
    return rows.map((r) => {
      const kind = r.kind as RequestKind;
      const def = REQUEST_KIND_DEFS[kind];
      const mySteps = steps.filter((st) => st.request_id === r.approval_request_id);
      const approvers = (r.approver_membership_ids as string[]).map((m) => {
        const st = mySteps.find((x) => x.approver_membership_id === m || x.decided_by_membership_id === m);
        const p = people.get(m) ?? { membershipId: m, name: 'Unnamed', level: 'employee' as const, levelLabel: 'Employee Workspace', workspace: null, designation: null, department: null, employeeCode: null };
        return { ...p, status: (st?.status as 'pending' | 'approved' | 'rejected' | 'cancelled' | 'waiting' | undefined) ?? 'cancelled', comment: (st?.comment as string | null | undefined) ?? null, decidedAt: iso(st?.decided_at) };
      });
      const approved = approvers.filter((a) => a.status === 'approved').length;
      const waitingOn = approvers.filter((a) => a.status === 'pending').map((a) => a.name).join(', ') || null;
      const l = r.leave_request_id ? leaveOf.get(r.leave_request_id) : undefined;
      const leaveLive = l && ['pending', 'approved'].includes(l.status as string);
      const mine = r.requester_membership_id === actor.membershipId;
      return {
        id: r.id, ref: requestRef(r.id), kind, kindLabel: def.label, title: requestTitle(kind, r.title), reason: r.reason,
        startDate: r.start_date, endDate: r.end_date, startTime: r.start_time ?? null, endTime: r.end_time ?? null, workedOn: r.worked_on ?? null,
        days: requestDays(r.start_date, r.end_date), when: requestWhen({ kind, startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time }),
        status: r.status, statusMessage: requestStatusMessage(r.status, { approved, total: approvers.length, waitingOn }, { applied: Boolean(leaveLive), leadsToLeave: Boolean(def.leadsToLeave) }),
        approvalId: r.approval_request_id ?? null,
        requester: people.get(r.requester_membership_id)!,
        approvers,
        leaveTypeId: r.leave_type_id ?? null, leaveTypeName: r.leave_type_id ? typeName.get(r.leave_type_id) ?? null : null,
        leaveApplication: l ? { id: l.id as string, status: l.status as string, ref: leaveRef(l.id as string), days: String(l.days), leaveTypeName: typeName.get(l.leave_type_id) ?? 'Leave' } : null,
        canApplyLeave: mine && r.status === 'approved' && Boolean(def.leadsToLeave) && Boolean(r.employee_id) && !leaveLive,
        canCancel: mine && (r.status === 'pending' || (r.status === 'approved' && r.start_date >= today && !leaveLive)),
        createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at), cancelReason: r.cancel_reason ?? null,
      };
    });
  }

  /** The requester withdraws a pending request, or an approved one before it starts (with no leave applied from it). */
  cancel(id: string, reason?: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('staff_requests').findOne({ id });
      if (!r || r.requester_membership_id !== actor.membershipId) throw Errors.notFound('Request');
      await tx.collection('staff_requests').lock({ id });
      const view = await this.viewOf(tx, r);
      if (!view.canCancel) throw Errors.conflict('invalid_state', r.status === 'approved' ? 'This request has started or has a leave application. Cancel the leave application instead.' : `This request is already ${r.status}`);
      if (r.status === 'pending' && r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await tx.collection('staff_requests').updateOne({ id }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason ?? null } });
      if (r.approval_request_id) await this.notifications.resolveByLink(tx, `/approvals/${r.approval_request_id}`, []);
      const me = (await this.peopleOf(tx, [actor.membershipId])).get(actor.membershipId)!;
      await this.notifications.notify(tx, {
        membershipIds: r.approver_membership_ids, kind: 'request.cancelled', title: `${me.name} cancelled a ${REQUEST_KIND_DEFS[r.kind as RequestKind].label.toLowerCase()} request`,
        body: `${view.when}${reason ? `\nReason: ${reason}` : ''}`, link: `/requests/${id}`, resource: { type: 'staff_request', id },
      });
      await this.notifications.signal(tx, [actor.membershipId, ...r.approver_membership_ids], 'approvals.changed');
      if (r.status === 'approved' && r.employee_id && ATTENDANCE_KINDS.has(r.kind)) await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
      await this.audit.record(tx, { action: 'staff_request.cancelled', resourceType: 'staff_request', resourceId: id, metadata: { reason: reason ?? null, was: r.status } });
      return this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id }))!);
    });
  }

  /** Called by the approvals engine when everyone approved, or someone rejected. */
  private async closed(tx: TenantTx, req: ApprovalRequestRow, status: 'approved' | 'rejected') {
    const r = await tx.collection('staff_requests').findOne({ id: req.resource_id });
    if (!r || !(await tx.collection('staff_requests').updateOne({ id: r.id, status: 'pending' }, { $set: { status, decided_at: new Date() } }))) return;
    const def = REQUEST_KIND_DEFS[r.kind as RequestKind];
    const view = await this.viewOf(tx, { ...r, status, decided_at: new Date() });
    const comments = view.approvers.filter((a) => a.comment).map((a) => `${a.name}: "${a.comment}"`).join('\n');
    if (status === 'approved' && r.employee_id && ATTENDANCE_KINDS.has(r.kind)) await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
    const applyNow = status === 'approved' && def.leadsToLeave && r.employee_id;
    await this.notifications.notify(tx, {
      membershipIds: [r.requester_membership_id],
      kind: `request.${status}`,
      title: applyNow ? `${def.label} request approved: apply for your leave now` : `${def.label} request ${status}`,
      body: `${view.when}.${status === 'rejected' ? `\nReason: ${req.comment ?? 'not given'}` : ''}${comments ? `\n${comments}` : ''}${applyNow ? '\nOpen the request and press "Apply for leave": the form is already filled in.' : ''}`,
      link: applyNow ? `/requests/${r.id}/apply` : `/requests/${r.id}`,
      email: true,
      priority: status === 'rejected' || applyNow ? 'high' : 'normal',
      action: Boolean(applyNow),
      resource: { type: 'staff_request', id: r.id },
    });
    await this.notifications.signal(tx, [r.requester_membership_id], 'approvals.changed');
    await this.audit.record(tx, { action: `staff_request.${status}`, resourceType: 'staff_request', resourceId: r.id, metadata: { comment: req.comment ?? null } });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Applying for the leave from an approved request
  // ---------------------------------------------------------------------------------------------------------

  /** The leave application form, filled in: the person, their manager and HR, the leave types and balances, the days and reason. */
  leaveForm(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('staff_requests').findOne({ id });
      if (!r || r.requester_membership_id !== actor.membershipId) throw Errors.notFound('Request');
      return this.formOf(tx, r);
    });
  }

  private async formOf(tx: TenantTx, r: Doc) {
    const view = await this.viewOf(tx, r);
    const c = await this.circle(tx, r.requester_membership_id);
    const e = c.employee;
    const people = await this.peopleOf(tx, [r.requester_membership_id, c.manager, c.hr[0]]);
    const me = people.get(r.requester_membership_id)!;
    const manager = c.manager ? people.get(c.manager) ?? null : null;
    const hr = c.hr[0] ? people.get(c.hr[0]) ?? null : null;
    const legalEntity = e?.current_legal_entity_id ? await tx.collection('legal_entities').findOne({ id: e.current_legal_entity_id }, { projection: { name: 1 } }) : null;
    const tenant = await tx.collection('tenants').findOne({}, { projection: { name: 1 } });
    const balances = e ? await this.leave.balancesIn(tx, e.id, Number(r.start_date.slice(0, 4))).catch(() => []) : [];
    const halfDay = r.kind === 'half_day';
    const firstHalf = halfDay && (r.start_time ?? '09:00') < '13:00';
    return {
      request: view,
      company: (legalEntity?.name as string | undefined) ?? (tenant?.name as string | undefined) ?? '',
      applicant: {
        name: e ? displayName(e as never) : me.name, employeeCode: me.employeeCode, designation: me.designation, department: me.department,
        levelLabel: me.levelLabel, workspace: me.workspace, dateOfJoining: (e?.date_of_joining as string | undefined) ?? null,
        email: (e?.work_email as string | undefined) ?? null,
      },
      reportingManager: manager ? { name: manager.name, designation: manager.designation, levelLabel: manager.levelLabel } : null,
      hrManager: hr ? { name: hr.name, designation: hr.designation, levelLabel: hr.levelLabel } : null,
      sendTo: view.approvers.map((a) => ({ membershipId: a.membershipId, name: a.name, levelLabel: a.levelLabel, designation: a.designation })),
      leaveTypes: balances.map((b) => ({ id: b.leaveTypeId, name: b.name as string, code: b.code as string, color: b.color as string, available: b.available, notAssigned: b.notAssigned, allowHalfDay: Boolean(b.allowHalfDay) })),
      prefill: {
        leaveTypeId: (r.leave_type_id as string | null) ?? null,
        startDate: r.start_date as string, endDate: r.end_date as string,
        // A half-day request in the morning is the first half of the day; in the afternoon the second.
        startHalf: halfDay && !firstHalf ? 'second_half' : 'full',
        endHalf: halfDay && firstHalf ? 'first_half' : 'full',
        reason: r.reason as string,
      },
      hasEmployeeRecord: Boolean(e),
    };
  }

  applyLeave(id: string, input: RequestLeaveApplicationInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('staff_requests').findOne({ id });
      if (!r || r.requester_membership_id !== actor.membershipId) throw Errors.notFound('Request');
      // The leave application itself is the Leave module: the plan must include it.
      await this.entitlements.requireFeature('leave', tx);
      await tx.collection('staff_requests').lock({ id });
      const form = await this.formOf(tx, r);
      if (!form.hasEmployeeRecord) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
      if (!form.request.canApplyLeave) {
        throw Errors.conflict('invalid_state', r.status !== 'approved' ? 'Apply for leave once everyone you looped in has approved the request.' : form.request.leaveApplication ? 'You already applied for this leave.' : 'This request does not lead to a leave application.');
      }
      // The leave must stay within the days that were approved.
      if (input.startDate < r.start_date || input.endDate > r.end_date) throw Errors.badRequest('outside_request', `Apply for days between ${requestDateLabel(r.start_date)} and ${requestDateLabel(r.end_date)}: those were approved.`);
      const type = form.leaveTypes.find((t) => t.id === input.leaveTypeId);
      if (!type) throw Errors.badRequest('not_eligible', 'That leave type is not available to you');
      const snapshot = {
        company: form.company, applicant: form.applicant, reportingManager: form.reportingManager, hrManager: form.hrManager,
        leaveType: { id: type.id, name: type.name, code: type.code },
        startDate: input.startDate, endDate: input.endDate, startHalf: input.startHalf, endHalf: input.endHalf,
        reason: input.reason, contactDuringLeave: input.contactDuringLeave ?? null, handoverTo: input.handoverTo ?? null,
        requestRef: form.request.ref, requestId: r.id,
        approvedBy: form.request.approvers.map((a) => ({ name: a.name, levelLabel: a.levelLabel, comment: a.comment, decidedAt: a.decidedAt })),
        sendTo: form.sendTo, submittedAt: new Date().toISOString(),
      };
      const leaveInput: LeaveRequestInput = { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, startHalf: input.startHalf, endHalf: input.endHalf, reason: input.reason } as LeaveRequestInput;
      const application = await this.leave.requestIn(tx, leaveInput, { staffRequestId: r.id, approverMembershipIds: r.approver_membership_ids, form: snapshot });
      await tx.collection('staff_requests').updateOne({ id }, { $set: { leave_request_id: application.id } });
      // The leave application form by email to each approver, and a copy to the applicant.
      const ids = [...r.approver_membership_ids, actor.membershipId];
      const who = await memberIdentities(tx, ids);
      const approvalLink = application.approvalId ? `/approvals/${application.approvalId}` : `/leave/requests/${application.id}`;
      const days = String(application.days);
      for (const m of ids) {
        const to = who.get(m)?.email;
        if (!to) continue;
        const copy = m === actor.membershipId;
        const mail = leaveApplicationEmail({ form: snapshot, days, reference: leaveRef(application.id as string), link: this.notifications.webUrl(copy ? `/leave/requests/${application.id}` : approvalLink), recipientName: who.get(m)?.name ?? '', copy });
        await this.notifications.queueHtmlEmail(tx, actor.tenantId, to, mail.subject, mail.text, mail.html, 'leave.application');
      }
      await this.audit.record(tx, { action: 'staff_request.leave_applied', resourceType: 'staff_request', resourceId: id, metadata: { leaveRequestId: application.id, reference: leaveRef(application.id as string) } });
      return { leaveRequest: application, request: await this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id }))!) };
    });
  }

  /** The Requests card on Approvals and the menu badge: how many of the caller's requests were decided in the last week. */
  summary() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('staff_requests').find({ requester_membership_id: actor.membershipId }, { projection: { status: 1, kind: 1, leave_request_id: 1, employee_id: 1 }, limit: 1000 });
      const toApply = rows.filter((r) => r.status === 'approved' && REQUEST_KIND_DEFS[r.kind as RequestKind].leadsToLeave && r.employee_id && !r.leave_request_id).length;
      return { pending: rows.filter((r) => r.status === 'pending').length, toApply };
    });
  }
}

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import {
  DEFAULT_LEAVE_TYPES, LEAVE_AUTHORITY_LABELS, leaveAllocationWithin, leaveApprovalRules, leaveEligibility, leaveEligible, leaveMath, leaveRef, leaveRoutesFor,
  leaveTypePolicy, STANDARD_LEAVE_TYPES,
  type LeaveAllocationInput, type LeaveAuthority, type LeaveModifyInput, type LeaveRequestInput, type LeaveTemplate, type LeaveTypeInput, type LeaveTypeUpdate, type WorkCalendar,
} from '@crew/contracts';
import type {
  holidayCalendarInput, holidayInput, leaveAdjustmentInput, leaveAdjustmentsQuery, leaveBalanceOverviewQuery, leaveHistoryQuery, leaveReportQuery,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor, hasPermission, type ResourceAttributes, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { ApprovalsService, type ApprovalRequestRow, type StepDef } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { CommFilesService } from '../communication/files.service';
import type { UploadedFile } from '../documents/documents.service';
import { DisciplineService } from '../discipline/discipline.service';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { employeeNames, fieldById } from '../employees/employee-view';
import {
  addDays, allocationReaches, availableTo, cmp, configOf, countLeaveDays, criteriaOf, daysBetweenInclusive, type Doc, type EmployeeLite, entitlementsOf, type Entitlement, fromH,
  genderOk, groupsByMembership, type LeaveBook, lite, loadBook, loadPeople, personOf, sumBy, today, toH, yearOf,
} from './leave-model';

interface RequestRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  days: string;
  status: string;
  approval_request_id: string | null;
  requested_by_membership_id: string | null;
  start_half: 'full' | 'second_half';
  end_half: 'full' | 'first_half';
  reason?: string | null;
  replaces_request_id?: string | null;
  modifications?: Doc[];
  approval_route?: LeaveAuthority | null;
  document_ids?: string[];
}

type Level = 'super' | 'hr';
/** Where an HR person acts from: one of their HR Workspaces, or the company's HR team (null). */
interface HrReach { company: boolean; hrWorkspaceIds: string[] }
interface Authority { authority: 'hr' | 'super'; label: string; hrWorkspaceId: string | null; hrWorkspaceName: string | null; company: boolean; membershipId: string | null; name: string | null }

const TYPE_FIELDS = {
  code: 'code', name: 'name', description: 'description', category: 'category', paid: 'paid', allowHalfDay: 'allow_half_day', color: 'color', kind: 'kind',
  eligibleGender: 'eligible_gender', countsCalendarDays: 'counts_calendar_days', effectiveFrom: 'effective_from', hrAllocatable: 'hr_allocatable',
  eligibility: 'eligibility', policy: 'policy', approval: 'approval',
} as const;

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const range = (a: string, b: string) => (a === b ? a : `${a} to ${b}`);

/**
 * Leave management (rebuilt). One record for each leave type (with its policy and approval rules, versioned), each
 * allocation, each request and each balance line, used by the Super Workspace, the HR Workspaces and the Employee
 * Workspace through this one service:
 *  - leave:configure (Super Workspace only) creates and changes types and makes them available to HR Workspaces;
 *  - leave:allocate gives a type to employees: the Super Workspace to anyone eligible, an HR Workspace only types made
 *    available to it, only to its own people and never outside the type's eligibility;
 *  - an application goes to the HR Workspace, the Super Workspace or both, as the type's rules (and, where they allow,
 *    the employee) decide, through the shared approvals engine; it is approved when every authority approved it;
 *  - balances come from the append-only ledger: approval writes a 'taken' line, cancelling approved leave a reversal.
 */
@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly attendance: AttendanceService,
    private readonly discipline: DisciplineService,
    private readonly files: CommFilesService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    this.approvals.register('leave_request', {
      permission: 'leave:approve',
      configurePermission: 'leave:configure',
      defaultSteps: [{ type: 'hr_workspace', hrWorkspaceId: null }],
      fallbackRole: 'hr_workspace',
      label: 'Leave request',
      link: (id) => `/leave/requests/${id}`,
      chainSetByModule: 'Leave approvals are set on each leave type: Leave management > Leave types > Approval.',
      attributes: async (tx, id) => {
        const r = await tx.collection('leave_requests').findOne({ id });
        return this.attrsOf(await this.employee(tx, r!.employee_id));
      },
      onApproved: (tx, req) => this.onApproved(tx, req),
      details: async (tx, id) => {
        const d = await this.discipline.leaveDetails(tx, id);
        const r = await tx.collection('leave_requests').findOne({ id });
        return {
          ...(d ? { sameDayLeave: d } : {}),
          ...(r ? { leaveReference: leaveRef(id), approvalRoute: r.approval_route ?? null, approvalRouteLabel: r.approval_route ? LEAVE_AUTHORITY_LABELS[r.approval_route as LeaveAuthority] : null } : {}),
        };
      },
      documents: async (tx, id) => {
        const r = await tx.collection('leave_requests').findOne({ id });
        const ids = (r?.document_ids as string[] | undefined) ?? [];
        const names = await fieldById(tx, 'comm_files', ids);
        return ids.map((f) => ({ name: names.get(f) ?? 'Document', href: `/leave-documents/${id}/${f}` }));
      },
      onRejected: async (tx, req) => {
        await tx.collection('leave_requests').updateOne({ id: req.resource_id, status: 'pending' }, { $set: { status: 'rejected', decided_at: new Date() } });
        await this.discipline.onLeaveClosed(tx, req.resource_id, 'rejected');
        await this.audit.record(tx, { action: 'leave_request.rejected', resourceType: 'leave_request', resourceId: req.resource_id, metadata: { comment: req.comment ?? null } });
      },
      onProgress: async (tx, req) => {
        await this.audit.record(tx, { action: 'leave_request.partly_approved', resourceType: 'leave_request', resourceId: req.resource_id, metadata: { comment: req.comment ?? null } });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Who is acting
  // ---------------------------------------------------------------------------------------------------------

  private async actorName(tx: TenantTx): Promise<string | null> {
    const actor = requestContext.tenantActor();
    return (await membershipUserNames(tx, [actor.membershipId])).get(actor.membershipId) ?? null;
  }

  private levelOf(s: Subject): Level {
    return hasPermission(s, 'leave:configure').allowed ? 'super' : 'hr';
  }

  /** Where an HR person allocates and reviews from: HR Workspaces named in their access, or the company's HR team. */
  private hrReach(s: Subject): HrReach {
    const grants = s.grants.filter((g) => (g.permission === 'leave:allocate' || g.permission === 'leave:approve') && g.roleKey === 'hr_workspace');
    return {
      company: grants.some((g) => !g.constraints.hrWorkspaceIds?.length),
      hrWorkspaceIds: [...new Set(grants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))],
    };
  }

  private async employee(tx: TenantTx, id: string): Promise<EmployeeLite> {
    const e = await tx.collection('employees').findOne({ id });
    if (!e) throw Errors.notFound('Employee');
    const groups = await groupsByMembership(tx, [e.membership_id ?? null]);
    return lite(e, e.membership_id ? groups.get(e.membership_id) ?? [] : []);
  }

  private attrsOf(e: EmployeeLite): ResourceAttributes {
    return employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });
  }

  /** The caller's employee id, or a clear error when their login is not linked to an employee record. */
  private async myEmployeeId(tx: TenantTx): Promise<string> {
    const s = await this.authz.subject(tx);
    if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
    return s.employeeId;
  }

  /** Ids of the employees whose records the caller may see for a permission (the scope of a list). */
  private async visibleEmployeeIds(tx: TenantTx, permission: string): Promise<string[]> {
    const scope = await this.authz.filter(permission, EMPLOYEE_FIELDS, tx);
    return (await tx.collection('employees').find(scope, { projection: { _id: 1 } })).map((e) => e.id as string);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Leave types
  // ---------------------------------------------------------------------------------------------------------

  private async typeViews(tx: TenantTx, types: Doc[], book?: LeaveBook) {
    const b = book ?? (await loadBook(tx, { includeInactive: true }));
    const hrNames = await fieldById(tx, 'hr_workspaces', b.allocations.map((a) => a.hr_workspace_id));
    const used = new Set(await tx.collection('leave_requests').distinct<string>('leave_type_id', { leave_type_id: { $in: types.map((t) => t.id) } }));
    return types.map((t) => {
      const cfg = configOf(t);
      const allocs = b.allocations.filter((a) => a.leave_type_id === t.id);
      return {
        id: t.id as string, code: t.code as string, name: t.name as string, description: (t.description as string | null) ?? null, category: (t.category as string | undefined) ?? 'general',
        paid: Boolean(t.paid), allowHalfDay: Boolean(t.allow_half_day), color: t.color as string, kind: (t.kind as string | undefined) ?? 'standard',
        eligibleGender: (t.eligible_gender as string | undefined) ?? 'any', countsCalendarDays: Boolean(t.counts_calendar_days),
        effectiveFrom: (t.effective_from as string | null) ?? null, hrAllocatable: t.hr_allocatable !== false,
        active: !t.archived_at, archivedAt: t.archived_at ?? null, deactivatedReason: (t.deactivated_reason as string | null) ?? null,
        version: (t.version as number | undefined) ?? 1,
        eligibility: cfg.eligibility, policy: cfg.policy, approval: cfg.approval,
        createdBy: { name: (t.created_by_name as string | null) ?? null, level: (t.created_by_level as string | null) ?? null, at: iso(t.created_at) },
        updatedBy: { name: (t.updated_by_name as string | null) ?? null, level: (t.updated_by_level as string | null) ?? null, at: iso(t.updated_at) },
        allocations: {
          employees: allocs.filter((a) => a.target === 'employees').length,
          hrWorkspaces: allocs.filter((a) => a.target === 'hr_workspace').map((a) => ({ id: (a.hr_workspace_id as string | null) ?? null, name: a.hr_workspace_id ? hrNames.get(a.hr_workspace_id) ?? null : 'Company HR team' })),
        },
        used: used.has(t.id),
      };
    });
  }

  /**
   * Leave types the caller may see: the Super Workspace every one; an HR Workspace those made available to it or
   * allocated to its people; anyone else the types they hold.
   */
  listTypes(includeArchived = false) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const book = await loadBook(tx, { includeInactive: true });
      let types = book.types.filter((t) => includeArchived || !t.archived_at);
      if (!hasPermission(s, 'leave:configure').allowed) {
        const ids = new Set<string>();
        if (hasPermission(s, 'leave:allocate').allowed) {
          const reach = this.hrReach(s);
          for (const a of book.allocations) {
            if (a.target === 'hr_workspace' && ((a.hr_workspace_id && reach.hrWorkspaceIds.includes(a.hr_workspace_id)) || (!a.hr_workspace_id && reach.company))) ids.add(a.leave_type_id);
          }
        }
        if (s.employeeId) for (const id of entitlementsOf(book, await this.employee(tx, s.employeeId), { includeInactive: includeArchived }).keys()) ids.add(id);
        types = types.filter((t) => ids.has(t.id));
      }
      return this.typeViews(tx, types, book);
    });
  }

  getType(id: string) {
    return this.db.tenant(async (tx) => {
      const t = await tx.collection('leave_types').findOne({ id });
      if (!t) throw Errors.notFound('Leave type');
      const visible = (await this.listTypesIn(tx, true)).some((x) => x.id === id);
      if (!visible) throw Errors.notFound('Leave type');
      const [view] = await this.typeViews(tx, [t]);
      return { ...view!, history: await this.historyRows(tx, { leaveTypeId: id, limit: 100 }) };
    });
  }

  private async listTypesIn(tx: TenantTx, includeArchived: boolean) {
    const s = await this.authz.subject(tx);
    const book = await loadBook(tx, { includeInactive: true });
    if (hasPermission(s, 'leave:configure').allowed) return book.types.filter((t) => includeArchived || !t.archived_at);
    const ids = new Set<string>();
    const reach = this.hrReach(s);
    for (const a of book.allocations) if (a.target === 'hr_workspace' && ((a.hr_workspace_id && reach.hrWorkspaceIds.includes(a.hr_workspace_id)) || (!a.hr_workspace_id && reach.company))) ids.add(a.leave_type_id);
    if (s.employeeId) for (const id of entitlementsOf(book, await this.employee(tx, s.employeeId), { includeInactive: true }).keys()) ids.add(id);
    return book.types.filter((t) => ids.has(t.id) && (includeArchived || !t.archived_at));
  }

  private snapshot(t: Doc) {
    return {
      code: t.code, name: t.name, description: t.description ?? null, category: t.category, paid: t.paid, allowHalfDay: t.allow_half_day, color: t.color, kind: t.kind,
      eligibleGender: t.eligible_gender, countsCalendarDays: t.counts_calendar_days, effectiveFrom: t.effective_from ?? null, hrAllocatable: t.hr_allocatable,
      eligibility: t.eligibility, policy: t.policy, approval: t.approval, active: !t.archived_at,
    };
  }

  private async checkRefs(tx: TenantTx, input: { eligibility?: LeaveTypeInput['eligibility']; approval?: LeaveTypeInput['approval'] }) {
    const e = input.eligibility;
    if (e) {
      for (const [ids, table, label] of [[e.departmentIds, 'departments', 'department'], [e.designationIds, 'designations', 'designation'], [e.locationIds, 'locations', 'location'], [e.legalEntityIds, 'legal_entities', 'legal entity'], [e.groupIds, 'comm_groups', 'employee group'], [e.employeeIds, 'employees', 'employee']] as const) {
        if (ids.length && (await tx.collection(table).count({ id: { $in: ids } })) !== ids.length) throw Errors.badRequest('unknown_reference', `A chosen ${label} does not exist`);
      }
    }
    const a = input.approval;
    if (a?.hrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: a.hrWorkspaceId, status: 'active' }))) throw Errors.badRequest('unknown_hr_workspace', 'That HR Workspace does not exist or is not active');
    if (a?.superApproverMembershipId) {
      const role = await tx.collection('roles').findOne({ key: 'super_workspace', is_system: true });
      const ok = role && (await tx.collection('role_assignments').exists({ role_id: role.id, membership_id: a.superApproverMembershipId }));
      if (!ok) throw Errors.badRequest('not_super_workspace', 'The approver must be a Super Workspace administrator');
    }
    if (a && a.employeeChooses && a.routes.length < 2) throw Errors.badRequest('one_route', 'Let employees choose only when the type allows two or more approval routes');
  }

  private async insertType(tx: TenantTx, input: LeaveTypeInput, by: { level: 'super' | 'system'; membershipId: string | null; name: string | null }, note?: string) {
    const row = await tx.collection('leave_types').insert({
      code: input.code, name: input.name, description: input.description ?? null, category: input.category, paid: input.paid, allow_half_day: input.allowHalfDay,
      color: input.color, kind: input.kind, eligible_gender: input.eligibleGender, counts_calendar_days: input.countsCalendarDays, effective_from: input.effectiveFrom,
      hr_allocatable: input.hrAllocatable, eligibility: input.eligibility, policy: input.policy, approval: input.approval, version: 1,
      ...(input.active ? {} : { archived_at: new Date(), deactivated_reason: 'Created inactive' }),
      created_by_level: by.level, created_by_membership_id: by.membershipId, created_by_name: by.name,
      updated_by_level: by.level, updated_by_membership_id: by.membershipId, updated_by_name: by.name,
    }).catch(conflictOn('23505', 'leave_type_exists', `A leave type with the code ${input.code} already exists`));
    await tx.collection('leave_type_versions').insert({
      leave_type_id: row.id, version: 1, action: 'created', by_level: by.level, by_membership_id: by.membershipId, by_name: by.name, changes: {}, snapshot: this.snapshot(row), note: note ?? null,
    });
    await this.audit.record(tx, { action: 'leave_type.created', resourceType: 'leave_type', resourceId: row.id, changes: input, metadata: { level: by.level, byName: by.name } });
    return row;
  }

  createType(input: LeaveTypeInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.checkRefs(tx, input);
      const row = await this.insertType(tx, input, { level: 'super', membershipId: actor.membershipId, name: await this.actorName(tx) });
      const [view] = await this.typeViews(tx, [row]);
      return view!;
    });
  }

  private templateInput(t: LeaveTemplate): LeaveTypeInput {
    return {
      code: t.code, name: t.name, description: t.description, category: t.category, paid: t.paid, allowHalfDay: t.allowHalfDay, color: t.color, kind: t.kind,
      eligibleGender: t.eligibleGender, countsCalendarDays: t.countsCalendarDays, effectiveFrom: null, active: true, hrAllocatable: true,
      eligibility: leaveEligibility.parse({}),
      policy: leaveTypePolicy.parse({ accrualMethod: t.accrualMethod, annualEntitlement: t.annualEntitlement, carryForwardMax: t.carryForwardMax }),
      approval: leaveApprovalRules.parse({}),
    } as LeaveTypeInput;
  }

  /**
   * Creates types from templates (the starter PL, CL and SL, or any of the catalogue). Codes already used are
   * skipped. Nothing is allocated: the types reach nobody until they are allocated.
   */
  addTemplates(codes: string[]) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const wanted = STANDARD_LEAVE_TYPES.filter((t) => codes.includes(t.code));
      const unknown = codes.filter((c) => !STANDARD_LEAVE_TYPES.some((t) => t.code === c));
      if (unknown.length) throw Errors.badRequest('unknown_standard_type', `Not in the template list: ${unknown.join(', ')}`);
      const taken = new Set((await tx.collection('leave_types').find({ code: { $in: wanted.map((t) => t.code) } }, { projection: { code: 1 } })).map((t) => t.code as string));
      const name = await this.actorName(tx);
      const added: string[] = [];
      for (const t of wanted) {
        if (taken.has(t.code)) continue;
        await this.insertType(tx, this.templateInput(t), { level: 'super', membershipId: actor.membershipId, name }, 'Created from a template');
        added.push(t.code);
      }
      return { added, skipped: wanted.map((t) => t.code).filter((c) => taken.has(c)) };
    });
  }

  addStarterTypes() {
    return this.addTemplates(DEFAULT_LEAVE_TYPES.map((t) => t.code));
  }

  standardTypes() {
    return this.db.tenant(async (tx) => {
      const used = new Set((await tx.collection('leave_types').find({}, { projection: { code: 1 } })).map((t) => t.code as string));
      return STANDARD_LEAVE_TYPES.map((t) => ({ ...t, starter: DEFAULT_LEAVE_TYPES.some((d) => d.code === t.code), added: used.has(t.code) }));
    });
  }

  /**
   * Changes a type. The change applies to applications made from now on: requests keep the version they were made
   * under and approved leave is never changed. Refused when made on an older version than the saved one.
   */
  updateType(id: string, input: LeaveTypeUpdate) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const t = await tx.collection('leave_types').findOne({ id });
      if (!t) throw Errors.notFound('Leave type');
      await tx.collection('leave_types').lock({ id });
      const version = (t.version as number | undefined) ?? 1;
      if (input.version !== undefined && input.version !== version) throw Errors.conflict('stale_version', 'Someone changed this leave type meanwhile. Reload it and make your change again.');
      await this.checkRefs(tx, { eligibility: input.eligibility, approval: input.approval });
      const set: Doc = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [k, col] of Object.entries(TYPE_FIELDS)) {
        const v = (input as Record<string, unknown>)[k];
        if (v === undefined) continue;
        const before = t[col] ?? null;
        if (JSON.stringify(before) === JSON.stringify(v)) continue;
        set[col] = v;
        changes[k] = { from: before, to: v };
      }
      if (!Object.keys(set).length) {
        const [view] = await this.typeViews(tx, [t]);
        return view!;
      }
      const name = await this.actorName(tx);
      await tx.collection('leave_types').updateOne({ id }, { $set: { ...set, version: version + 1, updated_by_level: 'super', updated_by_membership_id: actor.membershipId, updated_by_name: name } })
        .catch(conflictOn('23505', 'leave_type_exists', 'A leave type with this code already exists'));
      const saved = (await tx.collection('leave_types').findOne({ id }))!;
      await tx.collection('leave_type_versions').insert({
        leave_type_id: id, version: version + 1, action: 'updated', by_level: 'super', by_membership_id: actor.membershipId, by_name: name, changes, snapshot: this.snapshot(saved), note: input.note ?? null,
      });
      await this.audit.record(tx, { action: 'leave_type.updated', resourceType: 'leave_type', resourceId: id, changes, metadata: { version: version + 1, byName: name } });
      // HR Workspaces that run the type hear about a change to its rules.
      const hrIds = (await tx.collection('leave_allocations').find({ leave_type_id: id, target: 'hr_workspace', revoked_at: null })).map((a) => (a.hr_workspace_id as string | null) ?? null);
      const admins = await this.hrAdmins(tx, hrIds);
      await this.notifications.notify(tx, {
        membershipIds: admins.filter((m) => m !== actor.membershipId), kind: 'leave.type_changed', title: `${saved.name} was changed by ${name ?? 'the Super Workspace'}`,
        body: `Changed: ${Object.keys(changes).join(', ')}. It applies to applications from now on.`, link: `/leave/manage?tab=types&type=${id}`,
      });
      const [view] = await this.typeViews(tx, [saved]);
      return view!;
    });
  }

  /** Deactivates (no new applications or allocations; history stays) or activates a type again. */
  setTypeStatus(id: string, active: boolean, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const t = await tx.collection('leave_types').findOne({ id });
      if (!t) throw Errors.notFound('Leave type');
      if (!!t.archived_at === !active) throw Errors.conflict('no_change', active ? 'This leave type is already active' : 'This leave type is already inactive');
      const version = ((t.version as number | undefined) ?? 1) + 1;
      const name = await this.actorName(tx);
      await tx.collection('leave_types').updateOne({ id }, { $set: {
        archived_at: active ? null : new Date(), deactivated_reason: active ? null : reason, version, updated_by_level: 'super', updated_by_membership_id: actor.membershipId, updated_by_name: name,
      } });
      const saved = (await tx.collection('leave_types').findOne({ id }))!;
      await tx.collection('leave_type_versions').insert({
        leave_type_id: id, version, action: active ? 'activated' : 'deactivated', by_level: 'super', by_membership_id: actor.membershipId, by_name: name,
        changes: { active: { from: !active, to: active } }, snapshot: this.snapshot(saved), note: reason,
      });
      await this.audit.record(tx, { action: active ? 'leave_type.activated' : 'leave_type.deactivated', resourceType: 'leave_type', resourceId: id, metadata: { reason, byName: name } });
      const [view] = await this.typeViews(tx, [saved]);
      return view!;
    });
  }

  /** Removes a type that was never used or allocated. A type with any history can only be deactivated. */
  deleteType(id: string) {
    return this.db.tenant(async (tx) => {
      const t = await tx.collection('leave_types').findOne({ id });
      if (!t) throw Errors.notFound('Leave type');
      const inUse = (await tx.collection('leave_requests').exists({ leave_type_id: id })) || (await tx.collection('leave_ledger').exists({ leave_type_id: id }))
        || (await tx.collection('leave_allocations').exists({ leave_type_id: id }));
      if (inUse) throw Errors.conflict('leave_type_in_use', `${t.name} has allocations, balances or applications. Deactivate it instead: its history stays.`);
      await this.audit.record(tx, { action: 'leave_type.deleted', resourceType: 'leave_type', resourceId: id, metadata: { code: t.code, name: t.name, byName: await this.actorName(tx) } });
      await tx.collection('leave_type_versions').delete({ leave_type_id: id }).catch(() => undefined);
      await tx.collection('leave_types').deleteOne({ id });
    });
  }

  private async historyRows(tx: TenantTx, q: z.infer<typeof leaveHistoryQuery>) {
    const s = await this.authz.subject(tx);
    const visible = new Set((await this.listTypesIn(tx, true)).map((t) => t.id as string));
    const filter: Doc = q.leaveTypeId ? { leave_type_id: q.leaveTypeId } : {};
    const versions = (await tx.collection('leave_type_versions').find(filter, { sort: { created_at: -1 }, limit: q.limit })).filter((v) => visible.has(v.leave_type_id));
    const allocFilter: Doc = q.leaveTypeId ? { leave_type_id: q.leaveTypeId } : {};
    let allocs = (await tx.collection('leave_allocations').find(allocFilter, { sort: { created_at: -1 }, limit: q.limit })).filter((a) => visible.has(a.leave_type_id));
    if (!hasPermission(s, 'leave:configure').allowed) {
      const reach = this.hrReach(s);
      allocs = allocs.filter((a) => (a.hr_workspace_id ? reach.hrWorkspaceIds.includes(a.hr_workspace_id) : reach.company));
    }
    const names = await fieldById(tx, 'leave_types', [...versions, ...allocs].map((v) => v.leave_type_id));
    const hrNames = await fieldById(tx, 'hr_workspaces', allocs.map((a) => a.hr_workspace_id));
    const rows = [
      ...versions.map((v) => ({
        id: v.id as string, at: iso(v.created_at)!, kind: `type_${v.action as string}`, leaveTypeId: v.leave_type_id as string, leaveTypeName: names.get(v.leave_type_id) ?? null,
        version: v.version as number, byName: (v.by_name as string | null) ?? null, byLevel: v.by_level as string, changes: Object.keys(v.changes ?? {}), note: (v.note as string | null) ?? null,
      })),
      ...allocs.flatMap((a) => {
        const base = { leaveTypeId: a.leave_type_id as string, leaveTypeName: names.get(a.leave_type_id) ?? null, version: null, changes: [] as string[] };
        const to = a.target === 'hr_workspace' ? (a.hr_workspace_id ? hrNames.get(a.hr_workspace_id) ?? 'an HR Workspace' : 'the company HR team') : 'employees';
        const out = [{ ...base, id: `${a.id}:c`, at: iso(a.created_at)!, kind: a.target === 'hr_workspace' ? 'made_available' : 'allocated', byName: (a.by_name as string | null) ?? null, byLevel: a.by_level as string, note: `To ${to}${a.note ? `: ${a.note}` : ''}` }];
        if (a.revoked_at) out.push({ ...base, id: `${a.id}:r`, at: iso(a.revoked_at)!, kind: 'allocation_revoked', byName: (a.revoked_by_name as string | null) ?? null, byLevel: '', note: `From ${to}: ${a.revoked_reason ?? ''}` });
        return out;
      }),
    ];
    return rows.sort((a, b) => cmp(b.at, a.at)).slice(0, q.limit);
  }

  /** Leave type history: creation, every change, deactivation and every allocation, newest first. */
  history(q: z.infer<typeof leaveHistoryQuery>) {
    return this.db.tenant((tx) => this.historyRows(tx, q));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Allocation
  // ---------------------------------------------------------------------------------------------------------

  private async hrAdmins(tx: TenantTx, hrWorkspaceIds: (string | null)[]): Promise<string[]> {
    const role = await tx.collection('roles').findOne({ key: 'hr_workspace', is_system: true });
    if (!role) return [];
    const rows = await tx.collection('role_assignments').find({ role_id: role.id });
    const named = hrWorkspaceIds.filter((x): x is string => !!x);
    const company = hrWorkspaceIds.includes(null);
    return [...new Set(rows.filter((r) => {
      const ids = ((r.constraints?.hrWorkspaceIds ?? []) as string[]);
      return ids.some((x) => named.includes(x)) || (company && !ids.length);
    }).map((r) => r.membership_id as string))];
  }

  /** People an allocation reaches now (within the type's eligibility), at most `limit`. */
  private async reached(tx: TenantTx, book: LeaveBook, a: Doc, limit = 5000): Promise<EmployeeLite[]> {
    const t = book.types.find((x) => x.id === a.leave_type_id);
    if (!t) return [];
    const cfg = configOf(t);
    const people = await loadPeople(tx, { status: { $ne: 'exited' }, ...(a.hr_workspace_id ? { hr_workspace_id: a.hr_workspace_id } : {}) }, { limit: 20000 });
    return people.filter((e) => genderOk(t, e) && leaveEligible(cfg.eligibility, personOf(e)) && allocationReaches(book, a, e)).slice(0, limit);
  }

  private async allocationViews(tx: TenantTx, rows: Doc[], book: LeaveBook) {
    const types = new Map(book.types.map((t) => [t.id as string, t]));
    const hrNames = await fieldById(tx, 'hr_workspaces', rows.map((a) => a.hr_workspace_id));
    const lists = rows.map(criteriaOf);
    const deps = await fieldById(tx, 'departments', lists.flatMap((c) => c.departmentIds));
    const desig = await fieldById(tx, 'designations', lists.flatMap((c) => c.designationIds));
    const locs = await fieldById(tx, 'locations', lists.flatMap((c) => c.locationIds));
    const ents = await fieldById(tx, 'legal_entities', lists.flatMap((c) => c.legalEntityIds));
    const groups = await fieldById(tx, 'comm_groups', lists.flatMap((c) => c.groupIds));
    const people = await employeeNames(tx, lists.flatMap((c) => c.employeeIds));
    const out = [];
    for (const a of rows) {
      const c = criteriaOf(a);
      const t = types.get(a.leave_type_id);
      out.push({
        id: a.id as string, leaveTypeId: a.leave_type_id as string, leaveTypeName: (t?.name as string | undefined) ?? null, leaveTypeCode: (t?.code as string | undefined) ?? null,
        target: a.target as 'employees' | 'hr_workspace', hrWorkspaceId: (a.hr_workspace_id as string | null) ?? null,
        hrWorkspaceName: a.hr_workspace_id ? hrNames.get(a.hr_workspace_id) ?? null : a.target === 'hr_workspace' ? 'Company HR team' : null,
        criteria: c,
        summary: a.target === 'hr_workspace' ? 'May allocate it to its people and reviews their applications' : c.all ? 'Everyone eligible' : [
          c.employmentTypes.length ? `Employment: ${c.employmentTypes.join(', ')}` : null,
          c.departmentIds.length ? `Departments: ${c.departmentIds.map((d) => deps.get(d) ?? '?').join(', ')}` : null,
          c.designationIds.length ? `Designations: ${c.designationIds.map((d) => desig.get(d) ?? '?').join(', ')}` : null,
          c.locationIds.length ? `Locations: ${c.locationIds.map((d) => locs.get(d) ?? '?').join(', ')}` : null,
          c.legalEntityIds.length ? `Legal entities: ${c.legalEntityIds.map((d) => ents.get(d) ?? '?').join(', ')}` : null,
          c.groupIds.length ? `Groups: ${c.groupIds.map((d) => groups.get(d) ?? '?').join(', ')}` : null,
          c.employeeIds.length ? `People: ${c.employeeIds.map((d) => people.get(d)?.name ?? '?').join(', ')}` : null,
        ].filter(Boolean).join(' · '),
        entitlementDays: a.entitlement_days !== null && a.entitlement_days !== undefined ? String(a.entitlement_days) : null,
        note: (a.note as string) ?? '',
        byName: (a.by_name as string | null) ?? null, byLevel: a.by_level as string, createdAt: iso(a.created_at),
        revokedAt: iso(a.revoked_at), revokedByName: (a.revoked_by_name as string | null) ?? null, revokedReason: (a.revoked_reason as string | null) ?? null,
        reach: a.target === 'employees' && !a.revoked_at ? (await this.reached(tx, book, a)).length : null,
      });
    }
    return out;
  }

  /**
   * Allocations the caller may see: the Super Workspace every one; an HR Workspace what was made available to it and
   * the allocations made for its people.
   */
  listAllocations(q: { leaveTypeId?: string; includeRevoked?: boolean }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const book = await loadBook(tx, { includeInactive: true });
      let rows = await tx.collection('leave_allocations').find({ ...(q.leaveTypeId ? { leave_type_id: q.leaveTypeId } : {}), ...(q.includeRevoked ? {} : { revoked_at: null }) }, { sort: { created_at: -1 }, limit: 500 });
      if (!hasPermission(s, 'leave:configure').allowed) {
        const reach = this.hrReach(s);
        rows = rows.filter((a) => (a.hr_workspace_id ? reach.hrWorkspaceIds.includes(a.hr_workspace_id) : reach.company && (a.target === 'hr_workspace' || a.by_level === 'hr')));
      }
      return this.allocationViews(tx, rows, book);
    });
  }

  /** The people an allocation would reach, before it is saved (names, at most 200). */
  previewAllocation(input: LeaveAllocationInput) {
    return this.db.tenant(async (tx) => {
      if (input.target !== 'employees') throw Errors.badRequest('preview_employees_only', 'Only an allocation to employees has people to preview');
      const s = await this.authz.subject(tx);
      const book = await loadBook(tx);
      await this.checkAllocation(tx, s, book, input);
      const draft = { target: 'employees', leave_type_id: input.leaveTypeId, hr_workspace_id: input.hrWorkspaceId, criteria: input.criteria, by_level: this.levelOf(s) === 'super' ? 'super' : 'hr-preview', created_at: new Date() };
      const people = await this.reached(tx, book, draft);
      const visible = new Set(await this.visibleEmployeeIds(tx, 'leave:allocate'));
      const shown = people.filter((p) => visible.has(p.id));
      return { count: shown.length, people: shown.slice(0, 200).map((p) => ({ id: p.id, name: p.name, code: p.code })) };
    });
  }

  /** Checks who may allocate what, and returns the HR Workspace the allocation is limited to. */
  private async checkAllocation(tx: TenantTx, s: Subject, book: LeaveBook, input: LeaveAllocationInput): Promise<void> {
    const t = book.types.find((x) => x.id === input.leaveTypeId);
    if (!t) throw Errors.badRequest('invalid_leave_type', 'That leave type does not exist or is inactive');
    const level = this.levelOf(s);
    if (input.target === 'hr_workspace') {
      if (level !== 'super') throw Errors.forbidden('Only the Super Workspace makes leave types available to HR Workspaces');
      if (t.hr_allocatable === false) throw Errors.badRequest('not_hr_allocatable', `${t.name} is set so that only the Super Workspace allocates it`);
      if (input.hrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: input.hrWorkspaceId, status: 'active' }))) throw Errors.badRequest('unknown_hr_workspace', 'That HR Workspace does not exist or is not active');
      if (availableTo(book, t.id, input.hrWorkspaceId)) throw Errors.conflict('already_available', `${t.name} is already available to that HR Workspace`);
      return;
    }
    const c = input.criteria;
    for (const [ids, table, label] of [[c.departmentIds, 'departments', 'department'], [c.designationIds, 'designations', 'designation'], [c.locationIds, 'locations', 'location'], [c.legalEntityIds, 'legal_entities', 'legal entity'], [c.groupIds, 'comm_groups', 'employee group'], [c.employeeIds, 'employees', 'employee']] as const) {
      if (ids.length && (await tx.collection(table).count({ id: { $in: ids } })) !== ids.length) throw Errors.badRequest('unknown_reference', `A chosen ${label} does not exist`);
    }
    if (input.hrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: input.hrWorkspaceId }))) throw Errors.badRequest('unknown_hr_workspace', 'That HR Workspace does not exist');
    if (level === 'super') return;
    // An HR Workspace: only a type made available to the HR Workspace it acts for, only its own people, within eligibility.
    const reach = this.hrReach(s);
    const acting = input.hrWorkspaceId;
    if (acting ? !reach.hrWorkspaceIds.includes(acting) : !reach.company) {
      throw Errors.forbidden(acting ? 'You do not run that HR Workspace' : reach.hrWorkspaceIds.length === 1 ? 'Choose your HR Workspace' : 'Choose which of your HR Workspaces this is for');
    }
    if (!availableTo(book, t.id, acting)) throw Errors.forbidden(`${t.name} has not been made available to this HR Workspace by the Super Workspace`);
    const cfg = configOf(t);
    const peopleOnly = c.employeeIds.length > 0 && !c.all && c.employmentTypes.length + c.departmentIds.length + c.designationIds.length + c.locationIds.length + c.legalEntityIds.length + c.groupIds.length === 0;
    if (!peopleOnly && !leaveAllocationWithin(c, cfg.eligibility)) {
      throw Errors.badRequest('outside_eligibility', `${t.name} is limited by the Super Workspace: choose only departments, designations, employment types or groups inside its eligibility`);
    }
    if (c.employeeIds.length) {
      const named = await loadPeople(tx, { id: { $in: c.employeeIds } });
      const visible = new Set(await this.visibleEmployeeIds(tx, 'leave:allocate'));
      for (const e of named) {
        if (!visible.has(e.id) || (acting && e.hr_workspace_id !== acting)) throw Errors.badRequest('outside_hr_workspace', `${e.name} is not one of this HR Workspace's people`);
        if (!genderOk(t, e) || !leaveEligible(cfg.eligibility, personOf(e))) throw Errors.badRequest('outside_eligibility', `${e.name} is outside the eligibility of ${t.name} set by the Super Workspace`);
      }
    }
  }

  allocate(input: LeaveAllocationInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const book = await loadBook(tx);
      await this.checkAllocation(tx, s, book, input);
      const level = this.levelOf(s);
      const name = await this.actorName(tx);
      // An HR person allocating for the company HR team, or the only HR Workspace they run, is recorded with it.
      const row = await tx.collection('leave_allocations').insert({
        leave_type_id: input.leaveTypeId, target: input.target, hr_workspace_id: input.hrWorkspaceId,
        criteria: input.target === 'employees' ? input.criteria : {}, entitlement_days: input.target === 'employees' ? input.entitlementDays : null, note: input.note,
        by_level: level, by_membership_id: actor.membershipId, by_name: name,
      }).catch(conflictOn('23505', 'already_available', 'That leave type is already available to that HR Workspace'));
      const t = book.types.find((x) => x.id === input.leaveTypeId)!;
      await this.audit.record(tx, {
        action: input.target === 'hr_workspace' ? 'leave_type.made_available' : 'leave_allocation.created', resourceType: 'leave_allocation', resourceId: row.id,
        changes: input, metadata: { level, byName: name, leaveType: t.code },
      });
      const fresh = await loadBook(tx);
      if (input.target === 'hr_workspace') {
        const admins = await this.hrAdmins(tx, [input.hrWorkspaceId]);
        await this.notifications.notify(tx, {
          membershipIds: admins.filter((m) => m !== actor.membershipId), kind: 'leave.type_available', title: `${t.name} is now available to your HR Workspace`,
          body: `${name ?? 'The Super Workspace'} made ${t.name} (${t.code}) available. You can allocate it to your people and you review their applications.`, link: '/leave/manage?tab=allocation',
        });
      } else {
        const people = await this.reached(tx, fresh, row);
        // Balances are credited at once for the people it reaches.
        for (const e of people) await this.runAccruals(tx, today(), e.id);
        await this.notifications.notify(tx, {
          membershipIds: people.map((p) => p.membership_id).filter((m) => m !== actor.membershipId), kind: 'leave.allocated', title: `You can now apply for ${t.name}`,
          body: `${name ?? 'HR'} (${level === 'super' ? 'Super Workspace' : 'HR Workspace'}) gave you ${t.name}.`, link: '/leave',
        });
      }
      const [view] = await this.allocationViews(tx, [row], fresh);
      return view!;
    });
  }

  /** Takes an allocation back. Balances already credited stay in the history; the type leaves the people it reached. */
  revokeAllocation(id: string, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const a = await tx.collection('leave_allocations').findOne({ id, revoked_at: null });
      if (!a) throw Errors.notFound('Allocation');
      const s = await this.authz.subject(tx);
      if (this.levelOf(s) !== 'super') {
        const reach = this.hrReach(s);
        const mine = a.by_level === 'hr' && (a.hr_workspace_id ? reach.hrWorkspaceIds.includes(a.hr_workspace_id) : reach.company);
        if (!mine) throw Errors.forbidden('Only the Super Workspace can take back an allocation it made');
      }
      const name = await this.actorName(tx);
      await tx.collection('leave_allocations').updateOne({ id }, { $set: { revoked_at: new Date(), revoked_by_membership_id: actor.membershipId, revoked_by_name: name, revoked_reason: reason } });
      await this.audit.record(tx, { action: 'leave_allocation.revoked', resourceType: 'leave_allocation', resourceId: id, metadata: { reason, byName: name, target: a.target, leaveTypeId: a.leave_type_id } });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Holiday calendars
  // ---------------------------------------------------------------------------------------------------------

  listCalendars() {
    return this.db.tenant(async (tx) => {
      const calendars = await tx.collection('holiday_calendars').find({}, { sort: { is_default: -1, name: 1 } });
      const entities = await fieldById(tx, 'legal_entities', calendars.map((c) => c.legal_entity_id));
      const locations = await fieldById(tx, 'locations', calendars.map((c) => c.location_id));
      const holidays = await tx.collection('holidays').find({ calendar_id: { $in: calendars.map((c) => c.id) } }, { sort: { holiday_date: 1 } });
      return calendars.map((c) => ({
        id: c.id, name: c.name, legalEntityId: c.legal_entity_id ?? null, legalEntityName: entities.get(c.legal_entity_id) ?? null, locationId: c.location_id ?? null,
        locationName: locations.get(c.location_id) ?? null, isDefault: c.is_default, weeklyOffs: c.weekly_offs,
        holidays: holidays.filter((h) => h.calendar_id === c.id).map((h) => ({ id: h.id, date: h.holiday_date, name: h.name, isOptional: h.is_optional })),
      }));
    });
  }

  saveCalendar(id: string | null, input: z.infer<typeof holidayCalendarInput>) {
    return this.db.tenant(async (tx) => {
      if (input.isDefault) await tx.collection('holiday_calendars').update({ is_default: true, ...(id ? { id: { $ne: id } } : {}) }, { $set: { is_default: false } });
      const offs = [...new Set(input.weeklyOffs)].sort();
      let calendarId = id;
      const values = { name: input.name, legal_entity_id: input.legalEntityId ?? null, location_id: input.locationId ?? null, is_default: input.isDefault, weekly_offs: offs };
      if (id) {
        if (!(await tx.collection('holiday_calendars').updateOne({ id }, { $set: values }))) throw Errors.notFound('Holiday calendar');
      } else {
        calendarId = (await tx.collection('holiday_calendars').insert(values)).id as string;
      }
      await this.audit.record(tx, { action: id ? 'holiday_calendar.updated' : 'holiday_calendar.created', resourceType: 'holiday_calendar', resourceId: calendarId, changes: input });
      return { id: calendarId, ...input, weeklyOffs: offs };
    });
  }

  deleteCalendar(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('holiday_calendars').deleteOne({ id }))) throw Errors.notFound('Holiday calendar');
      await this.audit.record(tx, { action: 'holiday_calendar.deleted', resourceType: 'holiday_calendar', resourceId: id });
    });
  }

  addHoliday(calendarId: string, input: z.infer<typeof holidayInput>) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('holiday_calendars').exists({ id: calendarId }))) throw Errors.notFound('Holiday calendar');
      const row = await tx.collection('holidays').insert({ calendar_id: calendarId, holiday_date: input.date, name: input.name, is_optional: input.isOptional })
        .catch(conflictOn('23505', 'holiday_exists', 'This calendar already has a holiday on that date'));
      await this.audit.record(tx, { action: 'holiday.added', resourceType: 'holiday_calendar', resourceId: calendarId, changes: input });
      return { id: row!.id, ...input };
    });
  }

  removeHoliday(calendarId: string, holidayId: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('holidays').deleteOne({ id: holidayId, calendar_id: calendarId }))) throw Errors.notFound('Holiday');
      await this.audit.record(tx, { action: 'holiday.removed', resourceType: 'holiday_calendar', resourceId: calendarId, metadata: { holidayId } });
    });
  }

  /** The calendar for an employee: their location's, else their legal entity's, else the workspace default. */
  private async calendarFor(tx: TenantTx, e: Pick<EmployeeLite, 'legal_entity_id' | 'location_id'>): Promise<WorkCalendar & { id: string | null }> {
    const calendars = await tx.collection('holiday_calendars').find({
      $or: [...(e.location_id ? [{ location_id: e.location_id }] : []), ...(e.legal_entity_id ? [{ location_id: null, legal_entity_id: e.legal_entity_id }] : []), { is_default: true }],
    });
    const cal = calendars.find((c) => e.location_id && c.location_id === e.location_id)
      ?? calendars.find((c) => !c.location_id && e.legal_entity_id && c.legal_entity_id === e.legal_entity_id)
      ?? calendars.find((c) => c.is_default);
    if (!cal) return { id: null, weeklyOffs: [0, 6], holidays: new Set() };
    const hs = await tx.collection('holidays').find({ calendar_id: cal.id, is_optional: false }, { projection: { holiday_date: 1 } });
    return { id: cal.id, weeklyOffs: (cal.weekly_offs as number[]).map(Number), holidays: new Set(hs.map((h) => h.holiday_date as string)) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Balances
  // ---------------------------------------------------------------------------------------------------------

  async myCalendar(from: string, to: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, await this.myEmployeeId(tx));
      await this.authz.require('leave:read', this.attrsOf(e), tx);
      const cal = await this.calendarFor(tx, e);
      const holidays = cal.id
        ? (await tx.collection('holidays').find({ calendar_id: cal.id, holiday_date: { $gte: from, $lte: to } }, { sort: { holiday_date: 1 } })).map((h) => ({ date: h.holiday_date as string, name: h.name as string, optional: !!h.is_optional }))
        : [];
      const rows = await tx.collection('leave_requests').find({ employee_id: e.id, status: { $in: ['pending', 'approved'] }, end_date: { $gte: from }, start_date: { $lte: to } }, { sort: { start_date: 1 }, limit: 200 });
      return { from, to, weeklyOffs: cal.weeklyOffs, holidays, requests: await this.requestViews(tx, rows) };
    });
  }

  async balances(employeeId: string | undefined, year = yearOf(today())) {
    return this.db.tenant(async (tx) => {
      const id = employeeId ?? (await this.myEmployeeId(tx));
      const e = await this.employee(tx, id);
      await this.authz.require('leave:read', this.attrsOf(e), tx);
      return { employeeId: id, year, balances: await this.balanceRows(tx, e, year) };
    });
  }

  private async balanceRows(tx: TenantTx, e: EmployeeLite, year: number, book?: LeaveBook) {
    const b = book ?? (await loadBook(tx));
    const held = entitlementsOf(b, e);
    const ledger = await tx.collection('leave_ledger').find({ employee_id: e.id, leave_year: year }, { projection: { leave_type_id: 1, kind: 1, quantity: 1 } });
    const reqs = await tx.collection('leave_requests').find({ employee_id: e.id, status: { $in: ['pending', 'approved'] }, start_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }, { projection: { leave_type_id: 1, days: 1, status: 1, start_date: 1 } });
    const out = [];
    for (const [typeId, ent] of held) {
      const t = ent.type;
      const k = (kind: string) => sumBy(ledger.filter((l) => l.leave_type_id === typeId && l.kind === kind), (l) => l.quantity);
      const accrued = k('accrual');
      const carried = k('carry_forward');
      const adjusted = k('adjustment');
      const taken = -(k('taken') + k('reversal'));
      const lapsed = -k('lapse');
      const balance = accrued + carried + adjusted - taken - lapsed;
      const pend = sumBy(reqs.filter((p) => p.leave_type_id === typeId && p.status === 'pending'), (p) => p.days);
      const upcoming = sumBy(reqs.filter((p) => p.leave_type_id === typeId && p.status === 'approved' && p.start_date > today()), (p) => p.days);
      const tracked = ent.policy.accrualMethod !== 'none';
      out.push({
        leaveTypeId: typeId, code: t.code, name: t.name, color: t.color, paid: t.paid, allowHalfDay: t.allow_half_day, kind: (t.kind as string | undefined) ?? 'standard',
        category: (t.category as string | undefined) ?? 'general',
        tracked, annualEntitlement: fromH(toH(ent.annualEntitlement)), accrualMethod: ent.policy.accrualMethod,
        entitlement: fromH(accrued + carried + adjusted), accrued: fromH(accrued), carriedForward: fromH(carried), adjusted: fromH(adjusted), taken: fromH(taken), used: fromH(taken), lapsed: fromH(lapsed),
        balance: fromH(balance), pending: fromH(pend), upcomingApproved: fromH(upcoming), available: tracked ? fromH(balance - pend) : null,
      });
    }
    return out.sort((a, b2) => cmp(a.name, b2.name));
  }

  /** Every ledger line behind a balance, so any number on screen can be explained. */
  async ledger(employeeId: string, leaveTypeId: string, year: number) {
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, employeeId);
      await this.authz.require('leave:read', this.attrsOf(e), tx);
      const lines = (await tx.collection('leave_ledger').find({ employee_id: employeeId, leave_type_id: leaveTypeId, leave_year: year })).sort((a, b) => cmp(a.effective_on, b.effective_on) || a.created_at - b.created_at);
      const users = await (await usersTable(tx)).find({ id: { $in: [...new Set(lines.map((l) => l.created_by).filter(Boolean))] } }, { projection: { full_name: 1 } });
      const by = new Map(users.map((u) => [u.id, u.full_name ?? null]));
      return lines.map((l) => ({ id: l.id, kind: l.kind, quantity: l.quantity, effectiveOn: l.effective_on, note: l.note ?? null, leaveRequestId: l.leave_request_id ?? null, createdAt: l.created_at, by: by.get(l.created_by) ?? null }));
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The employee's leave
  // ---------------------------------------------------------------------------------------------------------

  /** Who would review an application of a type for a person, per route: the HR Workspace and the Super Workspace. */
  private async authoritiesFor(tx: TenantTx, book: LeaveBook, ent: Entitlement, e: EmployeeLite): Promise<{ hr: Authority | null; super: Authority }> {
    const rules = ent.approval;
    let hr: Authority | null = null;
    // HR goes to the HR Workspace the type names, else the person's own, else the company HR team; each only while the
    // type is available to it (an HR Workspace not given a type never reviews it).
    const candidates: (string | null)[] = rules.hrWorkspaceId ? [rules.hrWorkspaceId] : [...(e.hr_workspace_id ? [e.hr_workspace_id] : []), null];
    for (const c of candidates) {
      if (!availableTo(book, ent.type.id, c)) continue;
      if (c && !(await tx.collection('hr_workspaces').exists({ id: c, status: 'active' }))) continue;
      const name = c ? ((await tx.collection('hr_workspaces').findOne({ id: c }, { projection: { name: 1 } }))?.name as string | undefined) ?? null : null;
      hr = { authority: 'hr', label: c ? `HR Workspace: ${name}` : 'HR Workspace (company HR team)', hrWorkspaceId: c, hrWorkspaceName: name, company: !c, membershipId: null, name: null };
      break;
    }
    const superName = rules.superApproverMembershipId ? (await membershipUserNames(tx, [rules.superApproverMembershipId])).get(rules.superApproverMembershipId) ?? null : null;
    const sup: Authority = { authority: 'super', label: superName ? `Super Workspace: ${superName}` : 'Super Workspace', hrWorkspaceId: null, hrWorkspaceName: null, company: false, membershipId: rules.superApproverMembershipId, name: superName };
    return { hr, super: sup };
  }

  /** The routes a person may send an application of a type on (for the given length), with who reviews each. */
  private async routeOptions(tx: TenantTx, book: LeaveBook, ent: Entitlement, e: EmployeeLite, daysH: number | null) {
    const auth = await this.authoritiesFor(tx, book, ent, e);
    const allowed = leaveRoutesFor(ent.approval, daysH === null ? 0 : daysH / 100).filter((r) => r === 'super' || auth.hr);
    return {
      authorities: auth,
      routes: allowed.map((r) => ({
        route: r, label: LEAVE_AUTHORITY_LABELS[r],
        reviewers: r === 'hr' ? [auth.hr!.label] : r === 'super' ? [auth.super.label] : [auth.hr!.label, auth.super.label],
      })),
      employeeChooses: ent.approval.employeeChooses && allowed.length > 1,
      order: ent.approval.order,
      managerFirst: ent.approval.managerFirst,
      superRequiredOverDays: ent.approval.superRequiredOverDays,
    };
  }

  /**
   * The Employee Workspace leave page: each leave type the person holds, with its balance, policy, who created it and
   * manages it, and who would review an application; and their upcoming approved and pending leave.
   */
  async mine(year = yearOf(today())) {
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, await this.myEmployeeId(tx));
      await this.authz.require('leave:read', this.attrsOf(e), tx);
      const book = await loadBook(tx);
      const held = entitlementsOf(book, e);
      const balances = await this.balanceRows(tx, e, year, book);
      const hrNames = await fieldById(tx, 'hr_workspaces', [...held.values()].map((x) => x.allocation.hr_workspace_id));
      const types = [];
      for (const b of balances) {
        const ent = held.get(b.leaveTypeId)!;
        const t = ent.type;
        const opts = await this.routeOptions(tx, book, ent, e, null);
        types.push({
          ...b,
          description: (t.description as string | null) ?? null,
          policy: ent.policy,
          countsCalendarDays: Boolean(t.counts_calendar_days),
          effectiveFrom: (t.effective_from as string | null) ?? null,
          approval: opts,
          createdBy: { name: (t.created_by_name as string | null) ?? null, level: (t.created_by_level as string | null) ?? null, at: iso(t.created_at) },
          allocatedBy: { name: (ent.allocation.by_name as string | null) ?? null, level: ent.allocation.by_level as string, at: iso(ent.allocation.created_at), hrWorkspaceName: ent.allocation.hr_workspace_id ? hrNames.get(ent.allocation.hr_workspace_id) ?? null : null },
          managedBy: opts.authorities.hr ? opts.authorities.hr.label : 'Super Workspace',
        });
      }
      const rows = await tx.collection('leave_requests').find({ employee_id: e.id }, { sort: { start_date: -1, created_at: -1 }, limit: 200 });
      const requests = await this.requestViews(tx, rows);
      const t0 = today();
      return {
        employeeId: e.id, year, hrWorkspaceId: e.hr_workspace_id, types,
        summary: {
          pending: requests.filter((r) => r.status === 'pending').length,
          approved: requests.filter((r) => r.status === 'approved').length,
          rejected: requests.filter((r) => r.status === 'rejected').length,
          cancelled: requests.filter((r) => r.status === 'cancelled').length,
        },
        upcoming: requests.filter((r) => r.status === 'approved' && r.endDate >= t0).sort((a, b) => cmp(a.startDate, b.startDate)).slice(0, 10),
        pending: requests.filter((r) => r.status === 'pending'),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------------------------------------

  async preview(input: LeaveRequestInput) {
    return this.db.tenant(async (tx) => {
      const { e, onBehalf } = await this.requestTarget(tx, input.employeeId);
      return (await this.evaluate(tx, e, input, onBehalf)).view;
    });
  }

  private async requestTarget(tx: TenantTx, employeeId: string | undefined) {
    const mine = (await this.authz.subject(tx)).employeeId;
    const id = employeeId ?? (await this.myEmployeeId(tx));
    const e = await this.employee(tx, id);
    const onBehalf = id !== mine;
    // Filing for someone else needs approval rights over them (HR for their scope).
    await this.authz.require(onBehalf ? 'leave:approve' : 'leave:request', this.attrsOf(e), tx);
    return { e, onBehalf };
  }

  /**
   * Checks a draft against the type, its policy, the person's allocation, the calendar and the balance, and works out
   * the approval route. When it changes an existing request, that request's days count as available again.
   */
  private async evaluate(tx: TenantTx, e: EmployeeLite, input: Omit<LeaveRequestInput, 'employeeId'>, onBehalf: boolean, replacing?: RequestRow) {
    const type = await tx.collection<Doc>('leave_types').findOne({ id: input.leaveTypeId });
    if (!type || type.archived_at) throw Errors.badRequest('invalid_leave_type', type ? `${type.name} is no longer active` : 'Leave type not found');
    const book = await loadBook(tx);
    const ent = entitlementsOf(book, e).get(type.id);
    // A type the person does not hold looks the same as one that does not exist.
    if (!ent) throw Errors.badRequest('not_eligible', `${type.name} is not allocated to ${onBehalf ? 'this employee' : 'you'}`);
    const p = ent.policy;
    if (type.effective_from && input.startDate < type.effective_from) throw Errors.badRequest('not_yet_effective', `${type.name} can be used from ${type.effective_from}`);
    if (yearOf(input.startDate) !== yearOf(input.endDate)) throw Errors.badRequest('spans_years', 'Split leave that crosses 31 December into one request per year');
    const single = input.startDate === input.endDate;
    const halves = input.startHalf !== 'full' || input.endHalf !== 'full';
    if (!type.allow_half_day && halves && single) throw Errors.badRequest('no_half_days', `${type.name} cannot be taken in half days`);
    if (!single && !p.allowMultiDay) throw Errors.badRequest('single_day_only', `${type.name} is taken one day at a time`);
    if (!single && halves && (!p.allowCustomDuration || !type.allow_half_day)) throw Errors.badRequest('no_custom_duration', `${type.name} does not allow several days that start or end with a half day`);
    if (e.status === 'exited') throw Errors.badRequest('employee_exited', 'This person has left');
    if (input.startDate < e.date_of_joining) throw Errors.badRequest('before_joining', 'Leave cannot start before the joining date');
    if (e.last_working_day && input.endDate > e.last_working_day) throw Errors.badRequest('after_exit', 'Leave cannot end after the last working day');
    if (e.status === 'probation' && !p.availableDuringProbation) throw Errors.badRequest('not_during_probation', `${type.name} is available after probation`);

    const cal = await this.calendarFor(tx, e);
    const daysH = countLeaveDays(input, type.counts_calendar_days ? { weeklyOffs: [], holidays: new Set() } : cal);
    if (daysH <= 0) throw Errors.badRequest('no_working_days', 'Those dates are all weekly offs or holidays');
    if (type.kind === 'optional_holiday') {
      const optional = new Set(cal.id ? (await tx.collection('holidays').find({ calendar_id: cal.id, is_optional: true, holiday_date: { $gte: input.startDate, $lte: input.endDate } }, { projection: { holiday_date: 1 } })).map((h) => h.holiday_date as string) : []);
      for (let d = input.startDate; d <= input.endDate; d = addDays(d, 1)) {
        if (leaveMath.isWorkingDay(d, cal) && !optional.has(d)) throw Errors.badRequest('not_optional_holiday', `${type.name} can only be taken on a day the holiday calendar marks as an optional holiday; ${d} is not one`);
      }
    }
    if (p.minDaysPerRequest && daysH < toH(p.minDaysPerRequest)) throw Errors.badRequest('too_short', `${type.name} needs at least ${p.minDaysPerRequest} days in one application`);
    if (p.maxDaysPerRequest && daysH > toH(p.maxDaysPerRequest)) throw Errors.badRequest('too_long', `${type.name} allows at most ${p.maxDaysPerRequest} days in one application`);
    if (p.maxConsecutiveDays && daysBetweenInclusive(input.startDate, input.endDate) * 100 > toH(p.maxConsecutiveDays)) {
      throw Errors.badRequest('too_long', `${type.name} allows at most ${p.maxConsecutiveDays} consecutive days`);
    }
    if (!onBehalf && p.minNoticeDays > 0 && input.startDate < addDays(today(), p.minNoticeDays)) throw Errors.badRequest('short_notice', `${type.name} needs ${p.minNoticeDays} days' notice`);

    const balance = (await this.balanceRows(tx, e, yearOf(input.startDate), book)).find((b) => b.leaveTypeId === type.id);
    const tracked = p.accrualMethod !== 'none';
    const giveBack = replacing && replacing.leave_type_id === type.id && yearOf(replacing.start_date) === yearOf(input.startDate) && replacing.status !== 'approved' ? toH(replacing.days) : 0;
    // Approved leave being changed: its days come back only when the change is approved, but they count as available.
    const approvedBack = replacing && replacing.status === 'approved' && replacing.leave_type_id === type.id && yearOf(replacing.start_date) === yearOf(input.startDate) ? toH(replacing.days) : 0;
    const availableH = (balance?.available ? toH(balance.available) : 0) + giveBack + approvedBack;
    const afterH = availableH - daysH;
    if (tracked && afterH < 0 && !p.allowNegativeBalance) throw Errors.badRequest('insufficient_balance', `Not enough ${type.name}: ${fromH(availableH)} available, ${fromH(daysH)} requested`);

    // Documents.
    const docs = p.documents;
    const docsRequired = docs.mode === 'required' && (!docs.requiredOverDays || daysH > toH(docs.requiredOverDays));
    const documentIds = input.documentIds ?? [];
    if (docs.mode === 'none' && documentIds.length) throw Errors.badRequest('no_documents', `${type.name} does not take supporting documents`);

    // Approval route.
    const opts = await this.routeOptions(tx, book, ent, e, daysH);
    if (!opts.routes.length) throw Errors.badRequest('no_approval_route', `Nobody is set to review ${type.name} for you. Ask the Super Workspace to make it available to your HR Workspace or to allow Super Workspace approval.`);
    const allowed = opts.routes.map((r) => r.route);
    let route: LeaveAuthority;
    if (input.approvalRoute) {
      if (!allowed.includes(input.approvalRoute)) {
        const why = input.approvalRoute === 'hr' && !opts.authorities.hr ? `no HR Workspace is assigned to ${type.name}` : `${type.name} must go to ${allowed.map((r) => LEAVE_AUTHORITY_LABELS[r]).join(' or ')}`;
        throw Errors.badRequest('route_not_allowed', `You cannot send this to ${LEAVE_AUTHORITY_LABELS[input.approvalRoute]}: ${why}.`);
      }
      if (!opts.employeeChooses && input.approvalRoute !== allowed[0]) throw Errors.badRequest('route_not_allowed', `${type.name} goes to ${LEAVE_AUTHORITY_LABELS[allowed[0]!]}; it cannot be changed`);
      route = input.approvalRoute;
    } else route = allowed[0]!;
    const holidays = [...cal.holidays].filter((d) => d >= input.startDate && d <= input.endDate).sort();
    return {
      type, ent, daysH, route, opts, docsRequired,
      view: {
        leaveTypeId: type.id as string, leaveTypeName: type.name as string,
        days: fromH(daysH), tracked, available: tracked ? fromH(availableH) : null, balanceAfter: tracked ? fromH(afterH) : null,
        holidaysInRange: holidays, calendarId: cal.id,
        warnings: [
          ...(tracked && afterH < 0 ? ['This takes the balance below zero; it will be recovered from future accruals.'] : []),
          ...(docsRequired && !documentIds.length ? [`Attach a supporting document${docs.note ? `: ${docs.note}` : ''}.`] : []),
        ],
        documents: { mode: docs.mode, required: docsRequired, note: docs.note },
        policy: { maxDaysPerRequest: p.maxDaysPerRequest, maxConsecutiveDays: p.maxConsecutiveDays, minDaysPerRequest: p.minDaysPerRequest, minNoticeDays: p.minNoticeDays, allowHalfDay: Boolean(type.allow_half_day), allowMultiDay: p.allowMultiDay },
        routes: opts.routes, employeeChooses: opts.employeeChooses, order: opts.order, managerFirst: opts.managerFirst,
        route, routeLabel: LEAVE_AUTHORITY_LABELS[route],
        reviewers: opts.routes.find((r) => r.route === route)!.reviewers,
      },
    };
  }

  /** The approval chain of an application: an optional manager step, then HR and Super Workspace as the route says. */
  private stepsFor(route: LeaveAuthority, ev: { opts: Awaited<ReturnType<LeaveService['routeOptions']>> }): StepDef[] {
    const { authorities, order, managerFirst } = ev.opts;
    const steps: StepDef[] = managerFirst ? [{ type: 'manager', stage: 1 }] : [];
    const hr: StepDef = { type: 'hr_workspace', hrWorkspaceId: authorities.hr?.hrWorkspaceId ?? null, stage: 2 };
    const sup: StepDef = { type: 'super_workspace', membershipId: authorities.super.membershipId, stage: 2 };
    if (route === 'hr') steps.push(hr);
    else if (route === 'super') steps.push(sup);
    else steps.push(hr, { ...sup, stage: order === 'sequential' ? 3 : 2 });
    return steps;
  }

  private async checkDocuments(tx: TenantTx, ids: string[], required: boolean, keep: string[] = []) {
    if (required && !ids.length) throw Errors.badRequest('document_required', 'Attach the supporting document this leave type needs');
    const fresh = ids.filter((id) => !keep.includes(id));
    if (!fresh.length) return;
    const actor = requestContext.tenantActor();
    const n = await tx.collection('comm_files').count({ id: { $in: fresh }, uploaded_by_membership_id: actor.membershipId });
    if (n !== new Set(fresh).size) throw Errors.badRequest('unknown_document', 'A document was not found. Upload it again.');
  }

  async request(input: LeaveRequestInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const { e, onBehalf } = await this.requestTarget(tx, input.employeeId);
      // One request at a time per person, so the overlap and balance checks see every other request.
      await tx.collection('employees').lock({ id: e.id });
      const ev = await this.evaluate(tx, e, input, onBehalf);
      await this.checkDocuments(tx, input.documentIds ?? [], ev.docsRequired);
      if (await tx.collection('leave_requests').exists({ employee_id: e.id, status: { $in: ['pending', 'approved'] }, start_date: { $lte: input.endDate }, end_date: { $gte: input.startDate } })) {
        throw Errors.conflict('overlapping_leave', 'There is already a pending or approved request on these dates');
      }
      const type = ev.type;
      const row = await tx.collection('leave_requests').insert({
        employee_id: e.id, leave_type_id: input.leaveTypeId, start_date: input.startDate, end_date: input.endDate, start_half: input.startHalf, end_half: input.endHalf,
        days: fromH(ev.daysH), reason: input.reason ?? null, requested_by_membership_id: actor.membershipId,
        approval_route: ev.route, approval_order: ev.route === 'both' ? ev.opts.order : null, policy_version: (type.version as number | undefined) ?? 1,
        policy_snapshot: { code: type.code, name: type.name, policy: ev.ent.policy, approval: ev.ent.approval, annualEntitlement: ev.ent.annualEntitlement, reviewers: ev.view.reviewers },
        document_ids: input.documentIds ?? [], hr_workspace_id: e.hr_workspace_id,
        reviewer_hr_workspace_id: ev.route !== 'super' ? ev.opts.authorities.hr?.hrWorkspaceId ?? null : null,
        reviewer_hr_company: ev.route !== 'super' ? Boolean(ev.opts.authorities.hr?.company) : false,
      });
      const sameDay = await this.discipline.onLeaveRequested(tx, { id: row.id as string, employee_id: e.id, leave_type_id: input.leaveTypeId, start_date: input.startDate });
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'leave_request', resourceId: row.id, subjectEmployeeId: e.id, steps: this.stepsFor(ev.route, ev),
        summary: `${e.name}: ${type.name}, ${range(input.startDate, input.endDate)} (${fromH(ev.daysH)} days), to ${LEAVE_AUTHORITY_LABELS[ev.route]}${input.reason ? `. "${input.reason}"` : ''}${sameDay ? ` ${sameDay}` : ''}`,
        meta: { leaveTypeCode: type.code, leaveTypeName: type.name, paid: Boolean(type.paid), halfDay: input.startHalf !== 'full' || input.endHalf !== 'full' },
      });
      await tx.collection('leave_requests').updateOne({ id: row.id }, { $set: { approval_request_id: approvalId } });
      await this.audit.record(tx, {
        action: 'leave_request.submitted', resourceType: 'leave_request', resourceId: row.id,
        changes: { employeeId: e.id, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, days: fromH(ev.daysH), route: ev.route },
        metadata: { onBehalf, reference: leaveRef(row.id as string) },
      });
      await this.outbox.publish(tx, actor.tenantId, 'leave.requested', { leaveRequestId: row.id, employeeId: e.id });
      return this.loadRequest(tx, row.id as string);
    });
  }

  private async onApproved(tx: TenantTx, req: ApprovalRequestRow) {
    const r = await tx.collection<RequestRow>('leave_requests').findOne({ id: req.resource_id });
    if (!r || !(await tx.collection('leave_requests').updateOne({ id: r.id, status: 'pending' }, { $set: { status: 'approved', decided_at: new Date() } }))) return;
    if (r.replaces_request_id) await this.retire(tx, r.replaces_request_id, r.id);
    await tx.collection('leave_ledger').insert({
      employee_id: r.employee_id, leave_type_id: r.leave_type_id, leave_year: yearOf(r.start_date), kind: 'taken', quantity: fromH(-toH(r.days)),
      effective_on: r.start_date, leave_request_id: r.id, created_by: requestContext.get()?.actor?.kind === 'user' ? requestContext.tenantActor().userId : null,
    });
    await this.audit.record(tx, { action: 'leave_request.approved', resourceType: 'leave_request', resourceId: r.id, metadata: { days: r.days, comment: req.comment ?? null } });
    await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
    await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'leave.approved', { leaveRequestId: r.id, employeeId: r.employee_id });
  }

  /**
   * Cancels a request. Pending requests: the employee or anyone who approves for them. Approved leave: the employee
   * before it starts, or an approver at any time; the days go back through a reversal line.
   */
  async cancel(id: string, reason?: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection<RequestRow>('leave_requests').findOne({ id });
      if (!r) throw Errors.notFound('Leave request');
      await tx.collection('leave_requests').lock({ id });
      const e = await this.employee(tx, r.employee_id);
      const { isOwner, isApprover } = await this.rolesOn(tx, r, e);
      if (r.status !== 'pending' && r.status !== 'approved') throw Errors.conflict('invalid_state', `This request is already ${r.status}`);
      if (r.status === 'approved' && !isApprover && r.start_date <= today()) throw Errors.forbidden('Leave that has started can only be cancelled by your approver or HR');
      if (!(await tx.collection('leave_requests').updateOne({ id, status: r.status }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason ?? null } }))) {
        throw Errors.conflict('invalid_state', 'This request changed meanwhile. Refresh and try again.');
      }
      if (r.status === 'pending' && r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await this.discipline.onLeaveClosed(tx, id, 'cancelled');
      for (const change of await tx.collection<RequestRow>('leave_requests').find({ replaces_request_id: id, status: 'pending' })) {
        await tx.collection('leave_requests').updateOne({ id: change.id, status: 'pending' }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'The leave it changed was cancelled' } });
        if (change.approval_request_id) await this.approvals.cancel(tx, change.approval_request_id);
      }
      if (r.status === 'approved') {
        await tx.collection('leave_ledger').insert({
          employee_id: r.employee_id, leave_type_id: r.leave_type_id, leave_year: yearOf(r.start_date), kind: 'reversal', quantity: r.days,
          effective_on: r.start_date, leave_request_id: id, note: reason ?? 'Cancelled', created_by: actor.userId,
        });
        await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
      }
      await this.audit.record(tx, { action: 'leave_request.cancelled', resourceType: 'leave_request', resourceId: id, metadata: { from: r.status, reason: reason ?? null } });
      const approvers = r.approval_request_id
        ? (await tx.collection('approval_steps').find({ request_id: r.approval_request_id })).map((x) => (x.decided_by_membership_id ?? x.approver_membership_id ?? null) as string | null)
        : [];
      await this.notifications.notify(tx, {
        membershipIds: (isOwner ? approvers : [e.membership_id]).filter((m) => m !== actor.membershipId),
        kind: 'leave.cancelled',
        title: `Leave cancelled: ${e.name}, ${range(r.start_date, r.end_date)}`,
        body: reason,
        link: isOwner ? '/leave/manage?tab=approvals' : '/leave',
        email: r.status === 'approved',
      });
      await this.notifications.signal(tx, [e.membership_id], 'approvals.changed');
      return this.loadRequest(tx, id);
    });
  }

  /** Who the caller is to a request: the person (or who filed it), and whether they approve leave for that person. */
  private async rolesOn(tx: TenantTx, r: RequestRow, e: EmployeeLite) {
    const actor = requestContext.tenantActor();
    const s = await this.authz.subject(tx);
    const attrs = this.attrsOf(e);
    const isOwner = s.employeeId === e.id || r.requested_by_membership_id === actor.membershipId;
    const reviewing = r.approval_request_id ? await tx.collection('approval_steps').exists({ request_id: r.approval_request_id, decided_by_membership_id: actor.membershipId }) : false;
    const isApprover = s.employeeId !== e.id && (grantsFor(s, 'leave:approve').some((g) => g.roleKey !== 'employee_workspace' && grantCovers(s, g, attrs)) || reviewing || this.levelOf(s) === 'super');
    if (!isOwner && !isApprover) {
      await this.authz.require('leave:read', attrs, tx); // 404 when they cannot even see it
      throw Errors.forbidden();
    }
    return { isOwner, isApprover, self: s.employeeId === e.id };
  }

  /**
   * Changes a request. A pending one is changed in place and its approval starts again (the earlier dates are kept in
   * its history). Approved leave stays as it is until a change to it is approved: the change is a new request, and
   * approving it cancels the original and gives its days back. Rejecting it leaves the original standing.
   */
  async modify(id: string, input: LeaveModifyInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection<RequestRow>('leave_requests').findOne({ id });
      if (!r) throw Errors.notFound('Leave request');
      const e = await this.employee(tx, r.employee_id);
      await tx.collection('employees').lock({ id: e.id });
      const { isApprover, self } = await this.rolesOn(tx, r, e);
      if (r.status !== 'pending' && r.status !== 'approved') throw Errors.conflict('invalid_state', `This request is already ${r.status}`);
      if (r.status === 'approved' && !isApprover && r.start_date <= today()) throw Errors.forbidden('Leave that has started can only be changed by your approver or HR');
      if (r.status === 'approved' && (await tx.collection('leave_requests').exists({ replaces_request_id: id, status: 'pending' }))) {
        throw Errors.conflict('change_pending', 'A change to this leave is already waiting for approval. Cancel that change first.');
      }
      const same = input.leaveTypeId === r.leave_type_id && input.startDate === r.start_date && input.endDate === r.end_date && input.startHalf === r.start_half && input.endHalf === r.end_half;
      if (same && (input.reason ?? null) === (r.reason ?? null) && (!input.approvalRoute || input.approvalRoute === r.approval_route)) throw Errors.badRequest('no_change', 'Nothing was changed');
      if (same && r.status === 'approved') throw Errors.badRequest('no_change', 'The dates and type are the same; approved leave only needs a change of dates or type');
      const wanted = { ...input, approvalRoute: input.approvalRoute ?? r.approval_route ?? undefined, documentIds: input.documentIds?.length ? input.documentIds : r.document_ids ?? [] };
      let ev;
      try {
        ev = await this.evaluate(tx, e, wanted, !self, r);
      } catch (err) {
        // The old route may no longer be allowed (a longer leave, changed rules): fall back to the type's own route.
        if ((err as { code?: string }).code !== 'route_not_allowed' || input.approvalRoute) throw err;
        ev = await this.evaluate(tx, e, { ...wanted, approvalRoute: undefined }, !self, r);
      }
      await this.checkDocuments(tx, wanted.documentIds, ev.docsRequired, r.document_ids ?? []);
      if (await tx.collection('leave_requests').exists({
        employee_id: e.id, id: { $ne: id }, replaces_request_id: { $ne: id }, status: { $in: ['pending', 'approved'] }, start_date: { $lte: input.endDate }, end_date: { $gte: input.startDate },
      })) throw Errors.conflict('overlapping_leave', 'There is already another pending or approved request on these dates');
      const type = ev.type;
      const oldType = (await tx.collection('leave_types').findOne({ id: r.leave_type_id }))!;
      const meta = { leaveTypeCode: type.code, leaveTypeName: type.name, paid: Boolean(type.paid), halfDay: input.startHalf !== 'full' || input.endHalf !== 'full' };
      const days = fromH(ev.daysH);
      const changes = { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, days, route: ev.route };
      const before = { leaveTypeId: r.leave_type_id, startDate: r.start_date, endDate: r.end_date, days: r.days, route: r.approval_route ?? null };
      const routing = {
        approval_route: ev.route, approval_order: ev.route === 'both' ? ev.opts.order : null, policy_version: (type.version as number | undefined) ?? 1,
        policy_snapshot: { code: type.code, name: type.name, policy: ev.ent.policy, approval: ev.ent.approval, annualEntitlement: ev.ent.annualEntitlement, reviewers: ev.view.reviewers },
        reviewer_hr_workspace_id: ev.route !== 'super' ? ev.opts.authorities.hr?.hrWorkspaceId ?? null : null, reviewer_hr_company: ev.route !== 'super' ? Boolean(ev.opts.authorities.hr?.company) : false,
        document_ids: wanted.documentIds,
      };
      if (r.status === 'pending') {
        if (r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
        const by = await this.actorName(tx);
        const history = [...(r.modifications ?? []), {
          at: new Date(), by, by_membership_id: actor.membershipId, leave_type_id: r.leave_type_id, leave_type_name: oldType.name,
          start_date: r.start_date, end_date: r.end_date, start_half: r.start_half, end_half: r.end_half, days: r.days, reason: r.reason ?? null, route: r.approval_route ?? null,
        }];
        await tx.collection('leave_requests').updateOne({ id, status: 'pending' }, { $set: {
          leave_type_id: input.leaveTypeId, start_date: input.startDate, end_date: input.endDate, start_half: input.startHalf, end_half: input.endHalf, days, reason: input.reason ?? null, modifications: history, ...routing,
        } });
        const approvalId = await this.approvals.start(tx, {
          resourceType: 'leave_request', resourceId: id, subjectEmployeeId: e.id, steps: this.stepsFor(ev.route, ev),
          summary: `${e.name} changed a request: ${type.name}, ${range(input.startDate, input.endDate)} (${days} days), was ${oldType.name}, ${range(r.start_date, r.end_date)}${input.reason ? `. "${input.reason}"` : ''}`,
          meta,
        });
        await tx.collection('leave_requests').updateOne({ id }, { $set: { approval_request_id: approvalId } });
        await this.audit.record(tx, { action: 'leave_request.modified', resourceType: 'leave_request', resourceId: id, changes, metadata: { before, restartedApproval: true } });
        await this.outbox.publish(tx, actor.tenantId, 'leave.requested', { leaveRequestId: id, employeeId: e.id });
        return this.loadRequest(tx, id);
      }
      const row = await tx.collection('leave_requests').insert({
        employee_id: e.id, leave_type_id: input.leaveTypeId, start_date: input.startDate, end_date: input.endDate, start_half: input.startHalf, end_half: input.endHalf,
        days, reason: input.reason ?? null, requested_by_membership_id: actor.membershipId, replaces_request_id: id, hr_workspace_id: e.hr_workspace_id, ...routing,
      });
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'leave_request', resourceId: row.id, subjectEmployeeId: e.id, steps: this.stepsFor(ev.route, ev),
        summary: `${e.name} wants to change approved leave: ${type.name}, ${range(input.startDate, input.endDate)} (${days} days) instead of ${oldType.name}, ${range(r.start_date, r.end_date)} (${r.days} days)${input.reason ? `. "${input.reason}"` : ''}`,
        meta,
      });
      await tx.collection('leave_requests').updateOne({ id: row.id }, { $set: { approval_request_id: approvalId } });
      await this.audit.record(tx, { action: 'leave_request.change_requested', resourceType: 'leave_request', resourceId: row.id, changes, metadata: { replaces: id, before } });
      await this.outbox.publish(tx, actor.tenantId, 'leave.requested', { leaveRequestId: row.id, employeeId: e.id });
      return this.loadRequest(tx, row.id as string);
    });
  }

  async previewModify(id: string, input: LeaveModifyInput) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection<RequestRow>('leave_requests').findOne({ id });
      if (!r) throw Errors.notFound('Leave request');
      const e = await this.employee(tx, r.employee_id);
      const { self } = await this.rolesOn(tx, r, e);
      const wanted = { ...input, approvalRoute: input.approvalRoute ?? r.approval_route ?? undefined };
      try {
        return (await this.evaluate(tx, e, wanted, !self, r)).view;
      } catch (err) {
        if ((err as { code?: string }).code !== 'route_not_allowed' || input.approvalRoute) throw err;
        return (await this.evaluate(tx, e, { ...wanted, approvalRoute: undefined }, !self, r)).view;
      }
    });
  }

  /** Cancels approved leave that an approved change replaces, giving its days back. */
  private async retire(tx: TenantTx, id: string, by: string) {
    const o = await tx.collection<RequestRow>('leave_requests').findOne({ id });
    if (!o || !(await tx.collection('leave_requests').updateOne({ id, status: 'approved' }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Replaced by an approved change' } }))) return;
    await tx.collection('leave_ledger').insert({
      employee_id: o.employee_id, leave_type_id: o.leave_type_id, leave_year: yearOf(o.start_date), kind: 'reversal', quantity: o.days,
      effective_on: o.start_date, leave_request_id: id, note: 'Replaced by an approved change', created_by: requestContext.tenantActor().userId,
    });
    await this.attendance.recomputeFor(tx, o.employee_id, o.start_date, o.end_date);
    await this.audit.record(tx, { action: 'leave_request.replaced', resourceType: 'leave_request', resourceId: id, metadata: { by } });
  }

  /**
   * Leave requests. scope=mine (default without an employee): the caller's own. scope=visible: everyone whose leave
   * the caller may see. scope=review: the requests waiting for the caller's decision (as an HR Workspace or the Super
   * Workspace), wherever the person sits.
   */
  async listRequests(q: { employeeId?: string; status?: string; from?: string; to?: string; scope?: 'mine' | 'visible' | 'review'; leaveTypeId?: string; hrWorkspaceId?: string; limit: number }) {
    return this.db.tenant(async (tx) => {
      const and: Record<string, unknown>[] = [];
      if (q.scope === 'review') {
        const ids = await this.approvals.waitingForMe(tx, 'leave_request');
        and.push({ id: { $in: ids } });
      } else if (q.scope === 'mine' || (!q.employeeId && q.scope !== 'visible')) {
        and.push({ employee_id: await this.myEmployeeId(tx) });
      } else {
        const visible = await this.visibleEmployeeIds(tx, 'leave:read');
        // Requests sent to an HR Workspace the caller runs are theirs to see, wherever the person sits.
        const s = await this.authz.subject(tx);
        const reach = this.hrReach(s);
        and.push({ $or: [{ employee_id: { $in: visible } }, ...(reach.hrWorkspaceIds.length ? [{ reviewer_hr_workspace_id: { $in: reach.hrWorkspaceIds } }] : [])] });
        if (q.employeeId) and.push({ employee_id: q.employeeId });
      }
      if (q.status) and.push({ status: q.status });
      if (q.leaveTypeId) and.push({ leave_type_id: q.leaveTypeId });
      if (q.hrWorkspaceId) and.push({ $or: [{ hr_workspace_id: q.hrWorkspaceId }, { reviewer_hr_workspace_id: q.hrWorkspaceId }] });
      if (q.from) and.push({ end_date: { $gte: q.from } });
      if (q.to) and.push({ start_date: { $lte: q.to } });
      const rows = await tx.collection('leave_requests').find({ $and: and }, { sort: { start_date: -1, created_at: -1 }, limit: q.limit });
      return this.requestViews(tx, rows);
    });
  }

  async getRequest(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection<RequestRow>('leave_requests').findOne({ id });
      if (!r) throw Errors.notFound('Leave request');
      await this.mayRead(tx, r);
      return this.loadRequest(tx, id);
    });
  }

  /** The person, anyone whose leave access covers them, or anyone asked to review it. */
  private async mayRead(tx: TenantTx, r: RequestRow & { reviewer_hr_workspace_id?: string | null }) {
    const s = await this.authz.subject(tx);
    if (s.employeeId === r.employee_id) return;
    if (r.approval_request_id) {
      const actor = requestContext.tenantActor();
      if (await tx.collection('approval_steps').exists({ request_id: r.approval_request_id, decided_by_membership_id: actor.membershipId })) return;
      if ((await this.approvals.waitingForMe(tx, 'leave_request')).includes(r.id)) return;
    }
    if (r.reviewer_hr_workspace_id && this.hrReach(s).hrWorkspaceIds.includes(r.reviewer_hr_workspace_id)) return;
    await this.authz.require('leave:read', this.attrsOf(await this.employee(tx, r.employee_id)), tx);
  }

  private async loadRequest(tx: TenantTx, id: string) {
    const row = (await this.requestViews(tx, [(await tx.collection('leave_requests').findOne({ id }))!]))[0]!;
    const r = (await tx.collection('leave_requests').findOne({ id }))!;
    const docs = await fieldById(tx, 'comm_files', (r.document_ids as string[] | undefined) ?? []);
    return {
      ...row,
      approvalTrail: row.approvalId ? await this.approvals.trail(tx, row.approvalId) : [],
      policyVersion: (r.policy_version as number | undefined) ?? null,
      policySnapshot: r.policy_snapshot ?? null,
      documents: ((r.document_ids as string[] | undefined) ?? []).map((f) => ({ id: f, name: docs.get(f) ?? 'Document', href: `/leave-documents/${id}/${f}` })),
    };
  }

  /** Leave requests as the API shows them, with each authority's decision and the overall status. */
  private async requestViews(tx: TenantTx, requests: Doc[]) {
    const people = await employeeNames(tx, requests.map((r) => r.employee_id));
    const types = new Map((await tx.collection('leave_types').find({ id: { $in: [...new Set(requests.map((r) => r.leave_type_id))] } })).map((t) => [t.id as string, t]));
    const requesters = await membershipUserNames(tx, requests.map((r) => r.requested_by_membership_id));
    const hrNames = await fieldById(tx, 'hr_workspaces', requests.flatMap((r) => [r.hr_workspace_id, r.reviewer_hr_workspace_id]));
    const penalties = new Map((await tx.collection('attendance_penalties').find({ leave_request_id: { $in: requests.map((r) => r.id) }, kind: 'same_day_leave' })).map((p) => [p.leave_request_id as string, p]));
    const approvalIds = requests.map((r) => r.approval_request_id).filter(Boolean);
    const steps = approvalIds.length ? await tx.collection('approval_steps').find({ request_id: { $in: approvalIds } }, { sort: { seq: 1 } }) : [];
    const deciders = await membershipUserNames(tx, steps.map((st) => st.decided_by_membership_id));
    const waiting = await this.approvals.waitingOn(tx, requests.filter((r) => r.status === 'pending').map((r) => r.approval_request_id));
    const label = { manager: 'Manager', hr: 'HR Workspace', super: 'Super Workspace', other: 'Approver' } as Record<string, string>;
    return requests
      .filter((r) => people.has(r.employee_id) && types.has(r.leave_type_id))
      .map((r) => {
        const e = people.get(r.employee_id)!;
        const t = types.get(r.leave_type_id)!;
        // One line per authority: the last decision of its steps, or where it stands.
        const mine = steps.filter((st) => st.request_id === r.approval_request_id);
        const authorities = [...new Set(mine.map((st) => (st.authority as string | undefined) ?? (st.kind === 'manager' || st.kind === 'skip_level_manager' ? 'manager' : /super/.test(st.approver_role_key ?? '') ? 'super' : /hr/.test(st.approver_role_key ?? '') ? 'hr' : 'other')))].map((a) => {
          const of = mine.filter((st) => ((st.authority as string | undefined) ?? (st.kind === 'manager' || st.kind === 'skip_level_manager' ? 'manager' : /super/.test(st.approver_role_key ?? '') ? 'super' : /hr/.test(st.approver_role_key ?? '') ? 'hr' : 'other')) === a);
          const last = of[of.length - 1]!;
          const status = of.some((st) => st.status === 'rejected') ? 'rejected' : of.every((st) => st.status === 'approved' || st.status === 'skipped') ? 'approved' : of.some((st) => st.status === 'pending') ? 'pending' : of.some((st) => st.status === 'waiting') ? 'waiting' : 'cancelled';
          const decided = of.find((st) => st.status === 'rejected') ?? [...of].reverse().find((st) => st.status === 'approved');
          return {
            authority: a, label: a === 'hr' && last.approver_hr_workspace_id ? `HR Workspace: ${hrNames.get(last.approver_hr_workspace_id) ?? ''}`.trim() : label[a] ?? a,
            status, decidedBy: decided ? deciders.get(decided.decided_by_membership_id) ?? null : null, decidedAt: decided?.decided_at ?? null, comment: (decided?.comment as string | null) ?? null,
            escalated: of.some((st) => !!st.escalated_at),
          };
        });
        return {
          id: r.id as string, reference: leaveRef(r.id), employeeId: r.employee_id as string, employeeName: e.name, employeeCode: e.doc.employee_code as string,
          hrWorkspaceId: (r.hr_workspace_id as string | null) ?? null, hrWorkspaceName: r.hr_workspace_id ? hrNames.get(r.hr_workspace_id) ?? null : null,
          leaveTypeId: r.leave_type_id as string, leaveTypeName: t.name as string, leaveTypeCode: t.code as string, leaveTypeKind: (t.kind as string | undefined) ?? 'standard',
          leaveTypeActive: !t.archived_at, color: t.color as string,
          startDate: r.start_date as string, endDate: r.end_date as string, startHalf: r.start_half, endHalf: r.end_half, days: r.days as string, reason: r.reason ?? null,
          status: r.status as string, approvalId: (r.approval_request_id as string | null) ?? null,
          approvalRoute: (r.approval_route as LeaveAuthority | null) ?? null, approvalRouteLabel: r.approval_route ? LEAVE_AUTHORITY_LABELS[r.approval_route as LeaveAuthority] : 'Earlier approval chain',
          approvalOrder: (r.approval_order as string | null) ?? null,
          reviewerHrWorkspaceName: r.reviewer_hr_workspace_id ? hrNames.get(r.reviewer_hr_workspace_id) ?? null : r.reviewer_hr_company ? 'Company HR team' : null,
          authorities, documentCount: ((r.document_ids as string[] | undefined) ?? []).length,
          createdAt: r.created_at, decidedAt: r.decided_at ?? null, cancelledAt: r.cancelled_at ?? null, cancelReason: r.cancel_reason ?? null,
          requestedBy: requesters.get(r.requested_by_membership_id) ?? null, sameDay: Boolean(r.same_day), appliedOn: (r.applied_on as string | null) ?? null,
          replacesRequestId: (r.replaces_request_id as string | null) ?? null,
          modifications: ((r.modifications as Doc[] | undefined) ?? []).map((m) => ({
            at: m.at, by: (m.by as string | null) ?? null, leaveTypeName: (m.leave_type_name as string | null) ?? null,
            startDate: m.start_date as string, endDate: m.end_date as string, days: m.days as string, reason: (m.reason as string | null) ?? null,
          })),
          penalty: penalties.has(r.id)
            ? (({ id, value, source, status, status_reason }) => ({ id: id as string, days: value as string, source: source as string, status: status as string, statusReason: (status_reason as string | null) ?? null }))(penalties.get(r.id)!)
            : null,
          waitingOn: r.status === 'pending' && r.approval_request_id ? waiting.get(r.approval_request_id) ?? null : null,
        };
      });
  }

  /** Who is away in a date range, for team calendars. Limited to records the caller can read. */
  async whoIsAway(from: string, to: string) {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('leave_requests').find(
        { status: { $in: ['approved', 'pending'] }, end_date: { $gte: from }, start_date: { $lte: to }, employee_id: { $in: await this.visibleEmployeeIds(tx, 'leave:read') } },
        { sort: { start_date: 1 }, limit: 500 },
      );
      return this.requestViews(tx, rows);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------------------------------------

  /** Uploads a supporting document for an application (checked and stored like other attachments). */
  uploadDocument(file: UploadedFile | undefined) {
    return this.files.upload(file);
  }

  /** A short download link for a document on a request the caller may see. */
  documentLink(requestId: string, fileId: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection<RequestRow>('leave_requests').findOne({ id: requestId });
      if (!r || !((r.document_ids ?? []) as string[]).includes(fileId)) throw Errors.notFound('Document');
      await this.mayRead(tx, r);
      await this.audit.record(tx, { action: 'leave_document.downloaded', resourceType: 'leave_request', resourceId: requestId, metadata: { fileId } });
      return this.storage.sign(fileId, 300, 'comm');
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Dashboards and reports
  // ---------------------------------------------------------------------------------------------------------

  /** The people a Super Workspace or HR Workspace dashboard covers. */
  private async scopePeople(tx: TenantTx, hrWorkspaceId?: string, departmentId?: string): Promise<EmployeeLite[]> {
    const scope = await this.authz.filter('leave:read', EMPLOYEE_FIELDS, tx);
    const and: Doc[] = [scope, { status: { $ne: 'exited' } }];
    if (hrWorkspaceId) and.push({ hr_workspace_id: hrWorkspaceId });
    if (departmentId) and.push({ current_department_id: departmentId });
    return loadPeople(tx, { $and: and }, { sort: { first_name: 1, last_name: 1 }, limit: 5000 });
  }

  /**
   * The Super Workspace and HR Workspace leave dashboard, within the caller's scope: leave types, allocations,
   * applications by status, upcoming leave, utilisation by type and (for the Super Workspace) by HR Workspace.
   */
  async dashboard(q: z.infer<typeof leaveReportQuery>) {
    const year = q.year ?? yearOf(today());
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const level = this.levelOf(s);
      const reach = this.hrReach(s);
      const book = await loadBook(tx, { includeInactive: true });
      const visibleTypes = new Set((await this.listTypesIn(tx, true)).map((t) => t.id as string));
      const people = await this.scopePeople(tx, q.hrWorkspaceId);
      const ids = people.map((p) => p.id);
      const requests = await tx.collection('leave_requests').find({
        $or: [{ employee_id: { $in: ids } }, ...(reach.hrWorkspaceIds.length ? [{ reviewer_hr_workspace_id: { $in: reach.hrWorkspaceIds } }] : [])],
        start_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` },
      });
      const waiting = new Set(await this.approvals.waitingForMe(tx, 'leave_request'));
      const ledger = await tx.collection('leave_ledger').find({ employee_id: { $in: ids }, leave_year: year }, { projection: { leave_type_id: 1, kind: 1, quantity: 1, employee_id: 1 } });
      const t0 = today();
      const in30 = addDays(t0, 30);
      const upcomingRows = requests.filter((r) => r.status === 'approved' && r.end_date >= t0 && r.start_date <= in30).sort((a, b) => cmp(a.start_date, b.start_date)).slice(0, 20);
      const byType = book.types.filter((t) => visibleTypes.has(t.id)).map((t) => {
        const credited = sumBy(ledger.filter((l) => l.leave_type_id === t.id && ['accrual', 'carry_forward', 'adjustment'].includes(l.kind)), (l) => l.quantity);
        const taken = -sumBy(ledger.filter((l) => l.leave_type_id === t.id && (l.kind === 'taken' || l.kind === 'reversal')), (l) => l.quantity);
        const holders = people.filter((e) => entitlementsOf(book, e).has(t.id)).length;
        const rs = requests.filter((r) => r.leave_type_id === t.id);
        return {
          id: t.id as string, code: t.code as string, name: t.name as string, color: t.color as string, active: !t.archived_at, holders,
          credited: fromH(credited), taken: fromH(taken), utilisation: credited > 0 ? Math.round((taken / credited) * 1000) / 10 : null,
          pending: rs.filter((r) => r.status === 'pending').length, approved: rs.filter((r) => r.status === 'approved').length, rejected: rs.filter((r) => r.status === 'rejected').length,
        };
      });
      const hrWorkspaces = level === 'super'
        ? await tx.collection('hr_workspaces').find({ status: 'active' }, { sort: { name: 1 } })
        : await tx.collection('hr_workspaces').find({ id: { $in: reach.hrWorkspaceIds } }, { sort: { name: 1 } });
      const byHrWorkspace = [...hrWorkspaces.map((w) => ({ id: w.id as string | null, name: w.name as string })), { id: null, name: 'Central group (no HR Workspace)' }]
        .filter((w) => level === 'super' || w.id || reach.company)
        .map((w) => {
          const mem = new Set(people.filter((p) => p.hr_workspace_id === w.id).map((p) => p.id));
          const rs = requests.filter((r) => mem.has(r.employee_id));
          return {
            id: w.id, name: w.name, employees: mem.size,
            types: book.types.filter((t) => !t.archived_at && availableTo(book, t.id, w.id)).map((t) => t.name as string),
            pending: rs.filter((r) => r.status === 'pending').length, approved: rs.filter((r) => r.status === 'approved').length, rejected: rs.filter((r) => r.status === 'rejected').length,
            takenDays: fromH(-sumBy(ledger.filter((l) => mem.has(l.employee_id) && (l.kind === 'taken' || l.kind === 'reversal')), (l) => l.quantity)),
          };
        });
      return {
        year, level,
        hrWorkspaces: hrWorkspaces.map((w) => ({ id: w.id as string, name: w.name as string })),
        reach: { company: level === 'super' || reach.company, hrWorkspaceIds: reach.hrWorkspaceIds },
        counts: {
          types: byType.length, activeTypes: byType.filter((t) => t.active).length, inactiveTypes: byType.filter((t) => !t.active).length,
          allocations: book.allocations.filter((a) => visibleTypes.has(a.leave_type_id)).length, employees: people.length,
          pending: requests.filter((r) => r.status === 'pending').length, waitingForMe: waiting.size,
          approved: requests.filter((r) => r.status === 'approved').length, rejected: requests.filter((r) => r.status === 'rejected').length,
          cancelled: requests.filter((r) => r.status === 'cancelled').length,
          onLeaveToday: requests.filter((r) => r.status === 'approved' && r.start_date <= t0 && r.end_date >= t0).length,
        },
        upcoming: await this.requestViews(tx, upcomingRows),
        byType,
        byHrWorkspace,
      };
    });
  }

  /** Leave reports: allocation and utilisation by leave type, department and employee, and applications by status. */
  async report(q: z.infer<typeof leaveReportQuery>) {
    const year = q.year ?? yearOf(today());
    return this.db.tenant(async (tx) => {
      const book = await loadBook(tx, { includeInactive: true });
      const visibleTypes = new Set((await this.listTypesIn(tx, true)).map((t) => t.id as string));
      const types = book.types.filter((t) => visibleTypes.has(t.id) && (!q.leaveTypeId || t.id === q.leaveTypeId));
      const people = await this.scopePeople(tx, q.hrWorkspaceId, q.departmentId);
      const ids = people.map((p) => p.id);
      const ledger = await tx.collection('leave_ledger').find({ employee_id: { $in: ids }, leave_year: year }, { projection: { employee_id: 1, leave_type_id: 1, kind: 1, quantity: 1 } });
      const requests = await tx.collection('leave_requests').find({ employee_id: { $in: ids }, start_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }, { projection: { employee_id: 1, leave_type_id: 1, status: 1, days: 1 } });
      const departments = await fieldById(tx, 'departments', people.map((p) => p.department_id));
      const hrNames = await fieldById(tx, 'hr_workspaces', people.map((p) => p.hr_workspace_id));
      const key = (e: string, t: string) => `${e}|${t}`;
      const credited = new Map<string, number>();
      const taken = new Map<string, number>();
      for (const l of ledger) {
        const k = key(l.employee_id, l.leave_type_id);
        if (['accrual', 'carry_forward', 'adjustment', 'lapse'].includes(l.kind)) credited.set(k, (credited.get(k) ?? 0) + toH(l.quantity));
        if (l.kind === 'taken' || l.kind === 'reversal') taken.set(k, (taken.get(k) ?? 0) - toH(l.quantity));
      }
      const pending = new Map<string, number>();
      for (const r of requests.filter((x) => x.status === 'pending')) pending.set(key(r.employee_id, r.leave_type_id), (pending.get(key(r.employee_id, r.leave_type_id)) ?? 0) + toH(r.days));
      const held = new Map(people.map((p) => [p.id, entitlementsOf(book, p)]));
      const employees = people.map((p) => {
        const cells: Record<string, { entitlement: string; used: string; pending: string; balance: string }> = {};
        for (const t of types) {
          const k = key(p.id, t.id);
          if (!held.get(p.id)!.has(t.id) && !credited.has(k) && !taken.has(k)) continue;
          const c = credited.get(k) ?? 0;
          const u = taken.get(k) ?? 0;
          cells[t.id] = { entitlement: fromH(c), used: fromH(u), pending: fromH(pending.get(k) ?? 0), balance: fromH(c - u) };
        }
        return { employeeId: p.id, name: p.name, code: p.code, departmentName: p.department_id ? departments.get(p.department_id) ?? null : null, hrWorkspaceName: p.hr_workspace_id ? hrNames.get(p.hr_workspace_id) ?? null : null, cells };
      });
      const deptRows = [...new Set(people.map((p) => p.department_id))].map((d) => {
        const mem = new Set(people.filter((p) => p.department_id === d).map((p) => p.id));
        const c = ledger.filter((l) => mem.has(l.employee_id) && types.some((t) => t.id === l.leave_type_id));
        const cr = sumBy(c.filter((l) => ['accrual', 'carry_forward', 'adjustment', 'lapse'].includes(l.kind)), (l) => l.quantity);
        const tk = -sumBy(c.filter((l) => l.kind === 'taken' || l.kind === 'reversal'), (l) => l.quantity);
        return { departmentId: d, name: d ? departments.get(d) ?? 'Unknown' : 'No department', employees: mem.size, credited: fromH(cr), taken: fromH(tk), utilisation: cr > 0 ? Math.round((tk / cr) * 1000) / 10 : null };
      }).sort((a, b) => cmp(a.name, b.name));
      const typeRows = types.map((t) => {
        const c = ledger.filter((l) => l.leave_type_id === t.id);
        const cr = sumBy(c.filter((l) => ['accrual', 'carry_forward', 'adjustment', 'lapse'].includes(l.kind)), (l) => l.quantity);
        const tk = -sumBy(c.filter((l) => l.kind === 'taken' || l.kind === 'reversal'), (l) => l.quantity);
        const rs = requests.filter((r) => r.leave_type_id === t.id);
        return {
          id: t.id as string, code: t.code as string, name: t.name as string, active: !t.archived_at, holders: people.filter((p) => held.get(p.id)!.has(t.id)).length,
          allocations: book.allocations.filter((a) => a.leave_type_id === t.id && a.target === 'employees').length,
          credited: fromH(cr), taken: fromH(tk), utilisation: cr > 0 ? Math.round((tk / cr) * 1000) / 10 : null,
          pending: rs.filter((r) => r.status === 'pending').length, approved: rs.filter((r) => r.status === 'approved').length, rejected: rs.filter((r) => r.status === 'rejected').length, cancelled: rs.filter((r) => r.status === 'cancelled').length,
        };
      });
      return { year, types: types.map((t) => ({ id: t.id as string, code: t.code as string, name: t.name as string, color: t.color as string })), byType: typeRows, byDepartment: deptRows, employees };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // HR operations
  // ---------------------------------------------------------------------------------------------------------

  async adjust(input: z.infer<typeof leaveAdjustmentInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, input.employeeId);
      await this.authz.require('leave:approve', this.attrsOf(e), tx);
      const s = await this.authz.subject(tx);
      if (s.employeeId === e.id) throw Errors.forbidden('You cannot adjust your own leave balance');
      if (!(await tx.collection('leave_types').exists({ id: input.leaveTypeId }))) throw Errors.badRequest('invalid_leave_type', 'Leave type not found');
      const year = yearOf(today());
      await tx.collection('leave_ledger').insert({ employee_id: e.id, leave_type_id: input.leaveTypeId, leave_year: year, kind: 'adjustment', quantity: input.quantity, effective_on: today(), note: input.note, created_by: actor.userId });
      await this.audit.record(tx, { action: 'leave_balance.adjusted', resourceType: 'employee', resourceId: e.id, changes: { leaveTypeId: input.leaveTypeId, quantity: input.quantity, note: input.note } });
      await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'leave.adjusted', title: `Your leave balance was adjusted by ${input.quantity} days`, body: input.note, link: '/leave' });
      return { employeeId: e.id, year, balances: await this.balanceRows(tx, e, year) };
    });
  }

  async adjustments(q: z.infer<typeof leaveAdjustmentsQuery>) {
    return this.db.tenant(async (tx) => {
      const visible = await this.visibleEmployeeIds(tx, 'leave:read');
      const filter: Record<string, unknown> = { kind: 'adjustment', employee_id: { $in: q.employeeId ? visible.filter((v) => v === q.employeeId) : visible } };
      if (q.leaveTypeId) filter.leave_type_id = q.leaveTypeId;
      if (q.year) filter.leave_year = q.year;
      const lines = await tx.collection('leave_ledger').find(filter, { sort: { created_at: -1 }, limit: q.limit });
      const people = await employeeNames(tx, lines.map((l) => l.employee_id));
      const types = await fieldById(tx, 'leave_types', lines.map((l) => l.leave_type_id));
      const users = await (await usersTable(tx)).find({ id: { $in: [...new Set(lines.map((l) => l.created_by).filter(Boolean))] } }, { projection: { full_name: 1 } });
      const by = new Map(users.map((u) => [u.id, u.full_name ?? null]));
      return lines.filter((l) => people.has(l.employee_id)).map((l) => ({
        id: l.id as string, employeeId: l.employee_id as string, employeeName: people.get(l.employee_id)!.name, employeeCode: people.get(l.employee_id)!.doc.employee_code as string,
        leaveTypeId: l.leave_type_id as string, leaveTypeName: types.get(l.leave_type_id) ?? null, year: l.leave_year as number, quantity: l.quantity as string,
        note: (l.note as string | null) ?? null, opening: typeof l.accrual_key === 'string' && l.accrual_key.startsWith('OPEN'), by: by.get(l.created_by) ?? null, createdAt: l.created_at,
      }));
    });
  }

  /** Balances of everyone the caller may see, one row per person and one column per leave type they hold. */
  async balanceOverview(q: z.infer<typeof leaveBalanceOverviewQuery>) {
    const year = q.year ?? yearOf(today());
    return this.db.tenant(async (tx) => {
      const scope = await this.authz.filter('leave:read', EMPLOYEE_FIELDS, tx);
      const and: Record<string, unknown>[] = [scope, { status: { $ne: 'exited' } }];
      if (q.departmentId) and.push({ current_department_id: q.departmentId });
      if (q.hrWorkspaceId) and.push({ hr_workspace_id: q.hrWorkspaceId });
      if (q.q) {
        const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        and.push({ $or: [{ first_name: rx }, { last_name: rx }, { preferred_name: rx }, { employee_code: rx }] });
      }
      const all = await loadPeople(tx, { $and: and }, { sort: { first_name: 1, last_name: 1 }, limit: 501 });
      const truncated = all.length > 500;
      const people = all.slice(0, 500);
      const ids = people.map((p) => p.id);
      const book = await loadBook(tx);
      const ledger = await tx.collection('leave_ledger').find({ employee_id: { $in: ids }, leave_year: year }, { projection: { employee_id: 1, leave_type_id: 1, kind: 1, quantity: 1 } });
      const open = await tx.collection('leave_requests').find({ employee_id: { $in: ids }, status: 'pending', start_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }, { projection: { employee_id: 1, leave_type_id: 1, days: 1 } });
      const departments = await fieldById(tx, 'departments', people.map((p) => p.department_id));
      const sums = new Map<string, number>();
      for (const l of ledger) {
        const k = `${l.employee_id}|${l.leave_type_id}`;
        sums.set(k, (sums.get(k) ?? 0) + toH(l.quantity as string));
        if (l.kind === 'taken' || l.kind === 'reversal') sums.set(`${k}|taken`, (sums.get(`${k}|taken`) ?? 0) - toH(l.quantity as string));
      }
      for (const r of open) sums.set(`${r.employee_id}|${r.leave_type_id}|pending`, (sums.get(`${r.employee_id}|${r.leave_type_id}|pending`) ?? 0) + toH(r.days as string));
      const shown = new Set<string>();
      const rows = people.map((e) => {
        const balances: Record<string, { balance: string | null; available: string | null; taken: string; pending: string }> = {};
        for (const [typeId, ent] of entitlementsOf(book, e)) {
          shown.add(typeId);
          const k = `${e.id}|${typeId}`;
          const tracked = ent.policy.accrualMethod !== 'none';
          const bal = sums.get(k) ?? 0;
          const pend = sums.get(`${k}|pending`) ?? 0;
          balances[typeId] = { balance: tracked ? fromH(bal) : null, available: tracked ? fromH(bal - pend) : null, taken: fromH(sums.get(`${k}|taken`) ?? 0), pending: fromH(pend) };
        }
        return { employeeId: e.id, name: e.name, code: e.code, departmentId: e.department_id, departmentName: (e.department_id && departments.get(e.department_id)) || null, balances };
      });
      return {
        year, truncated,
        types: book.types.filter((t) => shown.has(t.id)).map((t) => ({ id: t.id as string, code: t.code as string, name: t.name as string, color: t.color as string, kind: (t.kind as string | undefined) ?? 'standard' })),
        rows,
      };
    });
  }

  /**
   * Opening balances for someone already working here when their record is added: one adjustment per leave type
   * that brings this year's balance to what they have available today. Keyed per year, so it is posted once.
   */
  async setOpeningBalances(tx: TenantTx, employeeId: string, balances: { leaveTypeId: string; days: string }[]): Promise<{ leaveTypeId: string; days: string; adjustment: string }[]> {
    const actor = requestContext.tenantActor();
    const on = today();
    const year = yearOf(on);
    const out = [];
    for (const b of balances) {
      if (!(await tx.collection('leave_types').exists({ id: b.leaveTypeId, archived_at: null }))) throw Errors.badRequest('invalid_leave_type', 'Leave type not found');
      const lines = await tx.collection('leave_ledger').find({ employee_id: employeeId, leave_type_id: b.leaveTypeId, leave_year: year }, { projection: { quantity: 1 } });
      const delta = toH(b.days) - sumBy(lines, (l) => l.quantity);
      out.push({ leaveTypeId: b.leaveTypeId, days: b.days, adjustment: fromH(delta) });
      if (delta === 0) continue;
      await tx.collection('leave_ledger').insert({
        employee_id: employeeId, leave_type_id: b.leaveTypeId, leave_year: year, kind: 'adjustment', quantity: fromH(delta), effective_on: on,
        accrual_key: `OPEN${year}`, note: `Opening balance of ${b.days} days, carried over when the record was added`, created_by: actor.userId,
      });
    }
    return out;
  }

  /**
   * Posts every accrual due up to asOf for the types each person holds, and lapses carried-forward days past their
   * expiry. Idempotent: each period is credited at most once per employee and type.
   */
  async runAccruals(tx: TenantTx, asOf: string, employeeId?: string): Promise<number> {
    const yearStart = `${asOf.slice(0, 4)}-01-01`;
    const employees = await loadPeople(tx, {
      date_of_joining: { $lte: asOf },
      $or: [{ status: { $ne: 'exited' } }, { last_working_day: { $gte: yearStart } }],
      ...(employeeId ? { id: employeeId } : {}),
    });
    const book = await loadBook(tx);
    const posted_ = new Set(
      (await tx.collection('leave_ledger').find({ employee_id: { $in: employees.map((e) => e.id) }, accrual_key: { $ne: null } }, { projection: { employee_id: 1, leave_type_id: 1, accrual_key: 1 } }))
        .map((l) => `${l.employee_id}|${l.leave_type_id}|${l.accrual_key}`),
    );
    let posted = 0;
    const year = yearOf(asOf);
    for (const e of employees) {
      for (const [typeId, ent] of entitlementsOf(book, e)) {
        const p = ent.policy;
        const credits = leaveMath.accrualsDue({ accrualMethod: p.accrualMethod, annualEntitlement: toH(ent.annualEntitlement), rounding: p.rounding }, { dateOfJoining: e.date_of_joining, lastWorkingDay: e.last_working_day }, asOf);
        for (const c of credits) {
          if (posted_.has(`${e.id}|${typeId}|${c.key}`)) continue;
          await tx.collection('leave_ledger').insert({ employee_id: e.id, leave_type_id: typeId, leave_year: yearOf(c.effectiveOn), kind: 'accrual', quantity: fromH(c.quantity), effective_on: c.effectiveOn, accrual_key: c.key, note: `Accrual ${c.key.slice(1)}` });
          posted_.add(`${e.id}|${typeId}|${c.key}`);
          posted++;
        }
        // Carried-forward days not used within the months the policy allows lapse.
        if (p.carriedExpiryMonths) {
          const expiry = `${year}-${String(p.carriedExpiryMonths + 1).padStart(2, '0')}-01`;
          const key = `EX${year}`;
          if (p.carriedExpiryMonths < 12 && asOf >= expiry && !posted_.has(`${e.id}|${typeId}|${key}`)) {
            const lines = await tx.collection('leave_ledger').find({ employee_id: e.id, leave_type_id: typeId, leave_year: year }, { projection: { kind: 1, quantity: 1, effective_on: 1 } });
            const carried = sumBy(lines.filter((l) => l.kind === 'carry_forward' && toH(l.quantity) > 0), (l) => l.quantity);
            const used = -sumBy(lines.filter((l) => (l.kind === 'taken' || l.kind === 'reversal') && l.effective_on < expiry), (l) => l.quantity);
            const lapse = carried - used;
            if (lapse > 0) {
              await tx.collection('leave_ledger').insert({ employee_id: e.id, leave_type_id: typeId, leave_year: year, kind: 'lapse', quantity: fromH(-lapse), effective_on: addDays(expiry, -1), accrual_key: key, note: `Carried-forward days not used by ${addDays(expiry, -1)} lapsed` });
              posted_.add(`${e.id}|${typeId}|${key}`);
            }
          }
        }
      }
    }
    return posted;
  }

  /** The hourly leave job: accruals and expiry, then escalation of applications waiting too long. */
  async runScheduled(tx: TenantTx, asOf: string): Promise<number> {
    const posted = await this.runAccruals(tx, asOf);
    const pending = await tx.collection('leave_requests').find({ status: 'pending', approval_request_id: { $ne: null }, 'policy_snapshot.approval.escalation.enabled': true });
    const now = Date.now();
    for (const r of pending) {
      const after = Number(r.policy_snapshot?.approval?.escalation?.afterDays ?? 0);
      if (!after || now - new Date(r.created_at).getTime() < after * 86_400_000) continue;
      await this.approvals.escalate(tx, r.approval_request_id, `Waiting more than ${after} days`);
    }
    return posted;
  }

  async runAccrualsNow(asOf = today()) {
    return this.db.tenant(async (tx) => {
      const posted = await this.runAccruals(tx, asOf);
      await this.audit.record(tx, { action: 'leave_accruals.run', resourceType: 'leave', metadata: { asOf, posted } });
      return { asOf, posted };
    });
  }

  /** Runs escalation now (also hourly), for testing and for an administrator who does not want to wait. */
  async escalateNow() {
    return this.db.tenant(async (tx) => {
      const before = await tx.collection('approval_steps').count({ escalated_at: { $ne: null } });
      await this.runScheduled(tx, today());
      return { escalated: (await tx.collection('approval_steps').count({ escalated_at: { $ne: null } })) - before };
    });
  }

  /** Closes a leave year: carries balances forward up to each type's cap and lapses the rest. Safe to re-run. */
  async closeYear(year: number) {
    if (year >= yearOf(today())) throw Errors.badRequest('year_open', 'Only a past leave year can be closed');
    return this.db.tenant(async (tx) => {
      const lines = await tx.collection('leave_ledger').find({ leave_year: year }, { projection: { employee_id: 1, leave_type_id: 1, quantity: 1 } });
      const keyed = new Map<string, { employee_id: string; leave_type_id: string; q: number }>();
      for (const l of lines) {
        const k = `${l.employee_id}|${l.leave_type_id}`;
        const cur = keyed.get(k) ?? { employee_id: l.employee_id, leave_type_id: l.leave_type_id, q: 0 };
        cur.q += toH(l.quantity);
        keyed.set(k, cur);
      }
      const types = new Map((await tx.collection('leave_types').find({})).map((t) => [t.id as string, t]));
      const done = new Set((await tx.collection('leave_ledger').find({ accrual_key: { $in: [`L${year}`, `CO${year}`, `CI${year}`] } }, { projection: { employee_id: 1, leave_type_id: 1, accrual_key: 1 } })).map((l) => `${l.employee_id}|${l.leave_type_id}|${l.accrual_key}`));
      let carried = 0;
      let lapsed = 0;
      const ins = async (r: { employee_id: string; leave_type_id: string }, leaveYear: number, kind: string, q: number, on: string, key: string, note: string) => {
        if (done.has(`${r.employee_id}|${r.leave_type_id}|${key}`)) return;
        await tx.collection('leave_ledger').insert({ employee_id: r.employee_id, leave_type_id: r.leave_type_id, leave_year: leaveYear, kind, quantity: fromH(q), effective_on: on, accrual_key: key, note });
      };
      for (const r of keyed.values()) {
        if (r.q === 0) continue;
        const t = types.get(r.leave_type_id);
        if (!t) continue;
        const p = configOf(t).policy;
        if (p.accrualMethod === 'none') continue;
        const { carry, lapse } = leaveMath.yearEnd(r.q, toH(p.carryForwardMax));
        if (lapse) {
          await ins(r, year, 'lapse', -lapse, `${year}-12-31`, `L${year}`, `Lapsed at the end of ${year}`);
          lapsed++;
        }
        if (carry) {
          await ins(r, year, 'carry_forward', -carry, `${year}-12-31`, `CO${year}`, `Carried to ${year + 1}`);
          await ins(r, year + 1, 'carry_forward', carry, `${year + 1}-01-01`, `CI${year}`, `Carried from ${year}`);
          carried++;
        }
      }
      await this.audit.record(tx, { action: 'leave_year.closed', resourceType: 'leave', metadata: { year, carried, lapsed } });
      return { year, carried, lapsed };
    });
  }
}

function conflictOn(pgCode: string, code: string, message: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === pgCode) throw Errors.conflict(code, message);
    throw err;
  };
}

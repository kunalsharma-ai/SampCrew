import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  REQUEST_KIND_DEFS, REQUEST_WORKFLOW_LABELS, defaultRequestCategories, leaveRef, requestDateLabel, requestDays, requestRef, requestSettingsInput,
  requestStatusMessage, requestTitle, requestWhen,
  type LeaveDuration, type LeaveRequestInput, type RequestApprovalsQuery, type RequestApproverStatus, type RequestCategory, type RequestDecisionInput,
  type RequestEventView, type RequestInput, type RequestKind, type RequestKindDef, type RequestLeaveInput, type RequestPerson, type RequestResubmitInput,
  type RequestSettings, type RequestSettingsInput, type RequestStatus, type RequestView, type RequestWorkflow,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { ApprovalsService, type ApprovalRequestRow, type StepDef } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { CommFilesService } from '../communication/files.service';
import { memberIdentities } from '../communication/identity';
import type { UploadedFile } from '../documents/documents.service';
import { displayName } from '../employees/employee-view';
import { employeeAttrs } from '../employees/employee-attrs';
import { LeaveService } from '../leave/leave.service';
import { leaveApplicationEmail } from './leave-application-email';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;
type Level = 'super' | 'hr' | 'employee';

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const todayUtc = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Request kinds whose approval changes how attendance counts the days (work from home counts as present at home). */
const ATTENDANCE_KINDS = new Set<string>(['wfh', 'late_coming', 'early_leave', 'on_duty', 'shift_change']);
const OPEN = ['pending', 'changes_requested'];
/** Rows from before the 28 November spec may carry the old half-day kind: it reads as leave. */
const defOf = (kind: string): RequestKindDef => REQUEST_KIND_DEFS[kind as RequestKind] ?? REQUEST_KIND_DEFS.leave;
const NOBODY: RequestPerson = { membershipId: '', name: 'Unnamed', level: 'employee', levelLabel: 'Employee Workspace', workspace: null, designation: null, department: null, employeeCode: null };

/**
 * Requests (28 November 2026, Kunal's written spec). Anyone at any level raises a request (work from home, leave,
 * early leave, late arrival, comp off, attendance regularization, other, or a category the Super Workspace added),
 * sends it to a primary approver and additional approvers, and copies in CC participants who are told but do not
 * decide. The category's workflow says how the approvers decide: any one of them, all at once, or one after another.
 * An approver approves (optional comment), rejects (reason required) or asks for changes (what to correct); the
 * requester corrects it and it goes to the same approvers again as a new round. Anyone on the request can comment.
 *
 * A leave application is itself a request: it goes straight to the approvers, holds the days as pending (no balance
 * deduction, no attendance mark) and is booked only when fully approved. Approved leave is cancelled through the same
 * approvers (a leave cancellation request) unless the settings let the person cancel it themselves before it starts.
 *
 * One record per request whatever the approvers' workspaces: every screen reads the same row, and every action is in
 * its history (staff_request_events) and the audit trail.
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
    private readonly files: CommFilesService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit() {
    this.approvals.register('staff_request', {
      // Approvers decide because they were named on the request. Anyone else needs approval rights over the person.
      permission: 'leave:approve',
      configurePermission: 'org:manage',
      defaultSteps: [],
      fallbackRole: 'hr_workspace',
      label: 'Request',
      chainSetByModule: 'Each request goes to the approvers its requester chose, decided as its category says (Settings > Requests & approvals).',
      rejectNeedsReason: true,
      quiet: true,
      approverTitle: (req) => {
        const kind = (req.meta?.tag as RequestKind | undefined) ?? 'other';
        return `${defOf(kind).isLeave ? 'New leave application' : `New ${defOf(kind).label.toLowerCase()} request`} for your approval`;
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
        const v = (await this.viewsOf(tx, [r], { full: false }))[0]!;
        const who = v.requester;
        return {
          requestForm: [
            { label: 'Request ID', value: v.ref },
            { label: 'Request', value: v.title },
            { label: 'Raised by', value: `${who.name} (${who.levelLabel}${who.designation ? `, ${who.designation}` : ''})` },
            ...(who.employeeCode ? [{ label: 'Employee code', value: who.employeeCode }] : []),
            ...(who.department ? [{ label: 'Department', value: who.department }] : []),
            { label: 'When', value: v.when },
            ...(v.leave ? [{ label: 'Leave', value: `${v.leave.leaveTypeName}, ${v.leave.days} day${v.leave.days === '1' ? '' : 's'}` }] : []),
            ...(v.workedOn ? [{ label: 'Worked on', value: requestDateLabel(v.workedOn) }] : []),
            { label: 'Reason', value: v.reason },
            { label: 'Approvers', value: v.approvers.map((a) => `${a.name}${a.part === 'primary' ? ' (primary)' : ''}`).join(', ') },
            ...(v.cc.length ? [{ label: 'CC', value: v.cc.map((c) => c.name).join(', ') }] : []),
            { label: 'Workflow', value: REQUEST_WORKFLOW_LABELS[v.workflow] },
          ],
          requestKind: v.kind, requestKindLabel: v.kindLabel, requestColor: defOf(v.kind).color, requestIcon: defOf(v.kind).icon,
        };
      },
      documents: async (tx, id) => {
        const r = await tx.collection('staff_requests').findOne({ id }, { projection: { attachment_ids: 1 } });
        const ids = (r?.attachment_ids as string[] | undefined) ?? [];
        if (!ids.length) return [];
        const names = new Map((await tx.collection('comm_files').find({ id: { $in: ids } }, { projection: { name: 1 } })).map((f) => [f.id as string, f.name as string]));
        return ids.map((f) => ({ name: names.get(f) ?? 'Document', href: `/request-files/${id}/${f}` }));
      },
      onStepDecided: (tx, req, step) => this.stepDecided(tx, req, step),
      onApproved: (tx, req) => this.closed(tx, req, 'approved'),
      onRejected: (tx, req) => this.closed(tx, req, 'rejected'),
      onChangesRequested: (tx, req) => this.closed(tx, req, 'changes_requested'),
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Settings: categories, workflows and rules (Super Workspace)
  // ---------------------------------------------------------------------------------------------------------

  /** The workspace's request settings: the saved ones over the defaults (new built-in kinds appear as they come). */
  private async settingsOf(tx: TenantTx): Promise<RequestSettings> {
    const saved = (await tx.collection('request_settings').findOne({}))?.settings as Partial<RequestSettingsInput> | undefined;
    const base = requestSettingsInput.parse({ categories: defaultRequestCategories().map(({ kind: _k, icon: _i, color: _c, timing: _t, ...c }) => c) });
    const builtIn = defaultRequestCategories();
    const savedCats = saved?.categories ?? [];
    const categories: RequestCategory[] = [
      ...builtIn.map((d) => {
        const s = savedCats.find((c) => c.key === d.key);
        return s ? { ...d, label: s.label, description: s.description ?? d.description, enabled: s.enabled, workflow: s.workflow, attachments: s.attachments ?? 'optional', levels: s.levels ?? d.levels, custom: false } : d;
      }),
      ...savedCats.filter((c) => c.custom && !builtIn.some((d) => d.key === c.key)).map((c) => {
        const o = REQUEST_KIND_DEFS.other;
        return { ...c, kind: 'other' as const, custom: true, icon: o.icon, color: o.color, timing: o.timing, attachments: c.attachments ?? 'optional', levels: c.levels ?? ['super', 'hr', 'employee'], description: c.description ?? '' } as RequestCategory;
      }),
    ];
    return {
      categories,
      approvedLeaveCancellation: saved?.approvedLeaveCancellation ?? base.approvedLeaveCancellation,
      reminderDaysBefore: saved?.reminderDaysBefore ?? base.reminderDaysBefore,
      defaultPrimary: saved?.defaultPrimary ?? base.defaultPrimary,
      hrAsApprover: saved?.hrAsApprover ?? base.hrAsApprover,
    };
  }

  settings() {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      return { settings: await this.settingsOf(tx), canManage: hasPermission(s, 'org:manage').allowed, workflows: REQUEST_WORKFLOW_LABELS };
    });
  }

  saveSettings(input: RequestSettingsInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('org:manage', undefined, tx);
      const builtIn = new Set<string>(defaultRequestCategories().map((c) => c.key));
      const keys = input.categories.map((c) => c.key);
      if (new Set(keys).size !== keys.length) throw Errors.badRequest('duplicate_category', 'Each category needs its own key');
      for (const c of input.categories) {
        if (!c.custom && !builtIn.has(c.key)) throw Errors.badRequest('unknown_category', `${c.label}: mark it as a custom category`);
        if (c.custom && builtIn.has(c.key)) throw Errors.badRequest('reserved_key', `${c.key} is a built-in category`);
      }
      if (!input.categories.some((c) => c.enabled)) throw Errors.badRequest('no_categories', 'Keep at least one request category switched on');
      const before = await this.settingsOf(tx);
      const existing = await tx.collection('request_settings').findOne({}, { projection: { _id: 1 } });
      const actor = requestContext.tenantActor();
      if (existing) await tx.collection('request_settings').updateOne({ id: existing.id }, { $set: { settings: input, updated_by_membership_id: actor.membershipId, updated_at: new Date() } });
      else await tx.collection('request_settings').insert({ settings: input, updated_by_membership_id: actor.membershipId });
      await this.audit.record(tx, {
        action: 'request_settings.updated', resourceType: 'request_settings', resourceId: existing?.id ?? null,
        changes: { before: { ...before, categories: before.categories.map((c) => ({ key: c.key, enabled: c.enabled, workflow: c.workflow, levels: c.levels })) }, after: { ...input, categories: input.categories.map((c) => ({ key: c.key, enabled: c.enabled, workflow: c.workflow, levels: c.levels })) } },
      });
      return { settings: await this.settingsOf(tx), canManage: true, workflows: REQUEST_WORKFLOW_LABELS };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------------------------------------

  /** Name, level, workspace, designation, department and employee code of members. */
  private async peopleOf(tx: TenantTx, membershipIds: unknown[]): Promise<Map<string, RequestPerson>> {
    const ids = [...new Set(membershipIds.filter((x): x is string => typeof x === 'string' && !!x))];
    if (!ids.length) return new Map();
    // One query at a time: the first commands of a transaction must not run in parallel.
    const emps = await tx.collection('employees').find({ membership_id: { $in: ids } }, { projection: { membership_id: 1, current_department_id: 1, current_designation_id: 1 } });
    const who = await memberIdentities(tx, ids);
    const depts = await tx.collection('departments').find({ id: { $in: [...new Set(emps.map((e) => e.current_department_id).filter(Boolean))] } }, { projection: { name: 1 } });
    const desigs = await tx.collection('designations').find({ id: { $in: [...new Set(emps.map((e) => e.current_designation_id).filter(Boolean))] } }, { projection: { name: 1 } });
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

  /** The requester's employee record and the people they would usually send to: reporting manager, HR, Super Workspace. */
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

  /**
   * Everything the Create Request and Apply for Leave forms fill in: who the caller is (code, designation, department,
   * workspace, reporting manager, HR manager), the categories they may raise, the suggested approvers, their leave
   * types and balances, and the rules that change the form.
   */
  options() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const c = await this.circle(tx, actor.membershipId);
      const settings = await this.settingsOf(tx);
      const ids = [actor.membershipId, c.manager, c.skipManager, ...c.hr.slice(0, 6), ...c.supers.slice(0, 4)];
      const people = await this.peopleOf(tx, ids);
      const me = people.get(actor.membershipId)!;
      const tag = (id: string | null, role: RequestPerson['role'], roleLabel: string) => (id && people.get(id) ? [{ ...people.get(id)!, role, roleLabel }] : []);
      const seen = new Set<string>();
      const suggested = [
        ...tag(c.manager, 'manager', 'Your reporting manager'),
        ...c.hr.slice(0, 6).flatMap((id) => tag(id, 'hr', c.hrApprovers.has(id) ? 'Your HR' : 'HR Workspace')),
        ...c.supers.slice(0, 4).filter((id) => id !== c.manager).flatMap((id) => tag(id, 'super', 'Super Workspace')),
        ...(c.skipManager && c.skipManager !== c.manager && !c.supers.includes(c.skipManager) ? tag(c.skipManager, 'manager', "Your manager's manager") : []),
      ].filter((p) => !seen.has(p.membershipId) && seen.add(p.membershipId));
      const manager = c.manager ? people.get(c.manager) ?? null : null;
      const hrManager = c.hr[0] ? people.get(c.hr[0]) ?? null : null;
      // The approvers the form starts with: the reporting manager (or HR) as primary, HR as an additional approver.
      const fallbackPrimary = manager ?? hrManager ?? (c.supers[0] ? people.get(c.supers[0]) ?? null : null);
      const primary = settings.defaultPrimary === 'hr' ? hrManager ?? fallbackPrimary : fallbackPrimary;
      const additional = settings.hrAsApprover && hrManager && hrManager.membershipId !== primary?.membershipId ? [hrManager.membershipId] : [];
      const leaveTypes = c.employee
        ? (await this.leave.balancesIn(tx, c.employee.id, Number(todayUtc().slice(0, 4))).catch(() => []))
          .map((b) => ({ id: b.leaveTypeId, name: b.name as string, code: b.code as string, color: b.color as string, available: b.available, notAssigned: b.notAssigned, allowHalfDay: Boolean(b.allowHalfDay), kind: b.kind }))
        : [];
      return {
        categories: settings.categories.filter((cat) => cat.enabled && cat.levels.includes(me.level)),
        kinds: Object.values(REQUEST_KIND_DEFS),
        me: { ...me, dateOfJoining: (c.employee?.date_of_joining as string | undefined) ?? null },
        reportingManager: manager,
        hrManager,
        hasEmployeeRecord: Boolean(c.employee),
        suggested,
        defaults: { primaryApproverId: primary?.membershipId ?? null, additionalApproverIds: additional },
        leaveTypes,
        approvedLeaveCancellation: settings.approvedLeaveCancellation,
      };
    });
  }

  /** The directory: anyone active in the workspace (search by name, designation, department, workspace or code). */
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
  // Raising a request
  // ---------------------------------------------------------------------------------------------------------

  /** The category the request is filed under, checked: switched on, open to the caller's level, of that kind. */
  private async categoryFor(tx: TenantTx, kind: RequestKind, categoryKey: string | undefined, level: Level): Promise<RequestCategory> {
    const settings = await this.settingsOf(tx);
    const cat = settings.categories.find((c) => c.key === (categoryKey ?? kind));
    if (!cat || (cat.custom ? kind !== 'other' : cat.kind !== kind)) throw Errors.badRequest('unknown_category', 'That request category does not exist');
    if (!cat.enabled) throw Errors.badRequest('category_disabled', `${cat.label} requests are switched off for this workspace`);
    if (!cat.levels.includes(level)) throw Errors.forbidden(`${cat.label} requests are not open to your workspace level`);
    return cat;
  }

  /**
   * The approvers and CC participants, checked: active members, not the requester, and at least one approver with
   * authority over the requester (their manager, the manager above, HR or the Super Workspace), so a colleague alone
   * cannot approve someone's request.
   */
  private async checkPeople(tx: TenantTx, membershipId: string, approvers: string[], cc: string[]) {
    if (approvers.includes(membershipId) || cc.includes(membershipId)) throw Errors.badRequest('self_approver', 'You cannot add yourself to your own request');
    const all = [...new Set([...approvers, ...cc])];
    const active = await tx.collection('memberships').find({ id: { $in: all }, status: 'active' }, { projection: { _id: 1 } });
    if (active.length !== all.length) throw Errors.badRequest('unknown_person', 'Someone you added is not an active member of this workspace');
    const c = await this.circle(tx, membershipId);
    const authority = new Set([c.manager, c.skipManager, ...c.allHr, ...c.supers].filter(Boolean) as string[]);
    if (authority.size && !approvers.some((id) => authority.has(id))) {
      throw Errors.badRequest('no_authority', 'Add your reporting manager, your HR or the Super Workspace as an approver: at least one approver must be able to approve for you.');
    }
    return c;
  }

  private async checkAttachments(tx: TenantTx, ids: string[], mode: RequestCategory['attachments'], keep: string[] = []) {
    if (mode === 'none' && ids.length) throw Errors.badRequest('no_attachments', 'This request type does not take documents');
    if (mode === 'required' && !ids.length) throw Errors.badRequest('document_required', 'Attach the supporting document this request type needs');
    const fresh = ids.filter((id) => !keep.includes(id));
    if (!fresh.length) return;
    const n = await tx.collection('comm_files').count({ id: { $in: fresh }, uploaded_by_membership_id: requestContext.tenantActor().membershipId });
    if (n !== new Set(fresh).size) throw Errors.badRequest('unknown_document', 'A document was not found. Upload it again.');
  }

  /** No two open or approved requests of one category for overlapping days (a duplicate would be decided twice). */
  private async checkDuplicate(tx: TenantTx, r: { requester: string; kind: string; categoryKey: string; startDate: string; endDate: string; except?: string }) {
    const clash = await tx.collection('staff_requests').findOne({
      requester_membership_id: r.requester, kind: r.kind, category_key: r.categoryKey, status: { $in: [...OPEN, 'approved'] },
      start_date: { $lte: r.endDate }, end_date: { $gte: r.startDate }, ...(r.except ? { id: { $ne: r.except } } : {}),
    }, { projection: { _id: 1 } });
    if (clash) throw Errors.conflict('duplicate_request', `You already have a ${defOf(r.kind).label.toLowerCase()} request for these dates (${requestRef(clash.id as string, r.kind as RequestKind)}). Open it from My Requests instead.`);
  }

  /** Approval steps for a workflow: everyone at once (any one or all of them), or one after another in order. */
  private steps(workflow: RequestWorkflow, approvers: string[]): StepDef[] {
    return approvers.map((m, i) => ({ type: 'person' as const, membershipId: m, stage: workflow === 'sequential' ? i + 1 : 1 }));
  }

  /**
   * Sends the request to its approvers (a new round after changes) and tells the requester and the CC participants.
   * The approvers are notified by the approvals engine (by email too, except for leave: they get the application form).
   */
  private async startRound(tx: TenantTx, id: string, opts: { resubmitted?: string | null } = {}) {
    const r = (await tx.collection('staff_requests').findOne({ id }))!;
    const kind = r.kind as RequestKind;
    const people = await this.peopleOf(tx, [r.requester_membership_id, ...r.approver_membership_ids, ...r.cc_membership_ids]);
    const me = people.get(r.requester_membership_id) ?? NOBODY;
    const when = requestWhen({ kind, startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time });
    const ref = requestRef(id, kind);
    const label = await this.labelOf(tx, r);
    // The summary goes into notices and emails: no reason text (it can be personal, such as a medical note).
    const approvalId = await this.approvals.start(tx, {
      resourceType: 'staff_request', resourceId: id, subjectEmployeeId: (r.employee_id as string | null) ?? null,
      steps: this.steps(r.workflow, r.approver_membership_ids), mode: r.workflow === 'any' ? 'any' : 'all',
      summary: `${ref} · ${me.name}${me.employeeCode ? ` (${me.employeeCode})` : ''}, ${me.levelLabel}: ${label}, ${when}${opts.resubmitted !== undefined ? ' (corrected and sent again)' : ''}`,
      meta: { tag: kind }, emailApprovers: !defOf(kind).isLeave,
    });
    await tx.collection('staff_requests').updateOne({ id }, { $set: { approval_request_id: approvalId, approval_ids: [...((r.approval_ids as string[] | undefined) ?? []), approvalId], status: 'pending', decided_at: null } });
    if (r.leave_request_id && kind === 'leave') await this.leave.linkApproval(tx, r.leave_request_id, approvalId);
    await this.event(tx, id, opts.resubmitted !== undefined ? 'resubmitted' : kind === 'leave_cancellation' ? 'cancellation_requested' : 'submitted', r.requester_membership_id, opts.resubmitted ?? null, r.round);
    const names = r.approver_membership_ids.map((m: string) => people.get(m)?.name ?? 'someone').join(', ');
    const workflow = r.workflow as RequestWorkflow;
    await this.notifications.notify(tx, {
      membershipIds: [r.requester_membership_id], kind: opts.resubmitted !== undefined ? 'request.updated' : 'request.submitted', includeActor: true,
      title: `${ref}: ${label} ${opts.resubmitted !== undefined ? 'sent again' : 'submitted'}`,
      body: `${when}. Sent to ${names} (${REQUEST_WORKFLOW_LABELS[workflow].toLowerCase()}). You will be told as it is decided.`,
      link: `/requests/${id}`, resource: { type: 'staff_request', id },
    });
    if (r.cc_membership_ids.length) {
      await this.notifications.notify(tx, {
        membershipIds: r.cc_membership_ids, kind: opts.resubmitted !== undefined ? 'request.updated' : defOf(kind).isLeave ? 'request.leave_submitted' : 'request.submitted',
        title: `${ref}: ${me.name} ${opts.resubmitted !== undefined ? 'corrected' : 'raised'} a ${label.toLowerCase()} request (you are in CC)`,
        body: `${when}. Approvers: ${names}. Status: pending. You are told of the decision; you do not need to act.`,
        link: `/requests/${id}`, resource: { type: 'staff_request', id }, email: true,
      });
    }
    await this.notifications.signal(tx, [r.requester_membership_id, ...r.approver_membership_ids, ...r.cc_membership_ids], 'approvals.changed');
    return approvalId;
  }

  private async labelOf(tx: TenantTx, r: Doc): Promise<string> {
    if (r.category_key && r.category_key !== r.kind) {
      const cat = (await this.settingsOf(tx)).categories.find((c) => c.key === r.category_key);
      if (cat) return cat.label;
    }
    return defOf(r.kind).label;
  }

  private async event(tx: TenantTx, requestId: string, action: RequestEventView['action'], membershipId: string | null, comment: string | null, round: number) {
    await tx.collection('staff_request_events').insert({ request_id: requestId, action, membership_id: membershipId, comment, round });
  }

  create(input: RequestInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const approvers = [input.primaryApproverId, ...input.additionalApproverIds];
      const meLevel = (await this.peopleOf(tx, [actor.membershipId])).get(actor.membershipId)?.level ?? 'employee';
      const cat = await this.categoryFor(tx, input.kind, input.categoryKey, meLevel);
      const c = await this.checkPeople(tx, actor.membershipId, approvers, input.ccIds);
      await this.checkAttachments(tx, input.attachmentIds, cat.attachments);
      if ((input.kind === 'attendance_regularization' || input.kind === 'comp_off') && !c.employee) {
        throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet, so there is no attendance to change. Ask HR to link it.');
      }
      if (input.kind === 'attendance_regularization' && input.startDate > todayUtc()) throw Errors.badRequest('future_date', 'Attendance can be regularized for today or an earlier day');
      const end = input.endDate ?? input.startDate;
      await this.checkDuplicate(tx, { requester: actor.membershipId, kind: input.kind, categoryKey: cat.key, startDate: input.startDate, endDate: end });
      const row = await tx.collection('staff_requests').insert({
        kind: input.kind, category_key: cat.key, title: input.title?.trim() || null, reason: input.reason, start_date: input.startDate, end_date: end,
        start_time: input.startTime ?? null, end_time: input.endTime ?? null, worked_on: input.workedOn ?? null,
        requester_membership_id: actor.membershipId, employee_id: (c.employee?.id as string | undefined) ?? null,
        approver_membership_ids: approvers, cc_membership_ids: input.ccIds, workflow: cat.workflow, attachment_ids: input.attachmentIds, round: 1, approval_ids: [],
      });
      await this.startRound(tx, row.id as string);
      await this.audit.record(tx, {
        action: 'staff_request.submitted', resourceType: 'staff_request', resourceId: row.id,
        changes: { kind: input.kind, category: cat.key, startDate: input.startDate, endDate: end, startTime: input.startTime ?? null, endTime: input.endTime ?? null, approvers, cc: input.ccIds, workflow: cat.workflow },
        metadata: { reference: requestRef(row.id as string, input.kind) },
      });
      return this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id: row.id }))!);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Leave applications (a request of kind leave)
  // ---------------------------------------------------------------------------------------------------------

  /** The leave module's fields from the form: full days, a half day (first or second half), or hours on one day. */
  private leaveFields(v: { duration: LeaveDuration; startDate: string; endDate: string; startHalf: 'full' | 'first_half' | 'second_half'; endHalf: 'full' | 'first_half' }) {
    if (v.duration === 'hours') return { startHalf: 'full' as const, endHalf: 'full' as const };
    if (v.duration === 'half' && v.startDate === v.endDate) {
      return v.startHalf === 'second_half' ? { startHalf: 'second_half' as const, endHalf: 'full' as const } : { startHalf: 'full' as const, endHalf: 'first_half' as const };
    }
    return { startHalf: v.startHalf === 'second_half' ? 'second_half' as const : 'full' as const, endHalf: v.endHalf };
  }

  /**
   * Files the leave itself (pending: it holds the days so two applications cannot spend them twice, but nothing is
   * deducted and attendance is not marked until the request is fully approved). The leave module checks the type,
   * eligibility, overlaps and the balance; a failure there rolls the whole request back.
   */
  private async fileLeave(tx: TenantTx, staffRequestId: string, d: { leaveTypeId: string; startDate: string; endDate: string; duration: LeaveDuration; startHalf: 'full' | 'first_half' | 'second_half'; endHalf: 'full' | 'first_half'; startTime?: string | null; endTime?: string | null; reason: string; contactDuringLeave?: string | null; handoverTo?: string | null; attachmentIds: string[] }, form: Record<string, unknown>) {
    const halves = this.leaveFields(d);
    const input = { leaveTypeId: d.leaveTypeId, startDate: d.startDate, endDate: d.endDate, ...halves, reason: d.reason, documentIds: d.attachmentIds } as LeaveRequestInput;
    const hours = d.duration === 'hours' ? { startTime: d.startTime ?? undefined, endTime: d.endTime ?? undefined } : {};
    return this.leave.requestIn(tx, input, { staffRequestId, form, ...hours });
  }

  /** The leave application form saved with the leave and emailed to the approvers (and a copy to the applicant). */
  private async leaveForm(tx: TenantTx, membershipId: string, approvers: string[], cc: string[], d: { leaveTypeId: string; startDate: string; endDate: string; duration: LeaveDuration; startHalf: string; endHalf: string; startTime?: string | null; endTime?: string | null; reason: string; contactDuringLeave?: string | null; handoverTo?: string | null }, ref: string) {
    const c = await this.circle(tx, membershipId);
    const e = c.employee;
    const people = await this.peopleOf(tx, [membershipId, c.manager, c.hr[0], ...approvers, ...cc]);
    const me = people.get(membershipId) ?? NOBODY;
    const legalEntity = e?.current_legal_entity_id ? await tx.collection('legal_entities').findOne({ id: e.current_legal_entity_id }, { projection: { name: 1 } }) : null;
    const tenant = await tx.collection('tenants').findOne({}, { projection: { name: 1 } });
    const type = await tx.collection('leave_types').findOne({ id: d.leaveTypeId }, { projection: { name: 1, code: 1 } });
    const pick = (id: string | null | undefined) => (id && people.get(id) ? { name: people.get(id)!.name, designation: people.get(id)!.designation, levelLabel: people.get(id)!.levelLabel } : null);
    const halves = this.leaveFields(d as never);
    return {
      company: (legalEntity?.name as string | undefined) ?? (tenant?.name as string | undefined) ?? '',
      applicant: {
        name: e ? displayName(e as never) : me.name, employeeCode: me.employeeCode, designation: me.designation, department: me.department,
        levelLabel: me.levelLabel, workspace: me.workspace, dateOfJoining: (e?.date_of_joining as string | undefined) ?? null, email: (e?.work_email as string | undefined) ?? null,
      },
      reportingManager: pick(c.manager), hrManager: pick(c.hr[0]),
      leaveType: { id: d.leaveTypeId, name: (type?.name as string | undefined) ?? 'Leave', code: (type?.code as string | undefined) ?? '' },
      startDate: d.startDate, endDate: d.endDate, duration: d.duration, ...halves, startTime: d.startTime ?? null, endTime: d.endTime ?? null,
      reason: d.reason, contactDuringLeave: d.contactDuringLeave ?? null, handoverTo: d.handoverTo ?? null, requestRef: ref,
      sendTo: approvers.map((m, i) => ({ membershipId: m, name: people.get(m)?.name ?? '', levelLabel: people.get(m)?.levelLabel ?? '', designation: people.get(m)?.designation ?? null, part: i === 0 ? 'primary' : 'additional' })),
      cc: cc.map((m) => ({ membershipId: m, name: people.get(m)?.name ?? '' })),
      submittedAt: new Date().toISOString(),
    };
  }

  private async emailLeaveForm(tx: TenantTx, requestId: string, form: Record<string, any>, days: string, approvers: string[], requester: string) {
    const ids = [...approvers, requester];
    const who = await memberIdentities(tx, ids);
    const actor = requestContext.tenantActor();
    for (const m of ids) {
      const to = who.get(m)?.email;
      if (!to) continue;
      const copy = m === requester;
      const mail = leaveApplicationEmail({ form, days, reference: form.requestRef, link: this.notifications.webUrl(`/requests/${requestId}`), recipientName: who.get(m)?.name ?? '', copy });
      await this.notifications.queueHtmlEmail(tx, actor.tenantId, to, mail.subject, mail.text, mail.html, 'leave.application');
    }
  }

  applyLeave(input: RequestLeaveInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      // The leave itself is the Leave module: the plan must include it.
      await this.entitlements.requireFeature('leave', tx);
      const approvers = [input.primaryApproverId, ...input.additionalApproverIds];
      const meLevel = (await this.peopleOf(tx, [actor.membershipId])).get(actor.membershipId)?.level ?? 'employee';
      const cat = await this.categoryFor(tx, 'leave', undefined, meLevel);
      const c = await this.checkPeople(tx, actor.membershipId, approvers, input.ccIds);
      if (!c.employee) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
      await this.checkAttachments(tx, input.attachmentIds, cat.attachments === 'required' ? 'required' : 'optional');
      // A leave request sent back for changes still covers its days until it is corrected or withdrawn.
      if (await tx.collection('staff_requests').exists({ requester_membership_id: actor.membershipId, kind: 'leave', status: 'changes_requested', start_date: { $lte: input.endDate }, end_date: { $gte: input.startDate } })) {
        throw Errors.conflict('overlapping_leave', 'A leave request for these dates is waiting for your corrections. Correct it in My Requests, or cancel it first.');
      }
      const details = {
        leaveTypeId: input.leaveTypeId, duration: input.duration, startHalf: input.startHalf, endHalf: input.endHalf,
        startTime: input.duration === 'hours' ? input.startTime ?? null : null, endTime: input.duration === 'hours' ? input.endTime ?? null : null,
        contactDuringLeave: input.contactDuringLeave ?? null, handoverTo: input.handoverTo ?? null,
      };
      const row = await tx.collection('staff_requests').insert({
        kind: 'leave', category_key: 'leave', title: null, reason: input.reason, start_date: input.startDate, end_date: input.endDate,
        start_time: details.startTime, end_time: details.endTime, leave_type_id: input.leaveTypeId, leave_details: details,
        requester_membership_id: actor.membershipId, employee_id: c.employee.id, approver_membership_ids: approvers, cc_membership_ids: input.ccIds,
        workflow: cat.workflow, attachment_ids: input.attachmentIds, round: 1, approval_ids: [],
      });
      const id = row.id as string;
      const ref = requestRef(id, 'leave');
      const form = await this.leaveForm(tx, actor.membershipId, approvers, input.ccIds, { ...input, ...details }, ref);
      const leave = await this.fileLeave(tx, id, { ...input, ...details }, form);
      await tx.collection('staff_requests').updateOne({ id }, { $set: { leave_request_id: leave.id } });
      await this.startRound(tx, id);
      await this.emailLeaveForm(tx, id, form, String(leave.days), approvers, actor.membershipId);
      await this.audit.record(tx, {
        action: 'staff_request.leave_applied', resourceType: 'staff_request', resourceId: id,
        changes: { leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, duration: input.duration, days: String(leave.days), approvers, cc: input.ccIds, workflow: cat.workflow },
        metadata: { reference: ref, leaveRequestId: leave.id, leaveReference: leaveRef(leave.id as string) },
      });
      return this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id }))!);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Deciding (through the approvals engine), comments, corrections and cancelling
  // ---------------------------------------------------------------------------------------------------------

  /** Approve, reject (reason required) or ask for changes (comment required), as one of the request's approvers. */
  async decide(id: string, input: RequestDecisionInput) {
    const r = await this.db.tenant((tx) => tx.collection('staff_requests').findOne({ id }, { projection: { approval_request_id: 1, status: 1 } }));
    if (!r) throw Errors.notFound('Request');
    if (r.status !== 'pending' || !r.approval_request_id) throw Errors.conflict('invalid_state', `This request is ${String(r.status).replace('_', ' ')}: there is nothing to decide`);
    await this.approvals.decide(r.approval_request_id, input.decision, input.comment);
    return this.get(id);
  }

  /** One decision of one approver: the request's history records it (the end of the request is handled in `closed`). */
  private async stepDecided(tx: TenantTx, req: ApprovalRequestRow, step: { membershipId: string; decision: 'approve' | 'reject' | 'changes'; comment: string | null }) {
    const r = await tx.collection('staff_requests').findOne({ id: req.resource_id }, { projection: { round: 1 } });
    if (!r) return;
    const action = step.decision === 'approve' ? 'approved' : step.decision === 'reject' ? 'rejected' : 'changes_requested';
    await this.event(tx, r.id as string, action, step.membershipId, step.comment, (r.round as number | undefined) ?? 1);
  }

  /** The approvals engine ended the round: fully approved, rejected, or sent back for changes. */
  private async closed(tx: TenantTx, req: ApprovalRequestRow, status: 'approved' | 'rejected' | 'changes_requested') {
    const r = await tx.collection('staff_requests').findOne({ id: req.resource_id });
    if (!r || r.approval_request_id !== req.id) return;
    if (!(await tx.collection('staff_requests').updateOne({ id: r.id, status: 'pending' }, { $set: { status, decided_at: status === 'changes_requested' ? null : new Date() } }))) return;
    const kind = r.kind as RequestKind;
    // What an approval does: the leave is booked (balance and attendance), approved leave is cancelled, punches are
    // added, or the days are worked out again with the arrangement that was approved.
    if (status === 'approved') {
      if (kind === 'leave' && r.leave_request_id) await this.leave.approveManaged(tx, r.leave_request_id, req.comment ?? null);
      if (kind === 'leave_cancellation' && r.leave_request_id) {
        await this.leave.cancelApprovedManaged(tx, r.leave_request_id, r.reason);
        const original = await tx.collection('staff_requests').findOne({ leave_request_id: r.leave_request_id, kind: 'leave' }, { projection: { round: 1 } });
        if (original) {
          await tx.collection('staff_requests').updateOne({ id: original.id }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: `Cancellation approved (${requestRef(r.id, 'leave_cancellation')}): ${r.reason}` } });
          await this.event(tx, original.id as string, 'cancelled', r.requester_membership_id, `Leave cancelled after approval: ${r.reason}`, (original.round as number | undefined) ?? 1);
        }
      }
      if (kind === 'attendance_regularization' && r.employee_id) {
        await this.attendance.applyRegularization(tx, { id: r.id, employeeId: r.employee_id, workDate: r.start_date, checkIn: r.start_time ?? null, checkOut: r.end_time ?? null, requestedBy: r.requester_membership_id, reason: r.reason });
      }
      if (r.employee_id && ATTENDANCE_KINDS.has(kind)) await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
      await this.event(tx, r.id, 'completed', null, null, r.round ?? 1);
    } else if (kind === 'leave' && r.leave_request_id) {
      // Nothing was booked; the pending leave is closed (a corrected request files the leave again).
      await this.leave.closeManaged(tx, r.leave_request_id, status === 'rejected' ? 'rejected' : 'cancelled', status === 'rejected' ? req.comment ?? null : 'Changes asked for');
    }
    const view = await this.viewOf(tx, { ...r, status });
    const label = await this.labelOf(tx, r);
    const decider = view.events.filter((e) => ['approved', 'rejected', 'changes_requested'].includes(e.action)).at(-1)?.by ?? 'An approver';
    const comments = view.approvers.filter((a) => a.comment).map((a) => `${a.name}: "${a.comment}"`).join('\n');
    const headline = status === 'approved' ? 'approved' : status === 'rejected' ? `rejected by ${decider}` : `sent back for changes by ${decider}`;
    const extra = status === 'approved' && kind === 'leave' ? '\nYour leave balance and attendance are updated.' : status === 'changes_requested' ? '\nOpen the request, correct it and send it again.' : '';
    await this.notifications.notify(tx, {
      membershipIds: [r.requester_membership_id],
      kind: `request.${status}`,
      title: `${view.ref}: ${label} request ${headline}`,
      body: `${view.when}. Status: ${status.replace('_', ' ')}.${status !== 'approved' ? `\n${status === 'rejected' ? 'Reason' : 'What to correct'}: ${req.comment ?? 'not given'}` : comments ? `\n${comments}` : ''}${extra}`,
      link: `/requests/${r.id}`, email: true, priority: status === 'approved' ? 'normal' : 'high', action: status === 'changes_requested',
      resource: { type: 'staff_request', id: r.id }, includeActor: true,
    });
    if (r.cc_membership_ids?.length && status !== 'changes_requested') {
      await this.notifications.notify(tx, {
        membershipIds: r.cc_membership_ids, kind: `request.${status}`,
        title: `${view.ref}: ${view.requester.name}'s ${label.toLowerCase()} request ${headline}`,
        body: `${view.when}. Status: ${status}. You are in CC on this request.`,
        link: `/requests/${r.id}`, email: true, resource: { type: 'staff_request', id: r.id },
      });
    }
    await this.notifications.signal(tx, [r.requester_membership_id, ...r.approver_membership_ids, ...(r.cc_membership_ids ?? [])], 'approvals.changed');
    await this.audit.record(tx, { action: `staff_request.${status}`, resourceType: 'staff_request', resourceId: r.id, metadata: { comment: req.comment ?? null, round: r.round ?? 1, reference: view.ref } });
  }

  /** A comment from anyone on the request (requester, approver, CC participant): everyone else on it is told. */
  comment(id: string, body: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.visible(tx, id, actor.membershipId);
      await this.event(tx, id, 'commented', actor.membershipId, body, r.round ?? 1);
      const me = (await this.peopleOf(tx, [actor.membershipId])).get(actor.membershipId) ?? NOBODY;
      const label = await this.labelOf(tx, r);
      const others = [r.requester_membership_id, ...r.approver_membership_ids, ...(r.cc_membership_ids ?? [])].filter((m: string) => m !== actor.membershipId);
      await this.notifications.notify(tx, {
        membershipIds: others, kind: 'request.commented', title: `${requestRef(id, r.kind)}: ${me.name} commented on ${r.requester_membership_id === actor.membershipId ? 'their' : 'the'} ${label.toLowerCase()} request`,
        body: body.length > 300 ? `${body.slice(0, 300)}…` : body, link: `/requests/${id}`, resource: { type: 'staff_request', id },
      });
      await this.notifications.signal(tx, [actor.membershipId, ...others], 'approvals.changed');
      await this.audit.record(tx, { action: 'staff_request.commented', resourceType: 'staff_request', resourceId: id });
      return this.viewOf(tx, r);
    });
  }

  /** The requester corrects a request an approver sent back: it goes to the same approvers again, as a new round. */
  resubmit(id: string, input: RequestResubmitInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('staff_requests').findOne({ id });
      if (!r || r.requester_membership_id !== actor.membershipId) throw Errors.notFound('Request');
      await tx.collection('staff_requests').lock({ id });
      if (r.status !== 'changes_requested') throw Errors.conflict('invalid_state', 'Only a request sent back for changes can be corrected and sent again');
      const kind = r.kind as RequestKind;
      const def = defOf(kind);
      const start = input.startDate;
      const end = input.endDate ?? (def.timing === 'days' ? r.end_date : start);
      if (end < start) throw Errors.badRequest('end_before_start', 'The end date is before the start date');
      const startTime = input.startTime ?? r.start_time ?? null;
      const endTime = input.endTime ?? r.end_time ?? null;
      if (def.timing !== 'days' && end !== start) throw Errors.badRequest('one_day', `${def.label} is for one day`);
      const settings = await this.settingsOf(tx);
      const cat = settings.categories.find((c) => c.key === (r.category_key ?? kind));
      const attachments = input.attachmentIds ?? (r.attachment_ids as string[]);
      await this.checkAttachments(tx, attachments, cat?.attachments ?? 'optional', r.attachment_ids as string[]);
      if (kind !== 'leave') await this.checkDuplicate(tx, { requester: actor.membershipId, kind, categoryKey: r.category_key ?? kind, startDate: start, endDate: end, except: id });
      const set: Doc = {
        reason: input.reason, start_date: start, end_date: end, start_time: startTime, end_time: endTime, worked_on: input.workedOn ?? r.worked_on ?? null,
        title: input.title?.trim() || r.title || null, attachment_ids: attachments, round: (r.round ?? 1) + 1,
      };
      if (kind === 'leave') {
        const prev = (r.leave_details ?? {}) as Doc;
        const duration = (input.duration ?? prev.duration ?? 'full') as LeaveDuration;
        const details = {
          ...prev, leaveTypeId: input.leaveTypeId ?? r.leave_type_id, duration,
          startHalf: input.startHalf ?? prev.startHalf ?? 'full', endHalf: input.endHalf ?? prev.endHalf ?? 'full',
          startTime: duration === 'hours' ? startTime : null, endTime: duration === 'hours' ? endTime : null,
        };
        if (duration === 'hours' && (!details.startTime || !details.endTime || details.endTime <= details.startTime)) throw Errors.badRequest('hours_required', 'Give the time you leave and the time you are back');
        if (duration !== 'full' && duration !== 'half' && start !== end) throw Errors.badRequest('one_day', 'Hourly leave is for one day');
        Object.assign(set, { leave_type_id: details.leaveTypeId, leave_details: details, start_time: details.startTime, end_time: details.endTime });
        const ref = requestRef(id, 'leave');
        const form = await this.leaveForm(tx, actor.membershipId, r.approver_membership_ids, r.cc_membership_ids ?? [], { ...details, startDate: start, endDate: end, reason: input.reason }, ref);
        const leave = await this.fileLeave(tx, id, { ...details, startDate: start, endDate: end, reason: input.reason, attachmentIds: attachments }, form);
        set.leave_request_id = leave.id;
        await tx.collection('staff_requests').updateOne({ id }, { $set: set });
        await this.startRound(tx, id, { resubmitted: input.note ?? null });
        await this.emailLeaveForm(tx, id, form, String(leave.days), r.approver_membership_ids, actor.membershipId);
      } else {
        await tx.collection('staff_requests').updateOne({ id }, { $set: set });
        await this.startRound(tx, id, { resubmitted: input.note ?? null });
      }
      await this.audit.record(tx, { action: 'staff_request.resubmitted', resourceType: 'staff_request', resourceId: id, changes: { startDate: start, endDate: end, round: set.round }, metadata: { note: input.note ?? null } });
      return this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id }))!);
    });
  }

  /**
   * The requester withdraws a request: while it waits for a decision or for corrections, or an approved request (not
   * leave) before it starts. Approved leave is cancelled with `cancelLeave` instead.
   */
  cancel(id: string, reason?: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('staff_requests').findOne({ id });
      if (!r || r.requester_membership_id !== actor.membershipId) throw Errors.notFound('Request');
      await tx.collection('staff_requests').lock({ id });
      const view = await this.viewOf(tx, r);
      if (!view.can.cancel) {
        throw Errors.conflict('invalid_state', r.status === 'approved'
          ? (r.kind === 'leave' ? 'This leave is approved: use Cancel leave, which asks your approvers.' : 'This request has started, so it can no longer be withdrawn.')
          : `This request is already ${String(r.status).replace('_', ' ')}`);
      }
      if (r.status === 'pending' && r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      if (r.kind === 'leave' && r.leave_request_id) await this.leave.closeManaged(tx, r.leave_request_id, 'cancelled', reason ?? 'Request withdrawn');
      await tx.collection('staff_requests').updateOne({ id }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason ?? null } });
      await this.event(tx, id, 'cancelled', actor.membershipId, reason ?? null, r.round ?? 1);
      if (r.approval_request_id) await this.notifications.resolveByLink(tx, `/approvals/${r.approval_request_id}`, []);
      const label = await this.labelOf(tx, r);
      await this.notifications.notify(tx, {
        membershipIds: [...r.approver_membership_ids, ...(r.cc_membership_ids ?? [])], kind: 'request.cancelled',
        title: `${view.ref}: ${view.requester.name} cancelled a ${label.toLowerCase()} request`,
        body: `${view.when}. Nothing more is needed from you.${reason ? `\nReason: ${reason}` : ''}`, link: `/requests/${id}`, resource: { type: 'staff_request', id },
      });
      await this.notifications.signal(tx, [actor.membershipId, ...r.approver_membership_ids, ...(r.cc_membership_ids ?? [])], 'approvals.changed');
      if (r.status === 'approved' && r.employee_id && ATTENDANCE_KINDS.has(r.kind)) await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
      await this.audit.record(tx, { action: 'staff_request.cancelled', resourceType: 'staff_request', resourceId: id, metadata: { reason: reason ?? null, was: r.status } });
      return this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id }))!);
    });
  }

  /**
   * Cancelling approved leave. As the Request settings say: through the same approvers (a leave cancellation request,
   * the leave stays booked until it is approved), or straight away when it has not started yet.
   */
  cancelLeave(id: string, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('staff_requests').findOne({ id });
      if (!r || r.requester_membership_id !== actor.membershipId || r.kind !== 'leave') throw Errors.notFound('Request');
      await tx.collection('staff_requests').lock({ id });
      const leave = r.leave_request_id ? await tx.collection('leave_requests').findOne({ id: r.leave_request_id }, { projection: { status: 1 } }) : null;
      if (r.status !== 'approved' || leave?.status !== 'approved') throw Errors.conflict('invalid_state', 'Only approved leave is cancelled this way. A pending request is simply cancelled.');
      if (await tx.collection('staff_requests').exists({ kind: 'leave_cancellation', leave_request_id: r.leave_request_id, status: { $in: OPEN } })) {
        throw Errors.conflict('duplicate_request', 'A cancellation of this leave is already waiting for your approvers');
      }
      const settings = await this.settingsOf(tx);
      if (settings.approvedLeaveCancellation === 'before_start' && r.start_date > todayUtc()) {
        await this.leave.cancelApprovedManaged(tx, r.leave_request_id, reason);
        await tx.collection('staff_requests').updateOne({ id }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason } });
        await this.event(tx, id, 'cancelled', actor.membershipId, reason, r.round ?? 1);
        const view = await this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id }))!);
        await this.notifications.notify(tx, {
          membershipIds: [...r.approver_membership_ids, ...(r.cc_membership_ids ?? [])], kind: 'request.cancelled',
          title: `${view.ref}: ${view.requester.name} cancelled approved leave`, body: `${view.when}. The days are back in the balance.\nReason: ${reason}`,
          link: `/requests/${id}`, resource: { type: 'staff_request', id }, email: true,
        });
        await this.audit.record(tx, { action: 'staff_request.leave_cancelled', resourceType: 'staff_request', resourceId: id, metadata: { reason } });
        return { request: view, cancellation: null };
      }
      const cat = settings.categories.find((c) => c.key === 'leave');
      const row = await tx.collection('staff_requests').insert({
        kind: 'leave_cancellation', category_key: 'leave_cancellation', title: null, reason, start_date: r.start_date, end_date: r.end_date,
        start_time: r.start_time ?? null, end_time: r.end_time ?? null, leave_type_id: r.leave_type_id, leave_request_id: r.leave_request_id,
        requester_membership_id: actor.membershipId, employee_id: r.employee_id, approver_membership_ids: r.approver_membership_ids,
        cc_membership_ids: r.cc_membership_ids ?? [], workflow: cat?.workflow ?? r.workflow, attachment_ids: [], round: 1, approval_ids: [],
      });
      await this.startRound(tx, row.id as string);
      await this.event(tx, id, 'cancellation_requested', actor.membershipId, reason, r.round ?? 1);
      await this.audit.record(tx, { action: 'staff_request.cancellation_requested', resourceType: 'staff_request', resourceId: id, metadata: { cancellationId: row.id, reason } });
      return {
        request: await this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id }))!),
        cancellation: await this.viewOf(tx, (await tx.collection('staff_requests').findOne({ id: row.id }))!),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reading: one request, My Requests, My Approvals
  // ---------------------------------------------------------------------------------------------------------

  get(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => this.viewOf(tx, await this.visible(tx, id, actor.membershipId)));
  }

  /** Whether the caller oversees every request (Super Workspace, or HR who configure leave). */
  private async oversees(tx: TenantTx) {
    const s = await this.authz.subject(tx);
    return hasPermission(s, 'org:manage').allowed || hasPermission(s, 'leave:configure').allowed;
  }

  /** The requester, its approvers and CC participants may open a request, and the people who oversee requests. */
  private async visible(tx: TenantTx, id: string, membershipId: string) {
    const r = await tx.collection('staff_requests').findOne({ id });
    if (!r) throw Errors.notFound('Request');
    if (r.requester_membership_id === membershipId || (r.approver_membership_ids as string[]).includes(membershipId) || ((r.cc_membership_ids as string[] | undefined) ?? []).includes(membershipId)) return r;
    if (await this.oversees(tx)) return r;
    if (r.approval_request_id && (await this.approvals.approversOf(tx, r.approval_request_id)).includes(membershipId)) return r;
    throw Errors.notFound('Request');
  }

  private async viewOf(tx: TenantTx, r: Doc): Promise<RequestView> {
    return (await this.viewsOf(tx, [r], { full: true }))[0]!;
  }

  private async viewsOf(tx: TenantTx, rows: Doc[], opts: { full: boolean } = { full: false }): Promise<RequestView[]> {
    if (!rows.length) return [];
    const actor = requestContext.get()?.actor?.kind === 'user' ? requestContext.tenantActor().membershipId : null;
    const events = opts.full ? await tx.collection('staff_request_events').find({ request_id: { $in: rows.map((r) => r.id) } }, { sort: { created_at: 1 }, limit: 2000 }) : [];
    const people = await this.peopleOf(tx, [...rows.flatMap((r) => [r.requester_membership_id, ...(r.approver_membership_ids as string[]), ...((r.cc_membership_ids as string[] | undefined) ?? [])]), ...events.map((e) => e.membership_id)]);
    const steps = await tx.collection('approval_steps').find({ request_id: { $in: rows.map((r) => r.approval_request_id).filter(Boolean) } }, { projection: { request_id: 1, approver_membership_id: 1, status: 1, comment: 1, decided_at: 1, decided_by_membership_id: 1, stage: 1 } });
    const leaves = await tx.collection('leave_requests').find({ id: { $in: rows.map((r) => r.leave_request_id).filter(Boolean) } }, { projection: { status: 1, days: 1, leave_type_id: 1, start_half: 1, end_half: 1, start_time: 1, end_time: 1, start_date: 1, end_date: 1 } });
    const types = await tx.collection('leave_types').find({ id: { $in: [...new Set([...rows.map((r) => r.leave_type_id), ...leaves.map((l) => l.leave_type_id)].filter(Boolean))] } }, { projection: { name: 1 } });
    const fileIds = [...new Set(rows.flatMap((r) => (r.attachment_ids as string[] | undefined) ?? []))];
    const fileNames = new Map((fileIds.length ? await tx.collection('comm_files').find({ id: { $in: fileIds } }, { projection: { name: 1 } }) : []).map((f) => [f.id as string, f.name as string]));
    const pendingCancels = new Set((await tx.collection('staff_requests').find({ kind: 'leave_cancellation', leave_request_id: { $in: leaves.map((l) => l.id) }, status: { $in: OPEN } }, { projection: { leave_request_id: 1 } })).map((c) => c.leave_request_id as string));
    const settings = await this.settingsOf(tx);
    const catLabel = new Map(settings.categories.map((c) => [c.key, c.label]));
    const typeName = new Map(types.map((t) => [t.id as string, t.name as string]));
    const leaveOf = new Map(leaves.map((l) => [l.id as string, l]));
    const today = todayUtc();
    const person = (m: string) => people.get(m) ?? { ...NOBODY, membershipId: m };
    return rows.map((r) => {
      const kind = (REQUEST_KIND_DEFS[r.kind as RequestKind] ? r.kind : 'leave') as RequestKind;
      const def = defOf(kind);
      const workflow = ((r.workflow as RequestWorkflow | undefined) ?? 'all');
      const mySteps = steps.filter((st) => st.request_id === r.approval_request_id);
      const approverIds = r.approver_membership_ids as string[];
      const approvers = approverIds.map((m, i) => {
        const st = mySteps.find((x) => x.approver_membership_id === m);
        const raw = (st?.status as string | undefined) ?? (r.status === 'cancelled' ? 'cancelled' : 'not_needed');
        const status: RequestApproverStatus = raw === 'skipped' ? 'not_needed' : (raw as RequestApproverStatus);
        return { ...person(m), part: i === 0 ? 'primary' as const : 'additional' as const, status, comment: (st?.comment as string | null | undefined) ?? null, decidedAt: iso(st?.decided_at) };
      });
      const approved = approvers.filter((a) => a.status === 'approved').length;
      const pendingWith = approvers.filter((a) => a.status === 'pending').map((a) => a.name).join(', ') || null;
      const rEvents = events.filter((e) => e.request_id === r.id).map((e) => ({
        id: e.id as string, action: e.action, by: e.membership_id ? person(e.membership_id).name : null, byLevel: e.membership_id ? person(e.membership_id).levelLabel : null,
        comment: (e.comment as string | null) ?? null, at: iso(e.created_at)!,
      }));
      const deciderStep = [...mySteps].filter((s) => ['approved', 'rejected', 'changes_requested'].includes(s.status)).sort((a, b) => +new Date(b.decided_at) - +new Date(a.decided_at))[0];
      const by = deciderStep?.decided_by_membership_id ? person(deciderStep.decided_by_membership_id).name : null;
      const l = r.leave_request_id ? leaveOf.get(r.leave_request_id) : undefined;
      const det = (r.leave_details ?? {}) as Doc;
      const mine = actor !== null && r.requester_membership_id === actor;
      const categoryKey = (r.category_key as string | undefined) ?? kind;
      const label = catLabel.get(categoryKey) ?? def.label;
      const open = OPEN.includes(r.status);
      return {
        id: r.id, ref: requestRef(r.id, kind), kind, kindLabel: label, categoryKey, title: requestTitle(kind, r.title, label), reason: r.reason,
        startDate: r.start_date, endDate: r.end_date, startTime: r.start_time ?? null, endTime: r.end_time ?? null, workedOn: r.worked_on ?? null,
        days: requestDays(r.start_date, r.end_date),
        when: requestWhen({ kind: def.isLeave && det.duration !== 'hours' ? 'leave' : kind, startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time }) + (def.isLeave && det.duration === 'half' && r.start_date === r.end_date ? (det.startHalf === 'second_half' ? ' (second half)' : ' (first half)') : ''),
        status: r.status, statusMessage: requestStatusMessage(r.status, { approved, total: approvers.length, waitingOn: pendingWith, workflow }, by),
        workflow, round: (r.round as number | undefined) ?? 1,
        approvalId: r.approval_request_id ?? null,
        requester: person(r.requester_membership_id),
        approvers,
        cc: ((r.cc_membership_ids as string[] | undefined) ?? []).map(person),
        pendingWith: r.status === 'pending' ? pendingWith : null,
        attachments: ((r.attachment_ids as string[] | undefined) ?? []).map((f) => ({ id: f, name: fileNames.get(f) ?? 'Document', href: `/request-files/${r.id}/${f}` })),
        events: rEvents as RequestEventView[],
        leave: l && kind === 'leave' ? {
          id: l.id as string, ref: leaveRef(l.id as string), status: l.status as string, leaveTypeId: l.leave_type_id as string, leaveTypeName: typeName.get(l.leave_type_id) ?? 'Leave',
          days: String(l.days), duration: (det.duration as LeaveDuration | undefined) ?? 'full', startHalf: l.start_half ?? 'full', endHalf: l.end_half ?? 'full',
          startTime: l.start_time ?? null, endTime: l.end_time ?? null, contactDuringLeave: det.contactDuringLeave ?? null, handoverTo: det.handoverTo ?? null,
        } : null,
        cancelsLeave: kind === 'leave_cancellation' && l ? { id: l.id as string, ref: leaveRef(l.id as string), when: requestWhen({ kind: 'leave', startDate: l.start_date, endDate: l.end_date }) } : null,
        can: {
          cancel: mine && (open || (r.status === 'approved' && !def.isLeave && kind !== 'leave_cancellation' && r.start_date >= today)),
          resubmit: mine && r.status === 'changes_requested',
          comment: actor !== null && r.status !== 'cancelled',
          decide: actor !== null && r.status === 'pending' && mySteps.some((s) => s.status === 'pending' && s.approver_membership_id === actor),
          cancelApprovedLeave: mine && kind === 'leave' && r.status === 'approved' && l?.status === 'approved' && !pendingCancels.has(l.id as string),
        },
        createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at ?? r.created_at)!, decidedAt: iso(r.decided_at), cancelReason: r.cancel_reason ?? null,
      } satisfies RequestView;
    });
  }

  /** My Requests: the caller's own requests, newest first, with counts for the tabs. */
  mine(q: { status?: RequestStatus; kind?: RequestKind; limit: number }) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const all = await tx.collection('staff_requests').find({ requester_membership_id: actor.membershipId }, { sort: { created_at: -1 }, limit: 1000 });
      const rows = all.filter((r) => (!q.status || r.status === q.status) && (!q.kind || r.kind === q.kind)).slice(0, q.limit);
      const count = (s: string) => all.filter((r) => r.status === s).length;
      return {
        counts: { all: all.length, pending: count('pending'), changes_requested: count('changes_requested'), approved: count('approved'), rejected: count('rejected'), cancelled: count('cancelled') },
        items: await this.viewsOf(tx, rows),
      };
    });
  }

  /**
   * My Approvals: requests the caller is an approver on (every round), with the filters of the unified dashboard.
   * People who oversee requests (Super Workspace, HR who configure leave) see everyone's under "All".
   */
  approvalsList(q: RequestApprovalsQuery) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const oversees = await this.oversees(tx);
      const mineFilter = { approver_membership_ids: actor.membershipId };
      const base = await tx.collection('staff_requests').find(oversees && q.view !== 'pending' ? {} : mineFilter, { sort: { created_at: -1 }, limit: 3000 });
      const waiting = new Set((await tx.collection('approval_steps').find({ request_id: { $in: base.map((r) => r.approval_request_id).filter(Boolean) }, approver_membership_id: actor.membershipId, status: 'pending' }, { projection: { request_id: 1 } })).map((s) => s.request_id as string));
      const isMineWaiting = (r: Doc) => r.status === 'pending' && waiting.has(r.approval_request_id);
      const people = q.employee || q.workspace ? await this.peopleOf(tx, base.map((r) => r.requester_membership_id)) : new Map<string, RequestPerson>();
      const needle = q.employee?.toLowerCase();
      const filtered = base.filter((r) => {
        if (q.kind && r.kind !== q.kind) return false;
        if (q.from && r.end_date < q.from) return false;
        if (q.to && r.start_date > q.to) return false;
        const p = people.get(r.requester_membership_id);
        if (needle && !(p && [p.name, p.employeeCode, p.department, p.designation].some((f) => (f ?? '').toLowerCase().includes(needle)))) return false;
        if (q.workspace && p?.level !== q.workspace) return false;
        return true;
      });
      const byView = (v: RequestApprovalsQuery['view'], r: Doc) => (v === 'pending' ? isMineWaiting(r) : v === 'all' ? true : r.status === v);
      const counts = {
        pending: filtered.filter((r) => byView('pending', r)).length,
        all: filtered.length,
        approved: filtered.filter((r) => r.status === 'approved').length,
        rejected: filtered.filter((r) => r.status === 'rejected').length,
        cancelled: filtered.filter((r) => r.status === 'cancelled').length,
        changes_requested: filtered.filter((r) => r.status === 'changes_requested').length,
      };
      const rows = filtered.filter((r) => byView(q.view, r)).slice(0, q.limit);
      return { counts, oversees, items: await this.viewsOf(tx, rows) };
    });
  }

  /** The menu badges: the caller's requests waiting, sent back to them, and requests waiting for their decision. */
  summary() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('staff_requests').find({ requester_membership_id: actor.membershipId, status: { $in: OPEN } }, { projection: { status: 1 }, limit: 1000 });
      const assigned = await tx.collection('staff_requests').find({ approver_membership_ids: actor.membershipId, status: 'pending' }, { projection: { approval_request_id: 1 }, limit: 1000 });
      const toDecide = assigned.length ? await tx.collection('approval_steps').count({ request_id: { $in: assigned.map((r) => r.approval_request_id).filter(Boolean) }, approver_membership_id: actor.membershipId, status: 'pending' }) : 0;
      return { pending: rows.filter((r) => r.status === 'pending').length, changesRequested: rows.filter((r) => r.status === 'changes_requested').length, toDecide };
    });
  }

  /** My Day: the caller's own requests and the decisions they made lately (never anyone else's data beyond that). */
  myDay() {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const mine = await tx.collection('staff_requests').find({ requester_membership_id: actor.membershipId }, { sort: { created_at: -1 }, limit: 200 });
      const decided = await tx.collection('staff_request_events').find({ membership_id: actor.membershipId, action: { $in: ['approved', 'rejected', 'changes_requested'] } }, { sort: { created_at: -1 }, limit: 8 });
      const decidedRows = decided.length ? await tx.collection('staff_requests').find({ id: { $in: [...new Set(decided.map((e) => e.request_id))] } }) : [];
      const views = new Map((await this.viewsOf(tx, decidedRows)).map((v) => [v.id, v]));
      return {
        counts: { pending: mine.filter((r) => r.status === 'pending').length, changesRequested: mine.filter((r) => r.status === 'changes_requested').length, approved: mine.filter((r) => r.status === 'approved').length },
        recent: await this.viewsOf(tx, mine.slice(0, 5)),
        decisions: decided.filter((e) => views.has(e.request_id)).map((e) => {
          const v = views.get(e.request_id)!;
          return { id: e.id as string, requestId: v.id, ref: v.ref, title: v.title, requester: v.requester.name, action: e.action as string, comment: (e.comment as string | null) ?? null, at: iso(e.created_at)! };
        }),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Supporting documents
  // ---------------------------------------------------------------------------------------------------------

  uploadFile(file: UploadedFile | undefined) {
    return this.files.upload(file);
  }

  /** A short download link for a document on a request the caller may open. */
  fileLink(requestId: string, fileId: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.visible(tx, requestId, actor.membershipId);
      if (!((r.attachment_ids as string[] | undefined) ?? []).includes(fileId)) throw Errors.notFound('Document');
      await this.audit.record(tx, { action: 'staff_request.document_downloaded', resourceType: 'staff_request', resourceId: requestId, metadata: { fileId } });
      return this.storage.sign(fileId, 300, 'comm');
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reminders (hourly HR job)
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Approvers of a pending request that starts within the reminder days (Request settings) are reminded once:
   * "Approval pending". Runs in the hourly HR job of each workspace.
   */
  async remindDue(tenantId: string, asOf: string): Promise<number> {
    return this.db.tenant(async (tx) => {
      const settings = await this.settingsOf(tx);
      if (!settings.reminderDaysBefore) return 0;
      const due = await tx.collection('staff_requests').find({ status: 'pending', reminded_at: null, start_date: { $gte: asOf, $lte: addDaysIso(asOf, settings.reminderDaysBefore) } }, { limit: 500 });
      let n = 0;
      for (const r of due) {
        if (!r.approval_request_id) continue;
        const waiting = await this.approvals.approversOf(tx, r.approval_request_id);
        if (!waiting.length) continue;
        const view = (await this.viewsOf(tx, [r]))[0]!;
        await this.notifications.notify(tx, {
          membershipIds: waiting, kind: 'request.reminder', title: `Approval pending: ${view.ref}, ${view.requester.name}'s ${view.kindLabel.toLowerCase()} request`,
          body: `${view.when}. It starts ${r.start_date === asOf ? 'today' : `on ${requestDateLabel(r.start_date)}`} and is still waiting for your decision.`,
          link: `/requests/${r.id}`, email: true, priority: 'high', action: true, resource: { type: 'staff_request', id: r.id },
        });
        await tx.collection('staff_requests').updateOne({ id: r.id }, { $set: { reminded_at: new Date() } });
        await this.event(tx, r.id, 'reminded', null, null, r.round ?? 1);
        n += 1;
      }
      return n;
    }, { tenantId });
  }
}

import { Injectable } from '@nestjs/common';
import {
  CENTRAL_GROUP,
  EMPLOYEE_LEVEL_PERMISSIONS,
  HR_LEVEL_PERMISSIONS,
  levelPermission,
  type AttendanceCapabilities,
  type AttendanceViewerLevel,
  type HrAttendanceAccessInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission, type Subject } from '../../platform/authz/policy';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/**
 * Employee Workspace sees only its own attendance, managers included (Kunal's attendance spec, 2026-11-21). Approvals
 * of their reports' corrections and overtime still reach managers through Approvals, which carries the request itself.
 */
export const EMPLOYEE_SEES_TEAM_ATTENDANCE = false;

/** Who a person is for attendance: their level, and for HR Workspace the groups they look after. */
export interface AttendanceViewer {
  level: AttendanceViewerLevel;
  subject: Subject;
  membershipId: string;
  employeeId: string | null;
  /** HR Workspace: the HR Workspaces (or "central" for company-wide HR) their access names. */
  homeGroups: string[];
  /** HR Workspace with view_other_hr: the other groups they may see ("all" for every one). */
  otherGroups: string[] | 'all';
  viewOtherHr: boolean;
  canExport: boolean;
  /** Office / home / hybrid totals for the whole company (numbers only): Super Workspace, and HR with attendance.org_totals. */
  orgTotals: boolean;
  /** Memberships at Super Workspace and at HR Workspace level in the company. */
  superMemberships: Set<string>;
  hrMemberships: Set<string>;
  /** HR Workspace people by the group they look after (membership ids). */
  adminsByGroup: Map<string, Set<string>>;
}

const NONE = { _id: { $in: [] } };

/**
 * The single place that decides whose attendance a person may see, used by every attendance read (the overview, the
 * register, team and day views, and the Excel export), so a screen hiding a link is never the only guard:
 *  - Super Workspace: everyone.
 *  - HR Workspace: themselves, and the Employee Workspace people their HR Workspace access covers, never anyone at
 *    Super Workspace level and never other HR Workspace people, unless the Super Workspace turned on
 *    "View other HR Workspace attendance" for them; then also the people of the HR Workspaces it names.
 *  - Employee Workspace: themselves only.
 */
@Injectable()
export class AttendanceAccessService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** The viewer is worked out once per request (the subject is memoised per request, so it keys the cache). */
  private readonly cache = new WeakMap<Subject, AttendanceViewer>();

  async viewer(tx: TenantTx): Promise<AttendanceViewer> {
    const subject = await this.authz.subject(tx);
    const hit = this.cache.get(subject);
    if (hit) return hit;
    const v = await this.load(tx, subject);
    this.cache.set(subject, v);
    return v;
  }

  private async load(tx: TenantTx, subject: Subject): Promise<AttendanceViewer> {
    const roles = new Set(subject.grants.map((g) => g.roleKey));
    const level: AttendanceViewerLevel = roles.has('super_workspace') ? 'super' : roles.has('hr_workspace') ? 'hr' : 'employee';
    const { superMemberships, hrMemberships, adminsByGroup } = await this.levelMemberships(tx);

    let homeGroups: string[] = [];
    let otherGroups: string[] | 'all' = [];
    let viewOtherHr = false;
    let canExport = level === 'super';
    let orgTotals = level === 'super';
    if (level === 'hr') {
      const hrGrants = subject.grants.filter((g) => g.roleKey === 'hr_workspace');
      homeGroups = hrGrants.some((g) => !g.constraints.hrWorkspaceIds?.length) ? [CENTRAL_GROUP] : [...new Set(hrGrants.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))];
      const saved = await tx.collection('level_permissions').find({ subject_type: 'hr_workspace', subject_id: { $in: homeGroups } });
      const rows = homeGroups.map((g) => saved.find((s) => s.subject_id === g));
      const on = (key: string) => rows.some((r) => levelPermission(HR_LEVEL_PERMISSIONS, r?.permissions, key));
      viewOtherHr = on('attendance.view_other_hr');
      canExport = on('attendance.export');
      orgTotals = on('attendance.org_totals');
      if (viewOtherHr) {
        const reach = rows.filter((r) => r && levelPermission(HR_LEVEL_PERMISSIONS, r.permissions, 'attendance.view_other_hr')).map((r) => r!.scope_hr_workspace_ids as string[] | null | undefined);
        otherGroups = reach.some((r) => r === null || r === undefined) ? 'all' : [...new Set(reach.flat() as string[])].filter((g) => !homeGroups.includes(g));
      }
    } else if (level === 'employee') {
      const saved = await tx.collection('level_permissions').findOne({ subject_type: 'employee_workspace', subject_id: 'all' });
      canExport = levelPermission(EMPLOYEE_LEVEL_PERMISSIONS, saved?.permissions, 'attendance.export_own');
    }
    // Attendance itself switched off for the person (feature or permission): nothing to see or export.
    if (!hasPermission(subject, 'attendance:read').allowed) canExport = false;
    return {
      level, subject, membershipId: subject.membershipId, employeeId: subject.employeeId ?? null,
      homeGroups, otherGroups, viewOtherHr, canExport, orgTotals, superMemberships, hrMemberships, adminsByGroup,
    };
  }

  /**
   * Everyone at Super Workspace and HR Workspace level in the company, and the HR Workspaces each HR person looks
   * after. Needs no signed-in person, so background jobs can use it too.
   */
  async levelMemberships(tx: TenantTx): Promise<{ superMemberships: Set<string>; hrMemberships: Set<string>; adminsByGroup: Map<string, Set<string>> }> {
    const levelRoles = new Map((await tx.collection('roles').find({ is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
    const assignments = await tx.collection('role_assignments').find({ role_id: { $in: [...levelRoles.keys()] } }, { projection: { membership_id: 1, role_id: 1, constraints: 1 } });
    const active = new Set(await tx.collection('memberships').distinct<string>('id', { id: { $in: assignments.map((a) => a.membership_id) }, status: 'active' }));
    const superMemberships = new Set<string>();
    const hrMemberships = new Set<string>();
    const adminsByGroup = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!active.has(a.membership_id)) continue;
      if (levelRoles.get(a.role_id) === 'super_workspace') superMemberships.add(a.membership_id);
      else {
        hrMemberships.add(a.membership_id);
        const groups = ((a.constraints?.hrWorkspaceIds ?? []) as string[]).length ? (a.constraints.hrWorkspaceIds as string[]) : [CENTRAL_GROUP];
        for (const g of groups) adminsByGroup.set(g, (adminsByGroup.get(g) ?? new Set()).add(a.membership_id));
      }
    }
    // Someone at Super Workspace level is never counted as HR Workspace too.
    for (const m of superMemberships) hrMemberships.delete(m);
    return { superMemberships, hrMemberships, adminsByGroup };
  }

  capabilities(v: AttendanceViewer): AttendanceCapabilities {
    return {
      level: v.level,
      employeeId: v.employeeId,
      hrWorkspaces: v.level === 'super' || (v.level === 'hr' && v.viewOtherHr),
      employees: v.level !== 'employee',
      export: v.canExport,
      managePermissions: v.level === 'super' && hasPermission(v.subject, 'hierarchy:manage').allowed,
    };
  }

  /** A filter over employees for the people of some groups: employees placed there, and the HR people looking after them. */
  groupFilter(v: AttendanceViewer, groups: string[] | 'all'): Doc {
    if (groups === 'all') return {};
    if (!groups.length) return NONE;
    const placed = groups.map((g) => (g === CENTRAL_GROUP ? null : g));
    const admins = [...new Set(groups.flatMap((g) => [...(v.adminsByGroup.get(g) ?? [])]))];
    return { $or: [{ hr_workspace_id: { $in: placed } }, ...(admins.length ? [{ membership_id: { $in: admins } }] : [])] };
  }

  /** The employees whose attendance the viewer may see, as a filter over the employees collection. */
  async visibleFilter(tx: TenantTx, v: AttendanceViewer): Promise<Doc> {
    const base = await this.authz.filter('attendance:read', EMPLOYEE_FIELDS, tx);
    if (v.level === 'super') return base;
    if (v.level === 'employee') {
      if (EMPLOYEE_SEES_TEAM_ATTENDANCE) return base;
      return v.employeeId ? { $and: [base, { id: v.employeeId }] } : NONE;
    }
    // HR Workspace: never Super Workspace people; other HR Workspace people only through view_other_hr.
    const hidden = [...v.superMemberships, ...[...v.hrMemberships].filter((m) => m !== v.membershipId)];
    const own = { $and: [base, { membership_id: { $nin: hidden } }] };
    if (!v.viewOtherHr) return own;
    const others = { $and: [this.groupFilter(v, v.otherGroups), { membership_id: { $nin: [...v.superMemberships] } }] };
    return { $or: [own, others] };
  }

  /** The groups (HR Workspaces and "central") the viewer may open in the HR Workspace section. */
  async visibleGroups(tx: TenantTx, v: AttendanceViewer): Promise<string[]> {
    if (v.level === 'employee' || (v.level === 'hr' && !v.viewOtherHr)) return [];
    const all = [CENTRAL_GROUP, ...(await tx.collection('hr_workspaces').distinct<string>('id', { status: { $ne: 'archived' } }))];
    if (v.level === 'super' || v.otherGroups === 'all') return all;
    const wanted = new Set([...v.homeGroups, ...v.otherGroups]);
    return all.filter((g) => wanted.has(g));
  }

  // -------------------------------------------------------------------------------------------------------------
  // Settings (Super Workspace)
  // -------------------------------------------------------------------------------------------------------------

  private async requireSuper(tx: TenantTx) {
    const v = await this.viewer(tx);
    if (!this.capabilities(v).managePermissions) throw Errors.forbidden('Only the Super Workspace manages attendance permissions');
    return v;
  }

  /** Every HR Workspace (and the central group) with its attendance permissions, and the Employee Workspace ones. */
  settings() {
    return this.db.tenant(async (tx) => {
      await this.requireSuper(tx);
      const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } }, { sort: { name: 1 }, projection: { name: 1, code: 1, status: 1 } });
      const saved = await tx.collection('level_permissions').find({});
      const row = (id: string, name: string, code: string | null, status: string) => {
        const s = saved.find((x) => x.subject_type === 'hr_workspace' && x.subject_id === id);
        return {
          id, name, code, status,
          permissions: HR_LEVEL_PERMISSIONS.map((d) => ({ key: d.key, label: d.label, description: d.description, locked: d.locked, enabled: levelPermission(HR_LEVEL_PERMISSIONS, s?.permissions, d.key) })),
          otherHrWorkspaceIds: s ? ((s.scope_hr_workspace_ids as string[] | null) ?? null) : null,
          updatedAt: s?.updated_at ?? null,
        };
      };
      const emp = saved.find((x) => x.subject_type === 'employee_workspace' && x.subject_id === 'all');
      return {
        hrWorkspaces: [row(CENTRAL_GROUP, 'Central group (company-wide HR)', null, 'active'), ...spaces.map((w) => row(w.id, w.name, w.code ?? null, w.status))],
        employeeWorkspace: EMPLOYEE_LEVEL_PERMISSIONS.map((d) => ({ key: d.key, label: d.label, description: d.description, locked: d.locked, enabled: levelPermission(EMPLOYEE_LEVEL_PERMISSIONS, emp?.permissions, d.key) })),
      };
    });
  }

  saveHr(input: HrAttendanceAccessInput) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireSuper(tx);
      if (input.hrWorkspaceId !== CENTRAL_GROUP && !(await tx.collection('hr_workspaces').findOne({ id: input.hrWorkspaceId, status: { $ne: 'archived' } }))) throw Errors.notFound('HR Workspace');
      const others = input.otherHrWorkspaceIds === null ? null : [...new Set(input.otherHrWorkspaceIds.filter((g) => g !== input.hrWorkspaceId))];
      if (others?.length) {
        const real = new Set(await tx.collection('hr_workspaces').distinct<string>('id', { id: { $in: others.filter((g) => g !== CENTRAL_GROUP) }, status: { $ne: 'archived' } }));
        const unknown = others.filter((g) => g !== CENTRAL_GROUP && !real.has(g));
        if (unknown.length) throw Errors.badRequest('unknown_hr_workspace', 'Pick HR Workspaces that exist.');
      }
      const before = await tx.collection('level_permissions').findOne({ subject_type: 'hr_workspace', subject_id: input.hrWorkspaceId });
      const permissions = { ...(before?.permissions ?? {}), ...input.permissions };
      if (before) await tx.collection('level_permissions').updateOne({ id: before.id }, { $set: { permissions, scope_hr_workspace_ids: others, updated_by_membership_id: v.membershipId } });
      else await tx.collection('level_permissions').insert({ subject_type: 'hr_workspace', subject_id: input.hrWorkspaceId, permissions, scope_hr_workspace_ids: others, updated_by_membership_id: v.membershipId });
      await this.audit.record(tx, {
        action: 'attendance_access.updated', resourceType: 'hr_workspace', resourceId: input.hrWorkspaceId,
        changes: { permissions: { from: before?.permissions ?? {}, to: permissions }, otherHrWorkspaceIds: { from: before?.scope_hr_workspace_ids ?? null, to: others } },
      });
      return { ok: true };
    });
  }

  saveEmployee(permissions: Record<string, boolean>) {
    return this.db.tenant(async (tx) => {
      const v = await this.requireSuper(tx);
      const before = await tx.collection('level_permissions').findOne({ subject_type: 'employee_workspace', subject_id: 'all' });
      const next = { ...(before?.permissions ?? {}), ...permissions };
      if (before) await tx.collection('level_permissions').updateOne({ id: before.id }, { $set: { permissions: next, updated_by_membership_id: v.membershipId } });
      else await tx.collection('level_permissions').insert({ subject_type: 'employee_workspace', subject_id: 'all', permissions: next, scope_hr_workspace_ids: null, updated_by_membership_id: v.membershipId });
      await this.audit.record(tx, { action: 'attendance_access.updated', resourceType: 'employee_workspace', resourceId: 'all', changes: { permissions: { from: before?.permissions ?? {}, to: next } } });
      return { ok: true };
    });
  }
}

import { Injectable } from '@nestjs/common';
import { ACCESS_LEVEL_ROLES, CENTRAL_GROUP, EMPLOYEE_SELF_GRANTS, levelGrantAllowed, levelGrantScope, routeMatches, type Scope, workspacePermissionsOff, type WorkspacePermissionRoute } from '@crew/contracts';
import { requestContext } from '../context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../database/mongo.service';
import { Errors } from '../http/errors';
import { can, hasPermission, scopeFilter, type Grant, type HrWorkspacePeople, type ResourceAttributes, type Subject } from './policy';

const SUBJECT_KEY = Symbol('authz.subject');

/** Loads the RBAC/ABAC subject for the current member (memoised per request) and answers authorisation questions. */
@Injectable()
export class AuthzService {
  constructor(private readonly db: DatabaseService) {}

  async subject(tx?: TenantTx): Promise<Subject> {
    const ctx = requestContext.get() as (ReturnType<typeof requestContext.get> & { [SUBJECT_KEY]?: Subject }) | undefined;
    if (ctx?.[SUBJECT_KEY]) return ctx[SUBJECT_KEY];
    const actor = requestContext.tenantActor();
    const load = (t: TenantTx) => loadSubject(t, actor.membershipId, actor.userId, actor.mfa);
    const loaded = tx ? await load(tx) : await this.db.tenant(load);
    // An API key can never do more than its scopes allow, whatever its creator can do.
    const scopes = actor.apiKey ? new Set(actor.apiKey.scopes) : null;
    const subject = scopes ? { ...loaded, grants: loaded.grants.filter((g) => scopes.has(g.permission)) } : loaded;
    if (ctx) ctx[SUBJECT_KEY] = subject;
    return subject;
  }

  /**
   * Drops the subject kept for this request, so the next check reads it again: after a record the person's scope
   * depends on was just created in the same transaction (an imported employee joins an HR Workspace's people).
   */
  forget(): void {
    const ctx = requestContext.get() as (ReturnType<typeof requestContext.get> & { [SUBJECT_KEY]?: Subject }) | undefined;
    if (ctx) delete ctx[SUBJECT_KEY];
  }

  async require(permission: string, resource?: ResourceAttributes, tx?: TenantTx): Promise<Grant> {
    const s = await this.subject(tx);
    const d = resource ? can(s, permission, resource) : hasPermission(s, permission);
    if (d.allowed) return d.via;
    if (d.reason === 'mfa_required') throw Errors.mfaRequired();
    if (d.reason === 'out_of_scope') throw Errors.notFound();
    throw Errors.forbidden();
  }

  /** A query filter limiting documents to those the current member may act on with `permission` (matches nothing without a grant). */
  async filter(permission: string, fields: Parameters<typeof scopeFilter>[2], tx?: TenantTx): Promise<Record<string, unknown>> {
    const s = await this.subject(tx);
    return scopeFilter(s, permission, fields) ?? { _id: { $in: [] } };
  }
}

export async function loadSubject(tx: TenantTx, membershipId: string, userId: string, mfa: boolean): Promise<Subject> {
  const m = await tx.collection('memberships').findOne({ id: membershipId, status: 'active' });
  if (!m) throw Errors.forbidden('Your membership in this workspace is not active');

  // Permissions SAMPLEDGE switched off for the workspace have no effect, whatever the member's roles say.
  const disabled = new Set<string>((await tx.collection('tenant_access_controls').findOne({}))?.disabled_permissions ?? []);
  // Only the four access levels give access (Super, HR and Employee Workspace; Console Admin is the Console's own).
  // Old built-in and custom roles may still be in the database for rollback: they give nothing.
  const held = await tx.collection('role_assignments').find({ membership_id: membershipId });
  const roles = new Map(
    (await tx.collection('roles').find({ id: { $in: [...new Set(held.map((a) => a.role_id as string))] }, is_system: true, key: { $in: [...ACCESS_LEVEL_ROLES] } })).map((r) => [r.id as string, r.key as string]),
  );
  const assignments = held.filter((a) => roles.has(a.role_id as string));
  const roleIds = [...roles.keys()];
  const permissions = await tx.collection('role_permissions').find({ role_id: { $in: roleIds } });
  const grants: Grant[] = [];
  for (const a of assignments) {
    const limited = roles.get(a.role_id) !== 'employee_workspace';
    for (const rp of permissions) {
      if (rp.role_id !== a.role_id || disabled.has(rp.permission)) continue;
      // Super and HR Workspace may be limited to some areas or actions, or to what the person had before the levels.
      const scope = limited ? levelGrantScope(rp.permission, rp.scope as Scope, a.constraints) : (rp.scope as Scope);
      if (!scope) continue;
      grants.push({ permission: rp.permission, scope, roleKey: roles.get(a.role_id)!, constraints: a.constraints ?? {} });
    }
  }

  // Settings > Workspace Permissions: what the Super Workspace switched off for HR Workspace (per HR Workspace, or
  // "central" for company-wide HR people) and for Employee Workspace. Switches only take away: an HR Workspace person
  // keeps a permission while at least one of their HR Workspaces has it on; the Super Workspace is never limited.
  const offRoutes = await applyWorkspacePermissions(tx, grants);

  // HR Workspace Admins act only on the people of their HR Workspaces: resolve those once for the request.
  const hrIds = [...new Set(assignments.flatMap((a) => ((a.constraints?.hrWorkspaceIds ?? []) as string[])))];
  const hrPeople = new Map<string, { employees: string[]; memberships: string[] }>();
  if (hrIds.length) {
    const spaces = await tx.collection('hr_workspaces').find({ id: { $in: hrIds } }, { projection: { status: 1 } });
    const live = new Set(spaces.filter((w) => w.status === 'active').map((w) => w.id as string));
    const people = await tx.collection('employees').find({ hr_workspace_id: { $in: [...live] } }, { projection: { _id: 1, hr_workspace_id: 1, membership_id: 1 } });
    for (const id of live) hrPeople.set(id, { employees: [], memberships: [] });
    for (const e of people) {
      const bucket = hrPeople.get(e.hr_workspace_id as string)!;
      bucket.employees.push(e.id as string);
      if (e.membership_id) bucket.memberships.push(e.membership_id as string);
    }
  }
  const hrCache = new Map<string, HrWorkspacePeople>();
  const hrWorkspacePeople = (ids: string[]): HrWorkspacePeople => {
    const key = [...ids].sort().join(',');
    let v = hrCache.get(key);
    if (!v) {
      const employeeIds = new Set<string>();
      const membershipIds = new Set<string>();
      for (const id of ids) {
        const b = hrPeople.get(id);
        b?.employees.forEach((x) => employeeIds.add(x));
        b?.memberships.forEach((x) => membershipIds.add(x));
      }
      v = { employeeIds, membershipIds };
      hrCache.set(key, v);
    }
    return v;
  };

  const reports = await descendants(tx, 'memberships', 'manager_membership_id', membershipId);
  const reportEmployees = m.employee_id ? await descendants(tx, 'employees', 'current_manager_employee_id', m.employee_id) : new Set<string>();
  // Employee Workspace's team part applies only to people someone reports to; everyone else has their own records.
  if (!reports.size && !reportEmployees.size) {
    for (let i = grants.length - 1; i >= 0; i--) {
      const g = grants[i]!;
      if (g.roleKey !== 'employee_workspace') continue;
      const own = EMPLOYEE_SELF_GRANTS[g.permission as keyof typeof EMPLOYEE_SELF_GRANTS];
      if (!own) grants.splice(i, 1);
      else grants[i] = { ...g, scope: own };
    }
  }

  const departments = await tx.collection('departments').find({}, { projection: { _id: 1, parent_id: 1 } });
  const children = new Map<string, string[]>();
  for (const d of departments) {
    if (d.parent_id) children.set(d.parent_id, [...(children.get(d.parent_id) ?? []), d.id]);
  }
  const departmentSubtree = (ids: string[]) => {
    const out = new Set<string>();
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    return out;
  };

  return {
    userId,
    membershipId,
    legalEntityId: m.legal_entity_id ?? null,
    departmentId: m.department_id ?? null,
    locationId: m.location_id ?? null,
    reportIds: reports,
    employeeId: m.employee_id ?? null,
    reportEmployeeIds: reportEmployees,
    ownDepartmentSubtree: m.department_id ? departmentSubtree([m.department_id]) : new Set(),
    departmentSubtree,
    grants,
    mfa,
    hrWorkspacePeople,
    offRoutes,
  };
}

/**
 * Takes out of `grants` what Settings > Workspace Permissions switched off (in place) and returns the API routes that
 * are switched off for the person's level. HR Workspace grants follow the switches of the person's HR Workspaces
 * ("central" when not limited to any), Employee Workspace grants the switches for all Employee Workspaces.
 */
async function applyWorkspacePermissions(tx: TenantTx, grants: Grant[]): Promise<WorkspacePermissionRoute[]> {
  const hasSuper = grants.some((g) => g.roleKey === 'super_workspace');
  const hrGrants = grants.filter((g) => g.roleKey === 'hr_workspace');
  const groupsOf = (g: Grant) => ((g.constraints.hrWorkspaceIds ?? []) as string[]).length ? (g.constraints.hrWorkspaceIds as string[]) : [CENTRAL_GROUP];
  const hrGroups = [...new Set(hrGrants.flatMap(groupsOf))];
  const rows = await tx.collection('level_permissions').find({
    $or: [{ subject_type: 'employee_workspace', subject_id: 'all' }, ...(hrGroups.length ? [{ subject_type: 'hr_workspace', subject_id: { $in: hrGroups } }] : [])],
  }, { projection: { subject_type: 1, subject_id: 1, permissions: 1 } });
  const saved = new Map(rows.map((r) => [`${r.subject_type}:${r.subject_id}`, (r.permissions ?? {}) as Record<string, unknown>]));
  const employeeOff = workspacePermissionsOff('employee', [saved.get('employee_workspace:all')]);
  const hrOff = new Map<string, ReturnType<typeof workspacePermissionsOff>>();
  const hrOffFor = (groups: string[]) => {
    const key = [...groups].sort().join(',');
    let v = hrOff.get(key);
    if (!v) {
      v = workspacePermissionsOff('hr', groups.map((id) => saved.get(`hr_workspace:${id}`)));
      hrOff.set(key, v);
    }
    return v;
  };
  for (let i = grants.length - 1; i >= 0; i--) {
    const g = grants[i]!;
    if (g.roleKey === 'hr_workspace' && hrOffFor(groupsOf(g)).permissions.has(g.permission)) grants.splice(i, 1);
    else if (g.roleKey === 'employee_workspace' && employeeOff.permissions.has(g.permission)) grants.splice(i, 1);
  }
  if (hasSuper) return [];
  if (hrGrants.length) return hrOffFor(hrGroups).routes;
  return employeeOff.routes;
}

/** Is this API call switched off for the person's level in Settings > Workspace Permissions? */
export function routeSwitchedOff(s: Subject, path: string, method: string): boolean {
  return Boolean(s.offRoutes?.length) && routeMatches(s.offRoutes as WorkspacePermissionRoute[], path, method);
}

/** Everyone below `rootId` in a reporting tree, level by level (at most 50 levels, as the SQL version). */
export async function descendants(tx: TenantTx, table: string, parentField: string, rootId: string): Promise<Set<string>> {
  const out = new Set<string>();
  let frontier = [rootId];
  for (let depth = 0; depth < 50 && frontier.length; depth++) {
    const next = (await tx.collection(table).find({ [parentField]: { $in: frontier } }, { projection: { _id: 1 } })).map((r) => r.id as string).filter((id) => !out.has(id) && id !== rootId);
    next.forEach((id) => out.add(id));
    frontier = next;
  }
  return out;
}

/**
 * Active members holding a permission through their access level, once per scope, with the limits of the assignment
 * (areas and view-only included). For finding who to notify or who can pick up work: the policy engine still checks
 * each record when they act.
 */
export async function permissionHolders(
  tx: { collection: TenantTx['collection'] },
  permission: string,
  opts: { tenantId?: string; only?: string[] } = {},
): Promise<{ membershipId: string; scope: Scope; constraints: Record<string, unknown> }[]> {
  const t = opts.tenantId ? { tenant_id: opts.tenantId } : {};
  const disabled = new Set<string>((await tx.collection('tenant_access_controls').findOne({ ...t }))?.disabled_permissions ?? []);
  if (disabled.has(permission)) return [];
  const levels = new Map((await tx.collection('roles').find({ ...t, is_system: true, key: { $in: [...ACCESS_LEVEL_ROLES] } }, { projection: { key: 1 } })).map((r) => [r.id as string, r.key as string]));
  const perms = await tx.collection('role_permissions').find({ ...t, permission, role_id: { $in: [...levels.keys()] } }, { projection: { role_id: 1, scope: 1 } });
  const assignments = await tx.collection('role_assignments').find({ ...t, role_id: { $in: perms.map((p) => p.role_id) }, ...(opts.only ? { membership_id: { $in: opts.only } } : {}) });
  const active = new Set(await tx.collection('memberships').distinct<string>('id', { ...t, id: { $in: assignments.map((a) => a.membership_id) }, status: 'active' }));
  const seen = new Set<string>();
  const out: { membershipId: string; scope: Scope; constraints: Record<string, unknown> }[] = [];
  for (const a of assignments) {
    if (!active.has(a.membership_id)) continue;
    for (const p of perms.filter((x) => x.role_id === a.role_id)) {
      const scope = levels.get(a.role_id) === 'employee_workspace' ? (p.scope as Scope) : levelGrantScope(permission, p.scope as Scope, a.constraints);
      if (!scope) continue;
      const key = `${a.membership_id}:${scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ membershipId: a.membership_id as string, scope, constraints: (a.constraints ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

/** The distinct active members holding a permission (see permissionHolders). */
export async function permissionHolderIds(tx: { collection: TenantTx['collection'] }, permission: string, opts: { tenantId?: string; only?: string[] } = {}): Promise<string[]> {
  return [...new Set((await permissionHolders(tx, permission, opts)).map((h) => h.membershipId))];
}

import { Injectable } from '@nestjs/common';
import type { Scope } from '@crew/contracts';
import { requestContext } from '../context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../database/mongo.service';
import { Errors } from '../http/errors';
import { can, hasPermission, scopeFilter, type Grant, type ResourceAttributes, type Subject } from './policy';

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
  const assignments = await tx.collection('role_assignments').find({ membership_id: membershipId });
  const roleIds = [...new Set(assignments.map((a) => a.role_id as string))];
  const roles = new Map((await tx.collection('roles').find({ id: { $in: roleIds } })).map((r) => [r.id as string, r.key as string]));
  const permissions = await tx.collection('role_permissions').find({ role_id: { $in: roleIds } });
  const grants: Grant[] = [];
  for (const a of assignments) {
    for (const rp of permissions) {
      if (rp.role_id !== a.role_id || disabled.has(rp.permission)) continue;
      grants.push({ permission: rp.permission, scope: rp.scope as Scope, roleKey: roles.get(a.role_id)!, constraints: a.constraints ?? {} });
    }
  }

  const reports = await descendants(tx, 'memberships', 'manager_membership_id', membershipId);
  const reportEmployees = m.employee_id ? await descendants(tx, 'employees', 'current_manager_employee_id', m.employee_id) : new Set<string>();

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
  };
}

/** Everyone below `rootId` in a reporting tree, level by level (at most 50 levels, as the SQL version). */
async function descendants(tx: TenantTx, table: string, parentField: string, rootId: string): Promise<Set<string>> {
  const out = new Set<string>();
  let frontier = [rootId];
  for (let depth = 0; depth < 50 && frontier.length; depth++) {
    const next = (await tx.collection(table).find({ [parentField]: { $in: frontier } }, { projection: { _id: 1 } })).map((r) => r.id as string).filter((id) => !out.has(id) && id !== rootId);
    next.forEach((id) => out.add(id));
    frontier = next;
  }
  return out;
}

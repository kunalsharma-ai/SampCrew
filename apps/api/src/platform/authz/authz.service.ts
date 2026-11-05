import { Injectable } from '@nestjs/common';
import type { Scope } from '@crew/contracts';
import { requestContext } from '../context/request-context';
import { DatabaseService, many, one, type Tx } from '../database/database.service';
import { Errors } from '../http/errors';
import { can, hasPermission, scopePredicate, type Grant, type ResourceAttributes, type Subject } from './policy';

const SUBJECT_KEY = Symbol('authz.subject');

/** Loads the RBAC/ABAC subject for the current member (memoised per request) and answers authorisation questions. */
@Injectable()
export class AuthzService {
  constructor(private readonly db: DatabaseService) {}

  async subject(tx?: Tx): Promise<Subject> {
    const ctx = requestContext.get() as (ReturnType<typeof requestContext.get> & { [SUBJECT_KEY]?: Subject }) | undefined;
    if (ctx?.[SUBJECT_KEY]) return ctx[SUBJECT_KEY];
    const actor = requestContext.tenantActor();
    const load = (t: Tx) => loadSubject(t, actor.membershipId, actor.userId, actor.mfa);
    const subject = tx ? await load(tx) : await this.db.tenant(load);
    if (ctx) ctx[SUBJECT_KEY] = subject;
    return subject;
  }

  async require(permission: string, resource?: ResourceAttributes, tx?: Tx): Promise<Grant> {
    const s = await this.subject(tx);
    const d = resource ? can(s, permission, resource) : hasPermission(s, permission);
    if (d.allowed) return d.via;
    if (d.reason === 'mfa_required') throw Errors.mfaRequired();
    if (d.reason === 'out_of_scope') throw Errors.notFound();
    throw Errors.forbidden();
  }

  async predicate(permission: string, cols: Parameters<typeof scopePredicate>[2], params: unknown[], tx?: Tx): Promise<string> {
    const s = await this.subject(tx);
    return scopePredicate(s, permission, cols, params) ?? 'false';
  }
}

export async function loadSubject(tx: Tx, membershipId: string, userId: string, mfa: boolean): Promise<Subject> {
  const m = await one<{ legal_entity_id: string | null; department_id: string | null; location_id: string | null }>(
    tx,
    `select legal_entity_id, department_id, location_id from memberships where id = $1 and status = 'active'`,
    [membershipId],
  );
  if (!m) throw Errors.forbidden('Your membership in this workspace is not active');

  const grants = await many<{ permission: string; scope: Scope; role_key: string; constraints: Grant['constraints'] }>(
    tx,
    `select rp.permission, rp.scope, r.key as role_key, ra.constraints
       from role_assignments ra
       join roles r on r.id = ra.role_id
       join role_permissions rp on rp.role_id = r.id
      where ra.membership_id = $1`,
    [membershipId],
  );

  const reports = await many<{ id: string }>(
    tx,
    `with recursive team(id, depth) as (
       select id, 1 from memberships where manager_membership_id = $1
       union all
       select m.id, t.depth + 1 from memberships m join team t on m.manager_membership_id = t.id where t.depth < 50
     ) select distinct id from team`,
    [membershipId],
  );

  const departments = await many<{ id: string; parent_id: string | null }>(tx, 'select id, parent_id from departments');
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
    legalEntityId: m.legal_entity_id,
    departmentId: m.department_id,
    locationId: m.location_id,
    reportIds: new Set(reports.map((r) => r.id)),
    ownDepartmentSubtree: m.department_id ? departmentSubtree([m.department_id]) : new Set(),
    departmentSubtree,
    grants: grants.map((g) => ({ permission: g.permission, scope: g.scope, roleKey: g.role_key, constraints: g.constraints ?? {} })),
    mfa,
  };
}

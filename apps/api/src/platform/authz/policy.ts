import { getPermission, SCOPE_RANK, type Scope } from '@crew/contracts';

/**
 * Pure RBAC + ABAC policy engine. No I/O: the subject is loaded once per request (AuthzService) and the
 * engine decides from attributes alone, which keeps it fast and exhaustively unit-testable.
 */

export interface GrantConstraints {
  legalEntityIds?: string[];
  departmentIds?: string[];
  locationIds?: string[];
}

export interface Grant {
  permission: string;
  scope: Scope;
  roleKey: string;
  constraints: GrantConstraints;
}

export interface Subject {
  userId: string;
  membershipId: string;
  legalEntityId: string | null;
  departmentId: string | null;
  locationId: string | null;
  /** Everyone reporting to the subject, directly or indirectly (not including the subject). */
  reportIds: ReadonlySet<string>;
  /** Department subtree rooted at the subject's own department. */
  ownDepartmentSubtree: ReadonlySet<string>;
  /** Expands a set of department ids to include all descendants. */
  departmentSubtree: (ids: string[]) => ReadonlySet<string>;
  grants: Grant[];
  mfa: boolean;
}

/** Attributes of the record being accessed. */
export interface ResourceAttributes {
  membershipId?: string | null;
  legalEntityId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
}

export type Decision = { allowed: true; via: Grant } | { allowed: false; reason: 'no_grant' | 'mfa_required' | 'out_of_scope' };

function withinConstraints(subject: Subject, c: GrantConstraints, r: ResourceAttributes): boolean {
  if (c.legalEntityIds?.length && !(r.legalEntityId && c.legalEntityIds.includes(r.legalEntityId))) return false;
  if (c.departmentIds?.length && !(r.departmentId && subject.departmentSubtree(c.departmentIds).has(r.departmentId))) return false;
  if (c.locationIds?.length && !(r.locationId && c.locationIds.includes(r.locationId))) return false;
  return true;
}

export function grantCovers(subject: Subject, grant: Grant, r: ResourceAttributes): boolean {
  if (!withinConstraints(subject, grant.constraints, r)) return false;
  switch (grant.scope) {
    case 'tenant':
      return true;
    case 'entity':
      // With an entity constraint the assignment names the entities; otherwise the subject's own entity applies.
      return grant.constraints.legalEntityIds?.length ? true : !!r.legalEntityId && r.legalEntityId === subject.legalEntityId;
    case 'department':
      return grant.constraints.departmentIds?.length ? true : !!r.departmentId && subject.ownDepartmentSubtree.has(r.departmentId);
    case 'team':
      return !!r.membershipId && (r.membershipId === subject.membershipId || subject.reportIds.has(r.membershipId));
    case 'own':
      return !!r.membershipId && r.membershipId === subject.membershipId;
  }
}

export function grantsFor(subject: Subject, permission: string): Grant[] {
  return subject.grants.filter((g) => g.permission === permission);
}

/** Does the subject hold the permission at all (any scope)? Used for route-level checks. */
export function hasPermission(subject: Subject, permission: string): Decision {
  const grants = grantsFor(subject, permission);
  if (!grants.length) return { allowed: false, reason: 'no_grant' };
  if (getPermission(permission)?.requiresMfa && !subject.mfa) return { allowed: false, reason: 'mfa_required' };
  const widest = [...grants].sort((a, b) => SCOPE_RANK[b.scope] - SCOPE_RANK[a.scope])[0]!;
  return { allowed: true, via: widest };
}

/** Can the subject perform `permission` on this specific record? */
export function can(subject: Subject, permission: string, resource: ResourceAttributes): Decision {
  const base = hasPermission(subject, permission);
  if (!base.allowed) return base;
  const grant = grantsFor(subject, permission).find((g) => grantCovers(subject, g, resource));
  return grant ? { allowed: true, via: grant } : { allowed: false, reason: 'out_of_scope' };
}

/** Effective permission map for UIs: permission -> widest scope held. */
export function effectivePermissions(subject: Subject): Record<string, Scope> {
  const out: Record<string, Scope> = {};
  for (const g of subject.grants) {
    const prev = out[g.permission];
    if (!prev || SCOPE_RANK[g.scope] > SCOPE_RANK[prev]) out[g.permission] = g.scope;
  }
  return out;
}

/**
 * Translates the subject's grants for a permission into a SQL predicate over a table that exposes
 * membership/department/entity/location columns, so list endpoints filter in the database rather than
 * loading everything and filtering in memory. Returns null when the subject has no grant.
 */
export function scopePredicate(
  subject: Subject,
  permission: string,
  cols: { membershipId: string; legalEntityId: string; departmentId: string; locationId: string },
  params: unknown[],
): string | null {
  const grants = grantsFor(subject, permission);
  if (!grants.length) return null;
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const clauses = grants.map((g) => {
    const parts: string[] = [];
    const c = g.constraints;
    if (c.legalEntityIds?.length) parts.push(`${cols.legalEntityId} = any(${p(c.legalEntityIds)}::uuid[])`);
    if (c.departmentIds?.length) parts.push(`${cols.departmentId} = any(${p([...subject.departmentSubtree(c.departmentIds)])}::uuid[])`);
    if (c.locationIds?.length) parts.push(`${cols.locationId} = any(${p(c.locationIds)}::uuid[])`);
    switch (g.scope) {
      case 'tenant':
        break;
      case 'entity':
        if (!c.legalEntityIds?.length) parts.push(subject.legalEntityId ? `${cols.legalEntityId} = ${p(subject.legalEntityId)}::uuid` : 'false');
        break;
      case 'department':
        if (!c.departmentIds?.length) parts.push(`${cols.departmentId} = any(${p([...subject.ownDepartmentSubtree])}::uuid[])`);
        break;
      case 'team':
        parts.push(`${cols.membershipId} = any(${p([subject.membershipId, ...subject.reportIds])}::uuid[])`);
        break;
      case 'own':
        parts.push(`${cols.membershipId} = ${p(subject.membershipId)}::uuid`);
        break;
    }
    return parts.length ? `(${parts.join(' and ')})` : 'true';
  });
  return `(${clauses.join(' or ')})`;
}

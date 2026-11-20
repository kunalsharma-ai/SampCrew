import { ACCESS_AREAS, ACCESS_LEVEL_LABEL, ACCESS_LEVEL_ROLES, LEVEL_ROLE_KEY, mapLegacyAccess, SYSTEM_ROLES, type LegacyAssignment, type LevelConstraints, type MemberAccess, type Scope, type SetAccessRequest } from '@crew/contracts';
import type { TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

const LEVEL_OF: Record<string, MemberAccess['level']> = { super_workspace: 'super', hr_workspace: 'hr', employee_workspace: 'employee' };

/** The level roles of the workspace by key (Super, HR and Employee Workspace). */
export async function levelRoles(tx: TenantTx): Promise<Map<string, string>> {
  const rows = await tx.collection('roles').find({ is_system: true, key: { $in: [...ACCESS_LEVEL_ROLES] } }, { projection: { key: 1 } });
  return new Map(rows.map((r) => [r.key as string, r.id as string]));
}

/** Each person's workspace access as the screens show it: their highest level and its limits. */
export async function memberAccess(tx: TenantTx, membershipIds: string[]): Promise<Map<string, MemberAccess>> {
  const ids = await levelRoles(tx);
  const keyOf = new Map([...ids].map(([k, id]) => [id, k]));
  const rows = await tx.collection('role_assignments').find({ membership_id: { $in: membershipIds }, role_id: { $in: [...ids.values()] } });
  const hrIds = [...new Set(rows.flatMap((r) => (r.constraints?.hrWorkspaceIds ?? []) as string[]))];
  const hrNames = new Map((await tx.collection('hr_workspaces').find({ id: { $in: hrIds } }, { projection: { name: 1 } })).map((w) => [w.id as string, w.name as string]));
  const out = new Map<string, MemberAccess>();
  for (const id of membershipIds) {
    const mine = rows.filter((r) => r.membership_id === id);
    const top = mine.find((r) => keyOf.get(r.role_id) === 'super_workspace') ?? mine.find((r) => keyOf.get(r.role_id) === 'hr_workspace');
    const level = top ? LEVEL_OF[keyOf.get(top.role_id)!]! : 'employee';
    const c = (top?.constraints ?? {}) as LevelConstraints;
    out.set(id, {
      level,
      label: ACCESS_LEVEL_LABEL[LEVEL_ROLE_KEY[level]],
      hrWorkspaces: (c.hrWorkspaceIds ?? []).map((w) => ({ id: w, name: hrNames.get(w) ?? 'Archived HR Workspace' })),
      legalEntityIds: c.legalEntityIds ?? [],
      departmentIds: c.departmentIds ?? [],
      areas: c.areas ?? [],
      viewAreas: c.viewAreas ?? [],
      auditTrail: Boolean(c.auditTrail),
      fromGroup: top?.source === 'scim',
    });
  }
  return out;
}

/** The limits saved on the level assignment, checked against what exists in the workspace. */
export async function accessConstraints(tx: TenantTx, input: SetAccessRequest): Promise<LevelConstraints> {
  if (input.level === 'employee') return {};
  const c: LevelConstraints = {};
  const unknownArea = [...(input.areas ?? []), ...(input.viewAreas ?? [])].find((a) => !ACCESS_AREAS.includes(a));
  if (unknownArea) throw Errors.validation([{ path: 'areas', message: `There is no area called ${unknownArea}` }]);
  if (input.areas?.length) c.areas = ACCESS_AREAS.filter((a) => input.areas!.includes(a));
  const view = (input.viewAreas ?? []).filter((a) => !c.areas?.includes(a));
  if (view.length) c.viewAreas = ACCESS_AREAS.filter((a) => view.includes(a));
  if (input.auditTrail && (c.areas || c.viewAreas)) c.auditTrail = true;
  if (input.level === 'super') return c;
  const check = async (table: string, list: string[] | undefined, what: string, extra: Row = {}) => {
    if (!list?.length) return undefined;
    const found = await tx.collection(table).count({ id: { $in: list }, ...extra });
    if (found !== new Set(list).size) throw Errors.badRequest('unknown_scope', `Choose ${what} that exist in the workspace`);
    return [...new Set(list)];
  };
  const hr = await check('hr_workspaces', input.hrWorkspaceIds, 'active HR Workspaces', { status: 'active' });
  const entities = await check('legal_entities', input.legalEntityIds, 'legal entities');
  const departments = await check('departments', input.departmentIds, 'departments');
  if (hr) c.hrWorkspaceIds = hr;
  if (entities) c.legalEntityIds = entities;
  if (departments) c.departmentIds = departments;
  return c;
}

/**
 * The access a list of role keys stands for (the API before the four access levels took role keys): the same mapping
 * the database migration used, with each built-in role's template and each custom role's own permissions.
 */
export async function accessFromRoleKeys(
  tx: TenantTx,
  assignments: { roleKey: string; constraints?: Record<string, unknown> }[],
  member: { legalEntityId: string | null; departmentId: string | null },
): Promise<SetAccessRequest> {
  const keys = [...new Set(assignments.map((a) => a.roleKey))];
  const roles = await tx.collection('roles').find({ key: { $in: keys } });
  const missing = keys.filter((k) => !roles.some((r) => r.key === k));
  if (missing.length) throw Errors.badRequest('unknown_role', `Unknown role: ${missing.join(', ')}`);
  const custom = roles.filter((r) => !r.is_system);
  const customGrants = custom.length ? await tx.collection('role_permissions').find({ role_id: { $in: custom.map((r) => r.id) } }) : [];
  const legacy: LegacyAssignment[] = assignments.map((a) => {
    const role = roles.find((r) => r.key === a.roleKey)!;
    const template = role.is_system ? SYSTEM_ROLES.find((t) => t.key === a.roleKey) : undefined;
    const grants = template
      ? Object.entries(template.grants).map(([permission, scope]) => ({ permission, scope: scope as Scope }))
      : customGrants.filter((g) => g.role_id === role.id).map((g) => ({ permission: g.permission as string, scope: g.scope as Scope }));
    return { key: a.roleKey, isSystem: Boolean(role.is_system), grants, constraints: a.constraints ?? {} };
  });
  const m = mapLegacyAccess(legacy, member);
  return { level: m.level, ...(m.constraints as Omit<SetAccessRequest, 'level'>) };
}

/**
 * Writes a person's access: Employee Workspace always, plus the Super or HR Workspace assignment. Access a provisioning
 * group (SCIM) gives stays: the identity provider manages it.
 */
export async function writeAccess(tx: TenantTx, membershipId: string, level: MemberAccess['level'], constraints: LevelConstraints, grantedBy: string | null) {
  const ids = await levelRoles(tx);
  await tx.collection('role_assignments').delete({ membership_id: membershipId, role_id: { $in: [ids.get('super_workspace'), ids.get('hr_workspace')] }, source: { $ne: 'scim' } });
  const base = ids.get('employee_workspace')!;
  if (!(await tx.collection('role_assignments').exists({ membership_id: membershipId, role_id: base }))) {
    await tx.collection('role_assignments').insert({ membership_id: membershipId, role_id: base, constraints: {}, granted_by: grantedBy });
  }
  if (level === 'employee') return;
  const roleId = ids.get(LEVEL_ROLE_KEY[level])!;
  if (await tx.collection('role_assignments').exists({ membership_id: membershipId, role_id: roleId, source: 'scim' })) {
    throw Errors.conflict('access_from_group', `This person already has ${ACCESS_LEVEL_LABEL[LEVEL_ROLE_KEY[level]]} access from a provisioning group, which your identity provider manages. Change it there, or take them out of the group first.`);
  }
  const fields = { constraints, granted_by: grantedBy, source: 'manual' };
  await tx.collection('role_assignments').upsert({ membership_id: membershipId, role_id: roleId }, { membership_id: membershipId, role_id: roleId, ...fields }, { $set: fields });
}

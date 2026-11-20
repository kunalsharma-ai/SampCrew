import { ACCESS_LEVEL_ROLES, LEVEL_ROLE_KEY, levelRoleKeyFor, mapLegacyAccess, type LegacyAssignment, type LevelConstraints, type Scope } from '@crew/contracts';
import type { Row } from './table';
import type { Tables } from './provision';

const LEVEL_KEYS = new Set<string>(ACCESS_LEVEL_ROLES);

export interface AccessLevelMigrationResult {
  tenants: number;
  people: number;
  settings: number;
}

/**
 * Moves every workspace from the old built-in (and custom) roles to the four access levels, keeping each person's
 * access as it was and no wider (mapLegacyAccess in packages/contracts/src/roles.ts):
 *  - each person ends up with Employee Workspace, plus Super Workspace or HR Workspace with the limits that keep
 *    their old reach (legal entities, departments, HR Workspaces) and the areas their roles covered;
 *  - approval chains, pending approval steps, custom field rules and provisioning groups that named an old role
 *    name the level it became;
 *  - every change is written to access_level_migrations with what it was before, so it can be rolled back
 *    (rollbackAccessLevelsMongo). The old roles stay in the database, unassigned: they are not shown and give no
 *    access. Nothing about the person (profile, employee record, history) is touched.
 * People already on the levels are skipped, so it is safe on every deploy and finishes a half-done run.
 */
export async function applyAccessLevelsMongo(tx: Tables): Promise<AccessLevelMigrationResult> {
  const out: AccessLevelMigrationResult = { tenants: 0, people: 0, settings: 0 };
  const tenants = await tx.collection('tenants').find({}, { projection: { _id: 1 } });
  for (const tenant of tenants) {
    const tenantId = tenant.id as string;
    const t = (name: string) => tx.collection(name);
    const roles = await t('roles').find({ tenant_id: tenantId });
    const byId = new Map(roles.map((r) => [r.id as string, r]));
    const levelId = new Map(roles.filter((r) => r.is_system && LEVEL_KEYS.has(r.key as string)).map((r) => [r.key as string, r.id as string]));
    if (levelId.size !== LEVEL_KEYS.size) continue; // syncSystemRolesMongo runs first and creates them
    const legacyRoleIds = roles.filter((r) => !(r.is_system && LEVEL_KEYS.has(r.key as string))).map((r) => r.id as string);
    const grantsOf = new Map<string, { permission: string; scope: Scope }[]>();
    for (const rp of await t('role_permissions').find({ tenant_id: tenantId, role_id: { $in: legacyRoleIds } })) {
      const list = grantsOf.get(rp.role_id as string) ?? [];
      list.push({ permission: rp.permission as string, scope: rp.scope as Scope });
      grantsOf.set(rp.role_id as string, list);
    }
    const asLegacy = (a: Row): LegacyAssignment => {
      const r = byId.get(a.role_id as string);
      return { key: (r?.key as string) ?? 'employee', isSystem: Boolean(r?.is_system), grants: grantsOf.get(a.role_id as string) ?? [], constraints: (a.constraints ?? {}) as Record<string, unknown> };
    };
    // The level a stored role key now means, for custom roles by what they hold.
    const keyFor = (key: string): string => {
      const custom = roles.find((r) => r.key === key && !r.is_system);
      if (!custom) return levelRoleKeyFor(key);
      return LEVEL_ROLE_KEY[mapLegacyAccess([{ key, isSystem: false, grants: grantsOf.get(custom.id as string) ?? [] }], { legalEntityId: null, departmentId: null }).level];
    };
    let changed = false;

    const memberships = await t('memberships').find({ tenant_id: tenantId }, { projection: { _id: 1, legal_entity_id: 1, department_id: 1 } });
    const assignments = await t('role_assignments').find({ tenant_id: tenantId });
    const byMember = new Map<string, Row[]>();
    for (const a of assignments) byMember.set(a.membership_id as string, [...(byMember.get(a.membership_id as string) ?? []), a]);
    for (const m of memberships) {
      const mine = byMember.get(m.id as string) ?? [];
      const legacy = mine.filter((a) => !LEVEL_KEYS.has((byId.get(a.role_id as string)?.key as string) ?? '') || !byId.get(a.role_id as string)?.is_system);
      const hasBase = mine.some((a) => a.role_id === levelId.get('employee_workspace'));
      if (!legacy.length && hasBase) continue;
      const mapping = mapLegacyAccess(mine.map(asLegacy), { legalEntityId: (m.legal_entity_id as string) ?? null, departmentId: (m.department_id as string) ?? null });
      const levelKey = LEVEL_ROLE_KEY[mapping.level];
      const top = legacy.filter((a) => keyFor((byId.get(a.role_id as string)?.key as string) ?? 'employee') === levelKey);
      const source = mapping.level === 'employee' ? 'manual' : top.length && top.every((a) => a.source === 'scim') ? 'scim' : top.length && top.every((a) => a.source === 'hr_workspace') ? 'hr_workspace' : 'manual';
      await t('access_level_migrations').insert({
        tenant_id: tenantId, kind: 'membership', subject_id: m.id,
        before: { assignments: legacy.map((a) => ({ ...a, role_key: byId.get(a.role_id as string)?.key ?? null, role_name: byId.get(a.role_id as string)?.name ?? null })) },
        after: { level: mapping.level, constraints: mapping.constraints, source },
        notes: mapping.notes,
      });
      if (legacy.length) await t('role_assignments').delete({ id: { $in: legacy.map((a) => a.id) } });
      if (!hasBase) await t('role_assignments').insert({ tenant_id: tenantId, membership_id: m.id, role_id: levelId.get('employee_workspace'), constraints: {}, source: 'manual' });
      if (mapping.level !== 'employee' && !mine.some((a) => a.role_id === levelId.get(levelKey))) {
        const by = top.find((a) => a.granted_by)?.granted_by ?? null;
        await t('role_assignments').insert({ tenant_id: tenantId, membership_id: m.id, role_id: levelId.get(levelKey), constraints: mapping.constraints as Row, source, granted_by: by });
      }
      out.people++;
      changed = true;
    }

    // Approval chains and steps still waiting for someone in an old role.
    const mapSteps = (steps: { type: string; role?: string }[]) => steps.map((s) => (s.type === 'role' && s.role ? { ...s, role: keyFor(s.role) } : s));
    for (const p of await t('approval_policies').find({ tenant_id: tenantId })) {
      const steps = (p.steps ?? []) as { type: string; role?: string }[];
      const next = mapSteps(steps);
      if (JSON.stringify(next) === JSON.stringify(steps)) continue;
      await t('access_level_migrations').insert({ tenant_id: tenantId, kind: 'approval_policy', subject_id: p.id, before: { steps }, after: { steps: next }, notes: [] });
      await t('approval_policies').updateOne({ id: p.id }, { $set: { steps: next } });
      out.settings++;
      changed = true;
    }
    for (const st of await t('approval_steps').find({ tenant_id: tenantId, status: { $in: ['pending', 'waiting'] }, approver_role_key: { $ne: null } })) {
      const key = keyFor(st.approver_role_key as string);
      if (key === st.approver_role_key) continue;
      await t('access_level_migrations').insert({ tenant_id: tenantId, kind: 'approval_step', subject_id: st.id, before: { approver_role_key: st.approver_role_key }, after: { approver_role_key: key }, notes: [] });
      await t('approval_steps').updateOne({ id: st.id }, { $set: { approver_role_key: key } });
      out.settings++;
      changed = true;
    }
    // Custom fields shown or editable only for some roles.
    for (const f of await t('custom_fields').find({ tenant_id: tenantId, $or: [{ 'view_roles.0': { $exists: true } }, { 'edit_roles.0': { $exists: true } }] })) {
      const view = [...new Set(((f.view_roles ?? []) as string[]).map(keyFor))].sort();
      const edit = [...new Set(((f.edit_roles ?? []) as string[]).map(keyFor))].sort();
      if (JSON.stringify(view) === JSON.stringify(f.view_roles) && JSON.stringify(edit) === JSON.stringify(f.edit_roles)) continue;
      await t('access_level_migrations').insert({ tenant_id: tenantId, kind: 'custom_field', subject_id: f.id, before: { view_roles: f.view_roles, edit_roles: f.edit_roles }, after: { view_roles: view, edit_roles: edit }, notes: [] });
      await t('custom_fields').updateOne({ id: f.id }, { $set: { view_roles: view, edit_roles: edit } });
      out.settings++;
      changed = true;
    }
    // Provisioning groups (SCIM) that gave an old role give its level, limited the same way.
    for (const g of await t('scim_groups').find({ tenant_id: tenantId, role_id: { $in: legacyRoleIds } })) {
      const role = byId.get(g.role_id as string)!;
      const mapping = mapLegacyAccess([{ key: role.key as string, isSystem: Boolean(role.is_system), grants: grantsOf.get(role.id as string) ?? [] }], { legalEntityId: null, departmentId: null });
      // A group never gives Super Workspace (only a Super Workspace person can): such a group gives nothing more.
      const levelKey = mapping.level === 'super' ? null : LEVEL_ROLE_KEY[mapping.level];
      const constraints: LevelConstraints = mapping.level === 'hr' ? mapping.constraints : {};
      await t('access_level_migrations').insert({
        tenant_id: tenantId, kind: 'scim_group', subject_id: g.id, before: { role_id: g.role_id, role_key: role.key, constraints: g.constraints ?? {} }, after: { role_key: levelKey, constraints },
        notes: mapping.level === 'super' ? [`${role.key} is Super Workspace, which a provisioning group cannot give`] : [],
      });
      await t('scim_groups').updateOne({ id: g.id }, { $set: { role_id: levelKey ? levelId.get(levelKey) : null, constraints } });
      out.settings++;
      changed = true;
    }
    if (changed) out.tenants++;
  }
  return out;
}

/**
 * Puts a workspace back on the roles it had before applyAccessLevelsMongo, from access_level_migrations: the old
 * assignments come back and the level assignments the migration added are removed. Changes made on the new levels
 * since then are kept where they do not clash. For an emergency only: run it with the API stopped, then deploy the
 * release before the four access levels.
 */
export async function rollbackAccessLevelsMongo(tx: Tables, tenantId: string): Promise<{ restored: number }> {
  const t = (name: string) => tx.collection(name);
  let restored = 0;
  const rows = await t('access_level_migrations').find({ tenant_id: tenantId, rolled_back_at: null }, { sort: { created_at: -1 } });
  const levelIds = new Map((await t('roles').find({ tenant_id: tenantId, is_system: true, key: { $in: [...LEVEL_KEYS] } })).map((r) => [r.key as string, r.id as string]));
  for (const r of rows) {
    if (r.kind === 'membership') {
      const before = ((r.before?.assignments ?? []) as Row[]).map(({ role_key: _k, role_name: _n, ...a }) => a);
      await t('role_assignments').delete({ membership_id: r.subject_id, role_id: { $in: [...levelIds.values()] } });
      for (const a of before) if (!(await t('role_assignments').exists({ membership_id: r.subject_id, role_id: a.role_id }))) await t('role_assignments').insert(a);
    } else if (r.kind === 'approval_policy') await t('approval_policies').updateOne({ id: r.subject_id }, { $set: { steps: r.before.steps } });
    else if (r.kind === 'approval_step') await t('approval_steps').updateOne({ id: r.subject_id }, { $set: { approver_role_key: r.before.approver_role_key } });
    else if (r.kind === 'custom_field') await t('custom_fields').updateOne({ id: r.subject_id }, { $set: { view_roles: r.before.view_roles, edit_roles: r.before.edit_roles } });
    else if (r.kind === 'scim_group') await t('scim_groups').updateOne({ id: r.subject_id }, { $set: { role_id: r.before.role_id, constraints: r.before.constraints ?? {} } });
    await t('access_level_migrations').updateOne({ id: r.id }, { $set: { rolled_back_at: new Date() } });
    restored++;
  }
  return { restored };
}

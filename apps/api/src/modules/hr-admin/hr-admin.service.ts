import { Injectable } from '@nestjs/common';
import {
  BOOLEAN_FEATURES,
  getPermission,
  isCoreFeature,
  isPlannedFeature,
  LOCKED_ROLE_KEYS,
  PERMISSION_ACTION_LABEL,
  PERMISSION_ACTIONS,
  PERMISSION_MODULE_FEATURE,
  permissionAction,
  PERMISSIONS,
  type roleGrantsInput,
  type Scope,
  SYSTEM_ROLES,
  ACCESS_LEVEL_ROLES,
  type workspaceModulesInput,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { validateGrants } from '../roles/roles.service';

/**
 * HR Workspace Admin: module access, the role and permission matrix, and the way to every module's settings.
 * Nothing here hands out access on its own: grants change only when an administrator saves them, and each save is audited.
 */
@Injectable()
export class HrAdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  /** The modules the plan includes, and whether this workspace has switched each one on. */
  modules() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('tenant:read', undefined, tx);
      return this.moduleRows(tx);
    });
  }

  private async moduleRows(tx: TenantTx) {
    const e = await loadEntitlements(tx);
    const off = new Set<string>(((await tx.collection('workspace_modules').findOne({ key: 'workspace' }))?.disabled_features ?? []) as string[]);
    return BOOLEAN_FEATURES.filter((f) => !isPlannedFeature(f.key)).map((f) => {
      const core = isCoreFeature(f.key);
      const inPlan = e.features.has(f.key) || e.blocked[f.key] === 'admin_off';
      const reason = e.blocked[f.key];
      return {
        key: f.key as string,
        name: f.name as string,
        module: f.module as string,
        core,
        inPlan,
        enabled: inPlan && !off.has(f.key),
        switchedOffByAdmin: off.has(f.key),
        /** Why the module is unavailable when it is not the workspace's own choice. */
        blockedBy: reason && reason !== 'admin_off' ? reason : inPlan ? null : 'not_in_plan',
      };
    });
  }

  async setModules(input: z.infer<typeof workspaceModulesInput>) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('modules:manage', undefined, tx);
      const row = await tx.collection('workspace_modules').findOne({ key: 'workspace' });
      const off = new Set<string>((row?.disabled_features ?? []) as string[]);
      const before = [...off].sort();
      for (const c of input.changes) {
        if (isCoreFeature(c.key)) throw Errors.badRequest('core_module', 'Core modules are always on');
        if (c.enabled) off.delete(c.key);
        else off.add(c.key);
      }
      const after = [...off].sort();
      await tx.collection('workspace_modules').upsert({ key: 'workspace' }, { key: 'workspace', disabled_features: after }, { $set: { disabled_features: after } });
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await this.audit.record(tx, { action: 'workspace.modules_changed', resourceType: 'workspace_modules', resourceId: null, changes: { switchedOff: { from: before, to: after } } });
      }
      return this.moduleRows(tx);
    });
  }

  /** Every role against every permission, grouped by module and the seven actions. */
  matrix() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('roles:read', undefined, tx);
      const e = await loadEntitlements(tx);
      const disabled = new Set<string>(((await tx.collection('tenant_access_controls').findOne({}))?.disabled_permissions ?? []) as string[]);
      // What each access level can do in this company. Old roles kept for rollback are not shown.
      const order = ACCESS_LEVEL_ROLES as readonly string[];
      const roles = (await tx.collection('roles').find({ is_system: true, key: { $in: [...ACCESS_LEVEL_ROLES] } })).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
      const ids = roles.map((r) => r.id as string);
      const counts = await countBy(tx, 'role_assignments', 'role_id', ids);
      const grants = new Map<string, Record<string, Scope>>();
      for (const rp of await tx.collection('role_permissions').find({ role_id: { $in: ids } })) {
        grants.set(rp.role_id, { ...(grants.get(rp.role_id) ?? {}), [rp.permission]: rp.scope });
      }
      const templates = new Map(SYSTEM_ROLES.map((t) => [t.key, t]));
      const modules = new Map<string, { module: string; feature: string | null; available: boolean; permissions: unknown[] }>();
      for (const p of PERMISSIONS) {
        const feature = PERMISSION_MODULE_FEATURE[p.module] ?? null;
        const m = modules.get(p.module) ?? { module: p.module, feature, available: !feature || e.features.has(feature), permissions: [] };
        m.permissions.push({
          key: p.key,
          description: p.description,
          action: permissionAction(p),
          scopes: p.scopes,
          requiresMfa: 'requiresMfa' in p && p.requiresMfa === true,
          sensitive: 'sensitive' in p && p.sensitive === true,
          disabledBySampledge: disabled.has(p.key),
        });
        modules.set(p.module, m);
      }
      return {
        actions: PERMISSION_ACTIONS.map((a) => ({ key: a, label: PERMISSION_ACTION_LABEL[a] })),
        modules: [...modules.values()],
        roles: roles.map((r) => {
          const tpl = r.is_system ? templates.get(r.key) : undefined;
          return {
            id: r.id as string,
            key: r.key as string,
            name: r.name as string,
            description: (r.description as string | null) ?? null,
            isSystem: Boolean(r.is_system),
            locked: LOCKED_ROLE_KEYS.has(r.key),
            customised: Boolean(r.customised_at),
            canReset: Boolean(tpl) && !LOCKED_ROLE_KEYS.has(r.key),
            memberCount: counts.get(r.id) ?? 0,
            grants: grants.get(r.id) ?? {},
          };
        }),
      };
    });
  }

  /** Replace a role's grants. System roles can be changed too (not Workspace Owner) and reset to their defaults later. */
  async setRoleGrants(roleId: string, input: z.infer<typeof roleGrantsInput>) {
    validateGrants(input.grants);
    return this.db.tenant(async (tx) => {
      await this.authz.require('roles:manage', undefined, tx);
      const role = await tx.collection('roles').findOne({ id: roleId, is_system: true, key: { $in: [...ACCESS_LEVEL_ROLES] } });
      if (!role) throw Errors.notFound('Access level');
      if (LOCKED_ROLE_KEYS.has(role.key)) throw Errors.badRequest('role_locked', `${role.name} always has every permission and cannot be changed`);
      const before = await this.grantsOf(tx, roleId);
      const after = Object.fromEntries(input.grants.map((g) => [g.permission, g.scope]));
      await tx.collection('role_permissions').delete({ role_id: roleId });
      if (input.grants.length) await tx.collection('role_permissions').insertMany(input.grants.map((g) => ({ role_id: roleId, permission: g.permission, scope: g.scope })));
      if (role.is_system) await tx.collection('roles').updateOne({ id: roleId }, { $set: { customised_at: new Date() } });
      await this.audit.record(tx, { action: 'role.permissions_changed', resourceType: 'role', resourceId: roleId, changes: diffGrants(before, after), metadata: { role: role.key } });
      return { id: roleId, grants: after };
    });
  }

  /** Put a system role back to the permissions SampCrew ships it with. */
  async resetRole(roleId: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('roles:manage', undefined, tx);
      const role = await tx.collection('roles').findOne({ id: roleId });
      if (!role) throw Errors.notFound('Role');
      const tpl = role.is_system ? SYSTEM_ROLES.find((t) => t.key === role.key) : undefined;
      if (!tpl) throw Errors.badRequest('not_system_role', 'Only built-in roles have defaults to go back to');
      if (LOCKED_ROLE_KEYS.has(role.key)) throw Errors.badRequest('role_locked', `${role.name} cannot be changed`);
      const before = await this.grantsOf(tx, roleId);
      const after = Object.fromEntries(Object.entries(tpl.grants).filter(([k]) => getPermission(k))) as Record<string, Scope>;
      await tx.collection('role_permissions').delete({ role_id: roleId });
      const rows = Object.entries(after).map(([permission, scope]) => ({ role_id: roleId, permission, scope }));
      if (rows.length) await tx.collection('role_permissions').insertMany(rows);
      await tx.collection('roles').updateOne({ id: roleId }, { $set: { customised_at: null, template_grants: Object.keys(after).sort() } });
      await this.audit.record(tx, { action: 'role.permissions_reset', resourceType: 'role', resourceId: roleId, changes: diffGrants(before, after), metadata: { role: role.key } });
      return { id: roleId, grants: after };
    });
  }

  private async grantsOf(tx: TenantTx, roleId: string) {
    return Object.fromEntries((await tx.collection('role_permissions').find({ role_id: roleId })).map((g) => [g.permission as string, g.scope as Scope]));
  }
}

function diffGrants(before: Record<string, string>, after: Record<string, string>) {
  const added: Record<string, string> = {};
  const removed: Record<string, string> = {};
  const changed: Record<string, { from: string; to: string }> = {};
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added[k] = v;
    else if (before[k] !== v) changed[k] = { from: before[k]!, to: v };
  }
  for (const [k, v] of Object.entries(before)) if (!(k in after)) removed[k] = v;
  return { added, removed, changed };
}

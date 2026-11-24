import { Injectable } from '@nestjs/common';
import {
  CENTRAL_GROUP, PERMISSION_TEMPLATE_KEYS, PERMISSION_TEMPLATE_LABEL, templatePermissions, workspacePermissionCategories, workspacePermissionItems,
  workspacePermissionOn, type HrWorkspaceTemplateChoice, type PermissionTemplateKey, type WorkspacePermissionLevel, type WorkspacePermissionsInput,
  type WorkspacePermissionsView,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { hasPermission, type Subject } from '../../platform/authz/policy';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';

const SUBJECT: Record<WorkspacePermissionLevel, string> = { hr: 'hr_workspace', employee: 'employee_workspace' };
const TEMPLATE_SUBJECT: Record<'hr_default' | 'employee_default', { type: string; level: WorkspacePermissionLevel }> = {
  hr_default: { type: 'hr_template', level: 'hr' }, employee_default: { type: 'employee_template', level: 'employee' },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Only the registry's switches (never unknown keys) with booleans. Locked switches are never saved. */
function clean(level: WorkspacePermissionLevel, input: Record<string, boolean>): Record<string, boolean> {
  const items = workspacePermissionItems(level);
  const unknown = Object.keys(input).filter((k) => !items.some((i) => i.key === k));
  if (unknown.length) throw Errors.badRequest('unknown_permission', `Not a ${level === 'hr' ? 'HR Workspace' : 'Employee Workspace'} permission: ${unknown.slice(0, 5).join(', ')}`);
  const locked = Object.keys(input).filter((k) => items.find((i) => i.key === k)?.locked && input[k] !== items.find((i) => i.key === k)!.default);
  if (locked.length) throw Errors.badRequest('permission_locked', 'That permission follows from the level itself and cannot be switched');
  return Object.fromEntries(Object.entries(input).filter(([k]) => !items.find((i) => i.key === k)?.locked));
}

/** The switches a template gives a level: the saved template (or the registry defaults), all of them, or custom ones. */
export async function templateSwitches(tx: TenantTx, level: WorkspacePermissionLevel, choice: { template: PermissionTemplateKey; permissions?: Record<string, boolean> }) {
  if (choice.template === 'all') return templatePermissions(level, 'all');
  const key = level === 'hr' ? 'hr_default' : 'employee_default';
  const saved = await tx.collection('level_permissions').findOne({ subject_type: TEMPLATE_SUBJECT[key].type, subject_id: 'default' });
  const base = templatePermissions(level, 'default', saved?.permissions);
  if (choice.template === 'custom') return { ...base, ...clean(level, choice.permissions ?? {}) };
  if (choice.template !== key) throw Errors.badRequest('wrong_template', `The ${PERMISSION_TEMPLATE_LABEL[choice.template]} is for the other level`);
  return base;
}

/**
 * Applies a template to a new HR Workspace (called while it is created). The switches are written explicitly, so a
 * later change to the template does not change HR Workspaces already made.
 */
export async function applyHrTemplate(tx: TenantTx, hrWorkspaceId: string, choice: HrWorkspaceTemplateChoice | undefined, membershipId: string) {
  const c = choice ?? { template: 'hr_default' as const };
  const permissions = await templateSwitches(tx, 'hr', c);
  await tx.collection('level_permissions').insert({ subject_type: 'hr_workspace', subject_id: hrWorkspaceId, permissions, scope_hr_workspace_ids: null, template: c.template, updated_by_membership_id: membershipId });
  return { template: c.template, permissions };
}

/**
 * Settings > Workspace Permissions. The Super Workspace decides, per category, what HR Workspace people (per HR
 * Workspace, or company-wide HR) and Employee Workspace people may do, and keeps the two default templates. HR
 * Workspace people may look at their own HR Workspace's permissions (read only). The switches are enforced in
 * loadSubject (authz.service), so the API refuses whatever is switched off.
 */
@Injectable()
export class WorkspacePermissionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private isSuper(s: Subject) {
    return s.grants.some((g) => g.roleKey === 'super_workspace') && hasPermission(s, 'hierarchy:manage').allowed;
  }

  /** HR Workspace groups the caller may look at: every one for the Super Workspace, their own for HR. */
  private hrGroupsOf(s: Subject): string[] | 'all' {
    if (this.isSuper(s)) return 'all';
    const hr = s.grants.filter((g) => g.roleKey === 'hr_workspace');
    if (!hr.length) throw Errors.forbidden('Only the Super Workspace manages workspace permissions');
    return [...new Set(hr.flatMap((g) => ((g.constraints.hrWorkspaceIds ?? []) as string[]).length ? (g.constraints.hrWorkspaceIds as string[]) : [CENTRAL_GROUP]))];
  }

  view(level: WorkspacePermissionLevel, groupId?: string): Promise<WorkspacePermissionsView> {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const allowed = this.hrGroupsOf(s);
      const spaces = await tx.collection('hr_workspaces').find({ status: { $ne: 'archived' } }, { sort: { name: 1 }, projection: { name: 1, features: 1, status: 1 } });
      const hrGroups = [{ id: CENTRAL_GROUP, name: 'Company HR team (central)' }, ...spaces.map((w) => ({ id: w.id as string, name: w.name as string }))]
        .filter((g) => allowed === 'all' || allowed.includes(g.id));
      if (level === 'employee' && allowed !== 'all') throw Errors.forbidden('Only the Super Workspace manages Employee Workspace permissions');
      const group = level === 'employee' ? 'all' : groupId ?? hrGroups[0]?.id ?? CENTRAL_GROUP;
      if (level === 'hr' && !hrGroups.some((g) => g.id === group)) throw Errors.notFound('HR Workspace');
      const row = await tx.collection('level_permissions').findOne({ subject_type: SUBJECT[level], subject_id: group });
      // Modules the level has: the company's, minus what the Super Workspace switched off for the level, and for an HR
      // Workspace only the modules it was given.
      const ent = await loadEntitlements(tx);
      const modules = await tx.collection('workspace_modules').findOne({ key: 'workspace' });
      const off = new Set(((level === 'hr' ? modules?.hr_level_off : modules?.employee_level_off) ?? []) as string[]);
      const space = spaces.find((w) => w.id === group);
      const has = (f: string | null) => !f || (ent.features.has(f) && !off.has(f) && (!space || ((space.features ?? []) as string[]).includes(f)));
      const templates = allowed === 'all'
        ? await Promise.all(PERMISSION_TEMPLATE_KEYS.filter((k) => k !== 'custom' && (k === 'all' || TEMPLATE_SUBJECT[k as 'hr_default' | 'employee_default'].level === level)).map(async (k) => ({
          key: k, label: PERMISSION_TEMPLATE_LABEL[k], permissions: await templateSwitches(tx, level, { template: k }),
        })))
        : [];
      // Delete areas the Console Admin has not allowed for the company: shown off, and never in effect.
      const consoleDeleteOff = new Set(((await tx.collection('tenant_access_controls').findOne({}))?.delete_areas_off ?? []) as string[]);
      const by = row?.updated_by_membership_id ? (await membershipUserNames(tx, [row.updated_by_membership_id])).get(row.updated_by_membership_id) ?? null : null;
      return {
        level, groupId: group,
        groupName: level === 'employee' ? 'All Employee Workspaces' : hrGroups.find((g) => g.id === group)?.name ?? 'HR Workspace',
        updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null, updatedBy: by, template: (row?.template as string | undefined) ?? null,
        categories: workspacePermissionCategories(level).map((c) => ({
          key: c.key, label: c.label, description: c.description, feature: c.feature, moduleOff: !has(c.feature),
          items: c.items.map((i) => ({
            key: i.key, label: i.label, description: i.description, on: workspacePermissionOn(i, row?.permissions), default: i.default, locked: Boolean(i.locked),
            enforced: i.locked ? 'always' as const : i.deleteArea ? 'delete' as const : i.permissions.length ? 'permission' as const : i.routes?.length ? 'route' as const : 'setting' as const,
            ...(i.deleteArea ? { blockedByConsole: consoleDeleteOff.has(i.deleteArea) } : {}),
          })),
        })),
        groups: [...hrGroups.map((g) => ({ ...g, level: 'hr' as const })), ...(allowed === 'all' ? [{ id: 'all', name: 'All Employee Workspaces', level: 'employee' as const }] : [])],
        templates,
      };
    });
  }

  /** Saves every switch of one level for one group (Save Changes, Reset to Default and templates all end here). */
  save(input: WorkspacePermissionsInput) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!this.isSuper(s)) {
        await this.db.tenant((t) => this.audit.record(t, { action: 'workspace_permissions.denied', resourceType: SUBJECT[input.level], resourceId: input.groupId, metadata: { reason: 'not_super_workspace' } })).catch(() => undefined);
        throw Errors.forbidden('Only the Super Workspace changes workspace permissions. An HR Workspace can never give itself more.');
      }
      if (input.level === 'hr' && input.groupId !== CENTRAL_GROUP && !(await tx.collection('hr_workspaces').exists({ id: input.groupId, status: { $ne: 'archived' } }))) throw Errors.notFound('HR Workspace');
      const permissions = clean(input.level, input.permissions);
      const before = await tx.collection('level_permissions').findOne({ subject_type: SUBJECT[input.level], subject_id: input.groupId });
      const items = workspacePermissionItems(input.level);
      const prev = Object.fromEntries(items.filter((i) => !i.locked).map((i) => [i.key, workspacePermissionOn(i, before?.permissions)]));
      // Keys left out keep their current value; anything not in the registry that was saved before is kept (other settings).
      const next = { ...((before?.permissions ?? {}) as Record<string, boolean>), ...prev, ...permissions };
      const changed = Object.keys(prev).filter((k) => prev[k] !== next[k]);
      if (before) await tx.collection('level_permissions').updateOne({ id: before.id }, { $set: { permissions: next, template: input.template ?? null, updated_by_membership_id: s.membershipId } });
      else await tx.collection('level_permissions').insert({ subject_type: SUBJECT[input.level], subject_id: input.groupId, permissions: next, scope_hr_workspace_ids: null, template: input.template ?? null, updated_by_membership_id: s.membershipId });
      if (changed.length) {
        await this.audit.record(tx, {
          action: 'workspace_permissions.updated', resourceType: SUBJECT[input.level], resourceId: input.groupId,
          changes: Object.fromEntries(changed.map((k) => [k, { from: prev[k], to: next[k] }])), metadata: { level: input.level, template: input.template ?? null },
        });
        await this.notifications.signal(tx, await this.affected(tx, input.level, input.groupId), 'access.changed', {});
      }
      return { saved: changed.length };
    }).then(() => this.view(input.level, input.groupId));
  }

  /** Changing one default template (it applies to HR Workspaces created from now on, never to existing ones). */
  saveTemplate(key: 'hr_default' | 'employee_default', input: Record<string, boolean> | null) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!this.isSuper(s)) throw Errors.forbidden('Only the Super Workspace changes the default templates');
      const { type, level } = TEMPLATE_SUBJECT[key];
      const before = await tx.collection('level_permissions').findOne({ subject_type: type, subject_id: 'default' });
      const permissions = input === null ? {} : { ...templatePermissions(level, 'default', before?.permissions), ...clean(level, input) };
      if (before) await tx.collection('level_permissions').updateOne({ id: before.id }, { $set: { permissions, updated_by_membership_id: s.membershipId } });
      else await tx.collection('level_permissions').insert({ subject_type: type, subject_id: 'default', permissions, scope_hr_workspace_ids: null, updated_by_membership_id: s.membershipId });
      await this.audit.record(tx, { action: input === null ? 'permission_template.reset' : 'permission_template.updated', resourceType: 'permission_template', resourceId: key, changes: { permissions: { from: before?.permissions ?? null, to: permissions } } });
      return { key, label: PERMISSION_TEMPLATE_LABEL[key], permissions: await templateSwitches(tx, level, { template: key }) };
    });
  }

  /** Who a change reaches, so their open screens reload their access. */
  private async affected(tx: TenantTx, level: WorkspacePermissionLevel, groupId: string): Promise<string[]> {
    if (level === 'employee') return (await tx.collection('memberships').find({ status: 'active' }, { projection: { _id: 1 }, limit: 5000 })).map((m) => m.id as string);
    const role = await tx.collection('roles').findOne({ key: 'hr_workspace', is_system: true });
    if (!role) return [];
    const rows: Doc[] = await tx.collection('role_assignments').find({ role_id: role.id });
    return rows.filter((r) => {
      const ids = (r.constraints?.hrWorkspaceIds ?? []) as string[];
      return groupId === CENTRAL_GROUP ? !ids.length : ids.includes(groupId);
    }).map((r) => r.membership_id as string);
  }
}

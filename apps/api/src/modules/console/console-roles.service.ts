import { Injectable } from '@nestjs/common';
import { CONSOLE_PERMISSION_KEYS, withNeededPermissions, type ConsoleRole, type ConsoleRoleInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

interface RoleRow { id: string; key: string; name: string; description: string; permissions: string[]; is_system: boolean; archived_at: Date | null; updated_at: Date | null; customised_at: Date | null }

/** The permissions no Console can run without: someone must always be able to manage admins and roles. */
const KEEPER = ['admins:manage', 'roles:manage'];

/**
 * Console roles and permissions (RBAC). Built-in roles can have their permissions changed (except Super Admin, which
 * always has everything); custom roles can be created and archived. Every change applies to signed-in admins on their
 * next request, because the guard reads permissions from platform_roles each time. Every change is audited with the
 * permissions before and after.
 */
@Injectable()
export class ConsoleRolesService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  list(): Promise<ConsoleRole[]> {
    return this.db.platform(async (tx) => {
      const rows = await tx.collection<RoleRow>('platform_roles').find({}, { sort: { is_system: -1, name: 1 } });
      const counts = await tx.collection('platform_admins').aggregate<{ id: string; n: number }>([{ $match: { status: 'active' } }, { $group: { _id: '$role', n: { $sum: 1 } } }]);
      const n = new Map(counts.map((c) => [c.id, c.n]));
      return rows.map((r) => view(r, n.get(r.key) ?? 0));
    });
  }

  create(input: ConsoleRoleInput): Promise<ConsoleRole> {
    return this.db.platform(async (tx) => {
      const roles = tx.collection<RoleRow>('platform_roles');
      const base = `custom_${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'role'}`;
      let key = base;
      for (let i = 2; await roles.exists({ key }); i++) key = `${base.slice(0, 36)}_${i}`;
      if (await roles.exists({ name: input.name, archived_at: null })) throw Errors.conflict('role_exists', 'A role with this name exists');
      const permissions = withNeededPermissions(input.permissions);
      const row = await roles.insert({ key, name: input.name, description: input.description, permissions, is_system: false });
      await this.audit.record(tx, { tenantId: null, action: 'platform.role_created', resourceType: 'platform_role', resourceId: key, changes: { name: input.name, permissions: { from: [], to: permissions } } });
      return view(row, 0);
    });
  }

  update(key: string, input: ConsoleRoleInput): Promise<ConsoleRole> {
    return this.db.platform(async (tx) => {
      const roles = tx.collection<RoleRow>('platform_roles');
      const row = await roles.findOne({ key });
      if (!row || row.archived_at) throw Errors.notFound('Role');
      const permissions = key === 'super_admin' ? [...CONSOLE_PERMISSION_KEYS] : withNeededPermissions(input.permissions);
      if (key === 'super_admin' && input.permissions.length !== CONSOLE_PERMISSION_KEYS.length) {
        throw Errors.badRequest('super_admin_fixed', 'Super Admin always has every permission. Create a custom role instead.');
      }
      if (await roles.exists({ name: input.name, archived_at: null, key: { $ne: key } })) throw Errors.conflict('role_exists', 'A role with this name exists');
      await this.keepKeeper(tx, key, permissions);
      const set: Record<string, unknown> = { name: row.is_system ? row.name : input.name, description: input.description, permissions };
      if (row.is_system) set.customised_at = new Date();
      await roles.updateOne({ key }, { $set: set });
      const added = permissions.filter((p) => !row.permissions.includes(p));
      const removed = row.permissions.filter((p) => !permissions.includes(p));
      await this.audit.record(tx, {
        tenantId: null, action: 'platform.role_updated', resourceType: 'platform_role', resourceId: key,
        changes: { permissions: { from: row.permissions, to: permissions }, added, removed, ...(set.name !== row.name ? { name: { from: row.name, to: set.name } } : {}) },
      });
      const admins = await tx.collection('platform_admins').count({ role: key, status: 'active' });
      return view({ ...row, ...set } as RoleRow, admins);
    });
  }

  archive(key: string): Promise<void> {
    return this.db.platform(async (tx) => {
      const row = await tx.collection<RoleRow>('platform_roles').findOne({ key });
      if (!row || row.archived_at) throw Errors.notFound('Role');
      if (row.is_system) throw Errors.badRequest('system_role', 'Built-in roles cannot be archived');
      if (await tx.collection('platform_admins').exists({ role: key, status: 'active' })) throw Errors.conflict('role_in_use', 'Admins hold this role. Give them another role first.');
      await tx.collection('platform_roles').updateOne({ key }, { $set: { archived_at: new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.role_archived', resourceType: 'platform_role', resourceId: key, changes: { name: row.name } });
    });
  }

  /** The signed-in admin's role and permissions (the Console shows only what these allow). */
  mine() {
    const a = requestContext.platformActor();
    return { role: a.role, permissions: [...a.permissions] };
  }

  /** After the change, at least one active admin other than nobody must still hold admin and role management. */
  private async keepKeeper(tx: PlatformTx, key: string, next: string[]) {
    if (KEEPER.every((k) => next.includes(k))) return;
    const keepers = (await tx.collection<RoleRow>('platform_roles').find({ archived_at: null, key: { $ne: key }, permissions: { $all: KEEPER } })).map((r) => r.key);
    if (!(await tx.collection('platform_admins').exists({ status: 'active', role: { $in: keepers } }))) {
      throw Errors.conflict('last_keeper', 'No other active admin could then manage Console admins and roles. Keep those permissions here, or give another admin such a role first.');
    }
  }
}

function view(r: RoleRow, admins: number): ConsoleRole {
  return { key: r.key, name: r.name, description: r.description ?? '', permissions: r.permissions ?? [], system: r.is_system, admins, archived: !!r.archived_at, updatedAt: r.updated_at?.toISOString?.() ?? null };
}

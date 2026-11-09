import { Injectable } from '@nestjs/common';
import { getPermission, PERMISSIONS, type Scope } from '@crew/contracts';
import type { z } from 'zod';
import type { customRoleInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

type RoleInput = z.infer<typeof customRoleInput>;

@Injectable()
export class RolesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  catalogue() {
    return PERMISSIONS;
  }

  list() {
    return this.db.tenant(async (tx) => {
      const roles = await tx.collection('roles').find({}, { sort: { is_system: -1, name: 1 } });
      const ids = roles.map((r) => r.id as string);
      const counts = await countBy(tx, 'role_assignments', 'role_id', ids);
      const grants = await grantsBy(tx, ids);
      return roles.map((r) => ({ ...view(r, grants.get(r.id)), memberCount: counts.get(r.id) ?? 0 }));
    });
  }

  async create(input: RoleInput) {
    validateGrants(input.grants);
    return this.db.tenant(async (tx) => {
      if (await tx.collection('roles').exists({ key: input.key })) throw Errors.conflict('role_exists', 'A role with this key already exists');
      const role = await tx.collection('roles').insert({ key: input.key, name: input.name, description: input.description ?? null });
      await this.writeGrants(tx, role.id, input.grants);
      await this.audit.record(tx, { action: 'role.created', resourceType: 'role', resourceId: role.id, changes: { key: input.key, grants: input.grants } });
      return this.get(tx, role.id);
    });
  }

  async update(id: string, input: Omit<RoleInput, 'key'>) {
    validateGrants(input.grants);
    return this.db.tenant(async (tx) => {
      const role = await tx.collection('roles').findOne({ id });
      if (!role) throw Errors.notFound('Role');
      if (role.is_system) throw Errors.badRequest('system_role', 'System roles cannot be edited. Duplicate it as a custom role instead.');
      const before = await this.get(tx, id);
      await tx.collection('roles').updateOne({ id }, { $set: { name: input.name, description: input.description ?? null } });
      await tx.collection('role_permissions').delete({ role_id: id });
      await this.writeGrants(tx, id, input.grants);
      await this.audit.record(tx, { action: 'role.updated', resourceType: 'role', resourceId: id, changes: { grants: { from: before.grants, to: Object.fromEntries(input.grants.map((g) => [g.permission, g.scope])) } } });
      return this.get(tx, id);
    });
  }

  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const role = await tx.collection('roles').findOne({ id });
      if (!role) throw Errors.notFound('Role');
      if (role.is_system) throw Errors.badRequest('system_role', 'System roles cannot be deleted');
      if (await tx.collection('role_assignments').exists({ role_id: id })) throw Errors.conflict('role_in_use', 'Remove this role from all members first');
      await tx.collection('roles').deleteOne({ id });
      await this.audit.record(tx, { action: 'role.deleted', resourceType: 'role', resourceId: id, changes: { key: role.key } });
    });
  }

  private async get(tx: TenantTx, id: string) {
    const role = await tx.collection('roles').findOne({ id });
    return view(role!, (await grantsBy(tx, [id])).get(id));
  }

  private async writeGrants(tx: TenantTx, roleId: string, grants: RoleInput['grants']) {
    if (grants.length) await tx.collection('role_permissions').insertMany(grants.map((g) => ({ role_id: roleId, permission: g.permission, scope: g.scope })));
  }
}

function view(r: Record<string, unknown>, grants: Record<string, Scope> = {}) {
  return { id: r.id as string, key: r.key as string, name: r.name as string, description: (r.description as string | null) ?? null, isSystem: r.is_system as boolean, grants };
}

async function grantsBy(tx: TenantTx, roleIds: string[]): Promise<Map<string, Record<string, Scope>>> {
  const out = new Map<string, Record<string, Scope>>();
  for (const rp of await tx.collection('role_permissions').find({ role_id: { $in: roleIds } })) {
    out.set(rp.role_id, { ...(out.get(rp.role_id) ?? {}), [rp.permission]: rp.scope });
  }
  return out;
}

/** Every grant must name a catalogued permission at a scope that permission supports. */
export function validateGrants(grants: RoleInput['grants']) {
  const seen = new Set<string>();
  const problems: { path: string; message: string }[] = [];
  grants.forEach((g, i) => {
    const def = getPermission(g.permission);
    if (!def) problems.push({ path: `grants.${i}.permission`, message: `Unknown permission ${g.permission}` });
    else if (!(def.scopes as readonly string[]).includes(g.scope)) problems.push({ path: `grants.${i}.scope`, message: `${g.permission} supports ${def.scopes.join(', ')}` });
    if (seen.has(g.permission)) problems.push({ path: `grants.${i}.permission`, message: `${g.permission} is listed twice` });
    seen.add(g.permission);
  });
  if (problems.length) throw Errors.validation(problems);
}

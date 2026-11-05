import { Injectable } from '@nestjs/common';
import { getPermission, PERMISSIONS, type Scope } from '@crew/contracts';
import type { z } from 'zod';
import type { customRoleInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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
    return this.db.tenant((tx) =>
      many(
        tx,
        `select r.id, r.key, r.name, r.description, r.is_system as "isSystem",
                (select count(*)::int from role_assignments ra where ra.role_id = r.id) as "memberCount",
                coalesce((select json_object_agg(rp.permission, rp.scope) from role_permissions rp where rp.role_id = r.id), '{}') as grants
           from roles r order by r.is_system desc, r.name`,
      ),
    );
  }

  async create(input: RoleInput) {
    validateGrants(input.grants);
    return this.db.tenant(async (tx) => {
      const tenantId = requestContext.tenantActor().tenantId;
      if (await one(tx, 'select 1 from roles where key = $1', [input.key])) throw Errors.conflict('role_exists', 'A role with this key already exists');
      const role = (await one<{ id: string }>(tx, `insert into roles (tenant_id, key, name, description) values ($1, $2, $3, $4) returning id`, [tenantId, input.key, input.name, input.description ?? null]))!;
      await this.writeGrants(tx, tenantId, role.id, input.grants);
      await this.audit.record(tx, { action: 'role.created', resourceType: 'role', resourceId: role.id, changes: { key: input.key, grants: input.grants } });
      return this.get(tx, role.id);
    });
  }

  async update(id: string, input: Omit<RoleInput, 'key'>) {
    validateGrants(input.grants);
    return this.db.tenant(async (tx) => {
      const role = await one<{ is_system: boolean }>(tx, 'select is_system from roles where id = $1 for update', [id]);
      if (!role) throw Errors.notFound('Role');
      if (role.is_system) throw Errors.badRequest('system_role', 'System roles cannot be edited. Duplicate it as a custom role instead.');
      const before = await this.get(tx, id);
      await tx.query('update roles set name = $2, description = $3 where id = $1', [id, input.name, input.description ?? null]);
      await tx.query('delete from role_permissions where role_id = $1', [id]);
      await this.writeGrants(tx, requestContext.tenantActor().tenantId, id, input.grants);
      await this.audit.record(tx, { action: 'role.updated', resourceType: 'role', resourceId: id, changes: { grants: { from: before.grants, to: Object.fromEntries(input.grants.map((g) => [g.permission, g.scope])) } } });
      return this.get(tx, id);
    });
  }

  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const role = await one<{ is_system: boolean; key: string }>(tx, 'select is_system, key from roles where id = $1 for update', [id]);
      if (!role) throw Errors.notFound('Role');
      if (role.is_system) throw Errors.badRequest('system_role', 'System roles cannot be deleted');
      if (await one(tx, 'select 1 from role_assignments where role_id = $1 limit 1', [id])) throw Errors.conflict('role_in_use', 'Remove this role from all members first');
      await tx.query('delete from roles where id = $1', [id]);
      await this.audit.record(tx, { action: 'role.deleted', resourceType: 'role', resourceId: id, changes: { key: role.key } });
    });
  }

  private async get(tx: Tx, id: string) {
    return (await one<{ id: string; grants: Record<string, Scope> }>(
      tx,
      `select r.id, r.key, r.name, r.description, r.is_system as "isSystem",
              coalesce((select json_object_agg(rp.permission, rp.scope) from role_permissions rp where rp.role_id = r.id), '{}') as grants
         from roles r where r.id = $1`,
      [id],
    ))!;
  }

  private async writeGrants(tx: Tx, tenantId: string, roleId: string, grants: RoleInput['grants']) {
    await tx.query(
      `insert into role_permissions (tenant_id, role_id, permission, scope) select $1, $2, g.p, g.s from unnest($3::text[], $4::text[]) g(p, s)`,
      [tenantId, roleId, grants.map((g) => g.permission), grants.map((g) => g.scope)],
    );
  }
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

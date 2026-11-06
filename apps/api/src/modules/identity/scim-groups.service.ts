import { Injectable } from '@nestjs/common';
import { applyScimGroupPatch, parseScimFilter, SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_UNMAPPABLE_ROLES, type ScimGroupInput, type ScimPatchInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { ScimError } from './scim.service';

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  role_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SCIM 2.0 Groups (RFC 7643 section 4.2). The identity provider owns the groups and who is in them; a workspace
 * owner decides in SampCrew which role, if any, each group grants. Members of a mapped group hold that role while they
 * are in it (role_assignments.source = 'scim'). Removing someone from a group removes only a role that came from a
 * group, and only when no other group they are in grants it. Roles given by hand in SampCrew are never touched, and no
 * group can grant the owner role.
 */
@Injectable()
export class ScimGroupsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async log(tx: Tx, method: string, path: string, status: number, detail?: string) {
    await tx.query('insert into scim_events (tenant_id, method, path, status, membership_id, detail) values (app_tenant_id(), $1, $2, $3, null, $4)', [
      method, path.slice(0, 300), status, detail?.slice(0, 500) ?? null,
    ]);
  }

  private async load(tx: Tx, id: string) {
    if (!UUID.test(id)) throw new ScimError(404, undefined, 'Group not found');
    const g = await one<GroupRow>(tx, 'select * from scim_groups where id = $1', [id]);
    if (!g) throw new ScimError(404, undefined, 'Group not found');
    return g;
  }

  private async resource(tx: Tx, g: GroupRow, base: string, withMembers = true) {
    const members = withMembers
      ? await many<{ value: string; display: string }>(
          tx,
          `select m.id as value, u.email::text as display from scim_group_members gm join memberships m on m.id = gm.membership_id join users u on u.id = m.user_id
            where gm.group_id = $1 order by gm.created_at, m.id`,
          [g.id],
        )
      : undefined;
    return {
      schemas: [SCIM_GROUP_SCHEMA],
      id: g.id,
      displayName: g.display_name,
      ...(g.external_id ? { externalId: g.external_id } : {}),
      ...(members ? { members: members.map((m) => ({ ...m, $ref: `${base}/Users/${m.value}` })) } : {}),
      meta: { resourceType: 'Group', created: g.created_at.toISOString(), lastModified: g.updated_at.toISOString(), location: `${base}/Groups/${g.id}` },
    };
  }

  /** Checks member ids belong to this workspace. Unknown ids are refused, so the provider shows the problem. */
  private async memberIds(tx: Tx, values: string[]) {
    const ids = [...new Set(values)];
    const bad = ids.find((v) => !UUID.test(v));
    if (bad) throw new ScimError(400, 'invalidValue', `Unknown member "${bad.slice(0, 60)}": members must be SampCrew user ids from /Users`);
    if (!ids.length) return ids;
    const found = await many<{ id: string }>(tx, 'select id from memberships where id = any($1::uuid[])', [ids]);
    const missing = ids.filter((v) => !found.some((f) => f.id === v));
    if (missing.length) throw new ScimError(400, 'invalidValue', `Unknown member ${missing[0]}: provision the user first`);
    return ids;
  }

  /**
   * Brings group-granted roles in line with group membership for these people. Returns who gained or lost a role.
   */
  private async syncRoles(tx: Tx, membershipIds: string[]) {
    if (!membershipIds.length) return [];
    const added = await many<{ membership_id: string; key: string }>(
      tx,
      `with ins as (
         insert into role_assignments (tenant_id, membership_id, role_id, source)
         select distinct app_tenant_id(), gm.membership_id, g.role_id, 'scim'
           from scim_group_members gm join scim_groups g on g.id = gm.group_id
          where g.role_id is not null and gm.membership_id = any($1::uuid[])
         on conflict (membership_id, role_id) do nothing
         returning membership_id, role_id)
       select ins.membership_id, r.key from ins join roles r on r.id = ins.role_id`,
      [membershipIds],
    );
    const removed = await many<{ membership_id: string; key: string }>(
      tx,
      `with del as (
         delete from role_assignments ra
          where ra.source = 'scim' and ra.membership_id = any($1::uuid[])
            and not exists (select 1 from scim_group_members gm join scim_groups g on g.id = gm.group_id
                             where gm.membership_id = ra.membership_id and g.role_id = ra.role_id)
         returning membership_id, role_id)
       select del.membership_id, r.key from del join roles r on r.id = del.role_id`,
      [membershipIds],
    );
    const actor = requestContext.tenantActor();
    const changed = [...new Set([...added, ...removed].map((r) => r.membership_id))];
    for (const id of changed) {
      await this.audit.record(tx, {
        action: 'membership.roles_changed', resourceType: 'membership', resourceId: id,
        changes: { added: added.filter((a) => a.membership_id === id).map((a) => a.key), removed: removed.filter((a) => a.membership_id === id).map((a) => a.key) },
        metadata: { via: 'scim_group' },
      });
      await this.outbox.publish(tx, actor.tenantId, 'membership.roles_changed', { membershipId: id });
    }
    return changed;
  }

  // SCIM endpoints ------------------------------------------------------------------------------------------------

  async list(q: { filter?: string; startIndex?: number; count?: number; excludedAttributes?: string }, base: string) {
    const f = parseScimFilter(q.filter, ['displayName', 'externalId']);
    if (f === 'unsupported') throw new ScimError(400, 'invalidFilter', 'Only displayName eq "…" and externalId eq "…" filters are supported');
    const start = Math.max(1, q.startIndex ?? 1);
    const count = Math.min(Math.max(0, q.count ?? 100), 200);
    const withMembers = !(q.excludedAttributes ?? '').split(',').map((s) => s.trim().toLowerCase()).includes('members');
    return this.db.tenant(async (tx) => {
      const where = !f ? '' : f.attr === 'displayName' ? 'where lower(display_name) = lower($3)' : 'where external_id = $3';
      const rows = await many<GroupRow>(tx, `select * from scim_groups ${where} order by created_at, id limit $1 offset $2`, [count, start - 1, ...(f ? [f.value] : [])]);
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n from scim_groups ${where.replace('$3', '$1')}`, f ? [f.value] : []))!.n;
      await this.log(tx, 'GET', `/Groups${q.filter ? `?filter=${q.filter}` : ''}`, 200);
      const resources = [];
      for (const g of rows) resources.push(await this.resource(tx, g, base, withMembers));
      return { schemas: [SCIM_LIST_SCHEMA], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: resources };
    });
  }

  async get(id: string, base: string) {
    return this.db.tenant(async (tx) => this.resource(tx, await this.load(tx, id), base));
  }

  async create(input: ScimGroupInput, base: string) {
    return this.db.tenant(async (tx) => {
      if (await one(tx, 'select 1 from scim_groups where lower(display_name) = lower($1)', [input.displayName])) throw new ScimError(409, 'uniqueness', 'A group with this displayName already exists');
      if (input.externalId && (await one(tx, 'select 1 from scim_groups where external_id = $1', [input.externalId]))) throw new ScimError(409, 'uniqueness', 'A group with this externalId already exists');
      const ids = await this.memberIds(tx, (input.members ?? []).map((m) => m.value));
      const g = (await one<GroupRow>(tx, 'insert into scim_groups (tenant_id, display_name, external_id) values (app_tenant_id(), $1, $2) returning *', [input.displayName, input.externalId ?? null]))!;
      for (const id of ids) await tx.query('insert into scim_group_members (tenant_id, group_id, membership_id) values (app_tenant_id(), $1, $2)', [g.id, id]);
      await this.audit.record(tx, { action: 'scim_group.created', resourceType: 'scim_group', resourceId: g.id, changes: { displayName: g.display_name, members: ids.length } });
      await this.log(tx, 'POST', '/Groups', 201, `${g.display_name} (${ids.length} members)`);
      return this.resource(tx, g, base);
    });
  }

  async replace(id: string, input: ScimGroupInput, base: string) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id);
      const ids = await this.memberIds(tx, (input.members ?? []).map((m) => m.value));
      await this.update(tx, g, { displayName: input.displayName, externalId: input.externalId ?? g.external_id, replace: ids, add: [], remove: [] }, 'PUT');
      return this.resource(tx, await this.load(tx, id), base);
    });
  }

  async patch(id: string, input: ScimPatchInput, base: string) {
    return this.db.tenant(async (tx) => {
      const g = await this.load(tx, id);
      const p = applyScimGroupPatch(input.Operations);
      const add = await this.memberIds(tx, p.add);
      const replace = p.replace ? await this.memberIds(tx, p.replace) : undefined;
      await this.update(tx, g, { displayName: p.displayName, externalId: p.externalId, add, remove: p.remove.filter((v) => UUID.test(v)), replace }, 'PATCH', p.ignored);
      return this.resource(tx, await this.load(tx, id), base);
    });
  }

  private async update(
    tx: Tx, g: GroupRow,
    p: { displayName?: string; externalId?: string | null; add: string[]; remove: string[]; replace?: string[] },
    method: string, ignored: string[] = [],
  ) {
    if (p.displayName && p.displayName.toLowerCase() !== g.display_name.toLowerCase() && (await one(tx, 'select 1 from scim_groups where lower(display_name) = lower($1) and id <> $2', [p.displayName, g.id]))) {
      throw new ScimError(409, 'uniqueness', 'Another group has this displayName');
    }
    if (p.externalId && p.externalId !== g.external_id && (await one(tx, 'select 1 from scim_groups where external_id = $1 and id <> $2', [p.externalId, g.id]))) {
      throw new ScimError(409, 'uniqueness', 'Another group has this externalId');
    }
    const before = (await many<{ membership_id: string }>(tx, 'select membership_id from scim_group_members where group_id = $1', [g.id])).map((r) => r.membership_id);
    await tx.query('update scim_groups set display_name = $2, external_id = $3, updated_at = now() where id = $1', [g.id, p.displayName ?? g.display_name, p.externalId === undefined ? g.external_id : p.externalId]);
    if (p.replace) await tx.query('delete from scim_group_members where group_id = $1 and not (membership_id = any($2::uuid[]))', [g.id, p.replace]);
    if (p.remove.length) await tx.query('delete from scim_group_members where group_id = $1 and membership_id = any($2::uuid[])', [g.id, p.remove]);
    for (const id of [...(p.replace ?? []), ...p.add]) {
      await tx.query('insert into scim_group_members (tenant_id, group_id, membership_id) values (app_tenant_id(), $1, $2) on conflict do nothing', [g.id, id]);
    }
    const after = (await many<{ membership_id: string }>(tx, 'select membership_id from scim_group_members where group_id = $1', [g.id])).map((r) => r.membership_id);
    const joined = after.filter((x) => !before.includes(x));
    const left = before.filter((x) => !after.includes(x));
    await this.syncRoles(tx, [...joined, ...left]);
    if (joined.length || left.length || p.displayName || p.externalId !== undefined) {
      await this.audit.record(tx, { action: 'scim_group.updated', resourceType: 'scim_group', resourceId: g.id, changes: { displayName: p.displayName ?? g.display_name, joined: joined.length, left: left.length } });
    }
    await this.log(tx, method, `/Groups/${g.id}`, 200, [`+${joined.length} −${left.length} members`, ignored.length ? `ignored: ${ignored.join(', ')}` : ''].filter(Boolean).join('; '));
  }

  async remove(id: string) {
    await this.db.tenant(async (tx) => {
      const g = await this.load(tx, id);
      const members = (await many<{ membership_id: string }>(tx, 'select membership_id from scim_group_members where group_id = $1', [g.id])).map((r) => r.membership_id);
      await tx.query('delete from scim_groups where id = $1', [g.id]);
      await this.syncRoles(tx, members);
      await this.audit.record(tx, { action: 'scim_group.deleted', resourceType: 'scim_group', resourceId: g.id, changes: { displayName: g.display_name, members: members.length } });
      await this.log(tx, 'DELETE', `/Groups/${g.id}`, 204, g.display_name);
    });
  }

  // Owners map groups to roles in Settings ---------------------------------------------------------------------------

  async overview(inTx?: Tx) {
    const read = (tx: Tx) =>
      many(
        tx,
        `select g.id, g.display_name as "displayName", g.external_id as "externalId", g.updated_at as "updatedAt",
                r.id as "roleId", r.key as "roleKey", r.name as "roleName",
                (select count(*)::int from scim_group_members gm where gm.group_id = g.id) as "memberCount"
           from scim_groups g left join roles r on r.id = g.role_id
          order by lower(g.display_name)`,
      );
    return inTx ? read(inTx) : this.db.tenant(read);
  }

  async setRole(groupId: string, roleId: string | null) {
    return this.db.tenant(async (tx) => {
      const g = await one<GroupRow>(tx, 'select * from scim_groups where id = $1', [groupId]);
      if (!g) throw Errors.notFound('Provisioning group');
      let role: { id: string; key: string; name: string } | null = null;
      if (roleId) {
        role = (await one<{ id: string; key: string; name: string }>(tx, 'select id, key, name from roles where id = $1', [roleId])) ?? null;
        if (!role) throw Errors.notFound('Role');
        if ((SCIM_UNMAPPABLE_ROLES as readonly string[]).includes(role.key)) {
          throw Errors.badRequest('role_not_mappable', 'A provisioning group cannot grant the owner role. Owners are added by another owner in SampCrew.');
        }
      }
      if ((g.role_id ?? null) === (role?.id ?? null)) return this.overview(tx);
      await tx.query('update scim_groups set role_id = $2, updated_at = now() where id = $1', [g.id, role?.id ?? null]);
      const members = (await many<{ membership_id: string }>(tx, 'select membership_id from scim_group_members where group_id = $1', [g.id])).map((r) => r.membership_id);
      const changed = await this.syncRoles(tx, members);
      await this.audit.record(tx, {
        action: 'scim_group.role_mapped', resourceType: 'scim_group', resourceId: g.id,
        changes: { displayName: g.display_name, role: role?.key ?? null, previousRoleId: g.role_id, membersChanged: changed.length },
      });
      return this.overview(tx);
    });
  }
}

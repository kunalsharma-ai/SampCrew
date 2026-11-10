import { Injectable } from '@nestjs/common';
import { applyScimGroupPatch, parseScimFilter, SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_UNMAPPABLE_ROLES, type ScimGroupInput, type ScimPatchInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
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

/** A group with this display name (compared case-insensitively, as the SQL lower() check did), other than `exceptId`. */
async function nameTaken(tx: TenantTx, displayName: string, exceptId?: string) {
  const wanted = displayName.toLowerCase();
  return (await tx.collection<GroupRow>('scim_groups').find({}, { projection: { display_name: 1 } })).some((g) => g.id !== exceptId && g.display_name.toLowerCase() === wanted);
}

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

  private async log(tx: TenantTx, method: string, path: string, status: number, detail?: string) {
    await tx.collection('scim_events').insert({ method, path: path.slice(0, 300), status, membership_id: null, detail: detail?.slice(0, 500) ?? null });
  }

  private async load(tx: TenantTx, id: string) {
    if (!UUID.test(id)) throw new ScimError(404, undefined, 'Group not found');
    const g = await tx.collection<GroupRow>('scim_groups').findOne({ id });
    if (!g) throw new ScimError(404, undefined, 'Group not found');
    return g;
  }

  private async memberships(tx: TenantTx, groupId: string): Promise<string[]> {
    return (await tx.collection('scim_group_members').find({ group_id: groupId }, { sort: { created_at: 1, membership_id: 1 } })).map((r) => r.membership_id as string);
  }

  private async resource(tx: TenantTx, g: GroupRow, base: string, withMembers = true) {
    let members: { value: string; display: string }[] | undefined;
    if (withMembers) {
      const ids = await this.memberships(tx, g.id);
      const ms = new Map((await tx.collection('memberships').find({ id: { $in: ids } }, { projection: { user_id: 1 } })).map((m) => [m.id as string, m.user_id as string]));
      const emails = new Map((await (await tx.users()).find({ id: { $in: [...ms.values()] } }, { projection: { email: 1 } })).map((u) => [u.id as string, u.email as string]));
      members = ids.filter((id) => ms.has(id)).map((id) => ({ value: id, display: emails.get(ms.get(id)!)! }));
    }
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
  private async memberIds(tx: TenantTx, values: string[]) {
    const ids = [...new Set(values)];
    const bad = ids.find((v) => !UUID.test(v));
    if (bad) throw new ScimError(400, 'invalidValue', `Unknown member "${bad.slice(0, 60)}": members must be SampCrew user ids from /Users`);
    if (!ids.length) return ids;
    const found = new Set((await tx.collection('memberships').find({ id: { $in: ids } }, { projection: { _id: 1 } })).map((m) => m.id as string));
    const missing = ids.filter((v) => !found.has(v));
    if (missing.length) throw new ScimError(400, 'invalidValue', `Unknown member ${missing[0]}: provision the user first`);
    return ids;
  }

  /**
   * Brings group-granted roles in line with group membership for these people. Returns who gained or lost a role.
   */
  private async syncRoles(tx: TenantTx, membershipIds: string[]) {
    if (!membershipIds.length) return [];
    const links = await tx.collection('scim_group_members').find({ membership_id: { $in: membershipIds } });
    const groupRole = new Map(
      (await tx.collection('scim_groups').find({ id: { $in: [...new Set(links.map((l) => l.group_id))] }, role_id: { $ne: null } })).map((g) => [g.id as string, g.role_id as string]),
    );
    // What each person should hold through their groups.
    const wanted = new Set(links.filter((l) => groupRole.has(l.group_id)).map((l) => `${l.membership_id}:${groupRole.get(l.group_id)}`));
    const current = await tx.collection('role_assignments').find({ membership_id: { $in: membershipIds } });
    const held = new Set(current.map((a) => `${a.membership_id}:${a.role_id}`));
    const addedPairs = [...wanted].filter((k) => !held.has(k)).map((k) => k.split(':') as [string, string]);
    const removedRows = current.filter((a) => a.source === 'scim' && !wanted.has(`${a.membership_id}:${a.role_id}`));
    if (addedPairs.length) await tx.collection('role_assignments').insertMany(addedPairs.map(([membership_id, role_id]) => ({ membership_id, role_id, source: 'scim' })));
    if (removedRows.length) await tx.collection('role_assignments').delete({ id: { $in: removedRows.map((a) => a.id) } });
    const roleKeys = new Map(
      (await tx.collection('roles').find({ id: { $in: [...new Set([...addedPairs.map((p) => p[1]), ...removedRows.map((a) => a.role_id as string)])] } })).map((r) => [r.id as string, r.key as string]),
    );
    const added = addedPairs.map(([membership_id, role_id]) => ({ membership_id, key: roleKeys.get(role_id)! }));
    const removed = removedRows.map((a) => ({ membership_id: a.membership_id as string, key: roleKeys.get(a.role_id)! }));
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
      let all = await tx.collection<GroupRow>('scim_groups').find(f?.attr === 'externalId' ? { external_id: f.value } : {}, { sort: { created_at: 1, _id: 1 } });
      if (f?.attr === 'displayName') all = all.filter((g) => g.display_name.toLowerCase() === f.value.toLowerCase());
      const rows = all.slice(start - 1, start - 1 + count);
      await this.log(tx, 'GET', `/Groups${q.filter ? `?filter=${q.filter}` : ''}`, 200);
      const resources = [];
      for (const g of rows) resources.push(await this.resource(tx, g, base, withMembers));
      return { schemas: [SCIM_LIST_SCHEMA], totalResults: all.length, startIndex: start, itemsPerPage: rows.length, Resources: resources };
    });
  }

  async get(id: string, base: string) {
    return this.db.tenant(async (tx) => this.resource(tx, await this.load(tx, id), base));
  }

  async create(input: ScimGroupInput, base: string) {
    return this.db.tenant(async (tx) => {
      if (await nameTaken(tx, input.displayName)) throw new ScimError(409, 'uniqueness', 'A group with this displayName already exists');
      if (input.externalId && (await tx.collection('scim_groups').exists({ external_id: input.externalId }))) throw new ScimError(409, 'uniqueness', 'A group with this externalId already exists');
      const ids = await this.memberIds(tx, (input.members ?? []).map((m) => m.value));
      const g = await tx.collection<GroupRow>('scim_groups').insert({ display_name: input.displayName, external_id: input.externalId ?? null });
      if (ids.length) await tx.collection('scim_group_members').insertMany(ids.map((membership_id) => ({ group_id: g.id, membership_id })));
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
    tx: TenantTx, g: GroupRow,
    p: { displayName?: string; externalId?: string | null; add: string[]; remove: string[]; replace?: string[] },
    method: string, ignored: string[] = [],
  ) {
    if (p.displayName && p.displayName.toLowerCase() !== g.display_name.toLowerCase() && (await nameTaken(tx, p.displayName, g.id))) {
      throw new ScimError(409, 'uniqueness', 'Another group has this displayName');
    }
    if (p.externalId && p.externalId !== g.external_id && (await tx.collection('scim_groups').exists({ external_id: p.externalId, id: { $ne: g.id } }))) {
      throw new ScimError(409, 'uniqueness', 'Another group has this externalId');
    }
    const links = tx.collection('scim_group_members');
    const before = await this.memberships(tx, g.id);
    await tx.collection('scim_groups').updateOne({ id: g.id }, { $set: { display_name: p.displayName ?? g.display_name, external_id: p.externalId === undefined ? g.external_id : p.externalId } });
    if (p.replace) await links.delete({ group_id: g.id, membership_id: { $nin: p.replace } });
    if (p.remove.length) await links.delete({ group_id: g.id, membership_id: { $in: p.remove } });
    const present = new Set(p.replace ? before.filter((x) => p.replace!.includes(x) && !p.remove.includes(x)) : before.filter((x) => !p.remove.includes(x)));
    const toAdd = [...new Set([...(p.replace ?? []), ...p.add])].filter((x) => !present.has(x));
    if (toAdd.length) await links.insertMany(toAdd.map((membership_id) => ({ group_id: g.id, membership_id })));
    const after = await this.memberships(tx, g.id);
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
      const members = await this.memberships(tx, g.id);
      await tx.collection('scim_groups').deleteOne({ id: g.id });
      await this.syncRoles(tx, members);
      await this.audit.record(tx, { action: 'scim_group.deleted', resourceType: 'scim_group', resourceId: g.id, changes: { displayName: g.display_name, members: members.length } });
      await this.log(tx, 'DELETE', `/Groups/${g.id}`, 204, g.display_name);
    });
  }

  // Owners map groups to roles in Settings ---------------------------------------------------------------------------

  async overview(inTx?: TenantTx) {
    const read = async (tx: TenantTx) => {
      const groups = await tx.collection<GroupRow>('scim_groups').find({});
      const roles = new Map((await tx.collection('roles').find({ id: { $in: groups.map((g) => g.role_id).filter(Boolean) } })).map((r) => [r.id as string, r]));
      const counts = await countBy(tx, 'scim_group_members', 'group_id', groups.map((g) => g.id));
      return groups
        .map((g) => {
          const r = g.role_id ? roles.get(g.role_id) : undefined;
          return {
            id: g.id,
            displayName: g.display_name,
            externalId: g.external_id ?? null,
            updatedAt: g.updated_at,
            roleId: r?.id ?? null,
            roleKey: r?.key ?? null,
            roleName: r?.name ?? null,
            memberCount: counts.get(g.id) ?? 0,
          };
        })
        .sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
    };
    return inTx ? read(inTx) : this.db.tenant(read);
  }

  async setRole(groupId: string, roleId: string | null) {
    return this.db.tenant(async (tx) => {
      const g = await tx.collection<GroupRow>('scim_groups').findOne({ id: groupId });
      if (!g) throw Errors.notFound('Provisioning group');
      let role: { id: string; key: string; name: string } | null = null;
      if (roleId) {
        const r = await tx.collection('roles').findOne({ id: roleId });
        role = r ? { id: r.id, key: r.key, name: r.name } : null;
        if (!role) throw Errors.notFound('Role');
        if ((SCIM_UNMAPPABLE_ROLES as readonly string[]).includes(role.key)) {
          throw Errors.badRequest('role_not_mappable', 'A provisioning group cannot grant the owner role. Owners are added by another owner in SampCrew.');
        }
      }
      if ((g.role_id ?? null) === (role?.id ?? null)) return this.overview(tx);
      await tx.collection('scim_groups').updateOne({ id: g.id }, { $set: { role_id: role?.id ?? null } });
      const members = await this.memberships(tx, g.id);
      const changed = await this.syncRoles(tx, members);
      await this.audit.record(tx, {
        action: 'scim_group.role_mapped', resourceType: 'scim_group', resourceId: g.id,
        changes: { displayName: g.display_name, role: role?.key ?? null, previousRoleId: g.role_id, membersChanged: changed.length },
      });
      return this.overview(tx);
    });
  }
}

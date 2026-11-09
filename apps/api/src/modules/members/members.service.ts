import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { assignRolesRequest, inviteMemberRequest, PaginationQuery, updateMemberRequest } from '@crew/contracts';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { hashPassword, randomToken, sha256 } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { decodeCursor, page } from '../../platform/http/pagination';
import { MailerService } from '../../platform/notify/mailer.service';
import { NotificationService } from '../../platform/notify/notification.service';

const INVITE_TTL_DAYS = 7;

const SCOPE_FIELDS = { membershipId: '_id', legalEntityId: 'legal_entity_id', departmentId: 'department_id', locationId: 'location_id' };

export interface MemberView {
  id: string;
  status: string;
  title: string | null;
  userId: string;
  fullName: string;
  email: string;
  mfaEnabled: boolean;
  legalEntityId: string | null;
  legalEntityName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  locationId: string | null;
  locationName: string | null;
  managerMembershipId: string | null;
  managerName: string | null;
  joinedAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  roles: { key: string; name: string; constraints: unknown }[];
}

/** Members as the API shows them: the membership with its person, placement, manager and roles (one query per table). */
export async function memberViews(tx: TenantTx, memberships: Row[]): Promise<MemberView[]> {
  if (!memberships.length) return [];
  const managers = await tx.collection('memberships').find({ id: { $in: memberships.map((m) => m.manager_membership_id).filter(Boolean) } }, { projection: { user_id: 1 } });
  const userIds = [...new Set([...memberships.map((m) => m.user_id), ...managers.map((m) => m.user_id)])];
  const users = byId(await (await tx.users()).find({ id: { $in: userIds } }));
  const names = async (table: string, field: string) => byId(await tx.collection(table).find({ id: { $in: [...new Set(memberships.map((m) => m[field]).filter(Boolean))] } }, { projection: { name: 1 } }));
  const entities = await names('legal_entities', 'legal_entity_id');
  const departments = await names('departments', 'department_id');
  const locations = await names('locations', 'location_id');
  const managerUser = new Map(managers.map((m) => [m.id as string, users.get(m.user_id)]));
  const assignments = await tx.collection('role_assignments').find({ membership_id: { $in: memberships.map((m) => m.id) } });
  const roles = byId(await tx.collection('roles').find({ id: { $in: [...new Set(assignments.map((a) => a.role_id))] } }));
  return memberships.map((m) => {
    const u = users.get(m.user_id) ?? {};
    return {
      id: m.id,
      status: m.status,
      title: m.title ?? null,
      userId: m.user_id,
      fullName: u.full_name,
      email: u.email,
      mfaEnabled: !!u.mfa_enabled,
      legalEntityId: m.legal_entity_id ?? null,
      legalEntityName: entities.get(m.legal_entity_id)?.name ?? null,
      departmentId: m.department_id ?? null,
      departmentName: departments.get(m.department_id)?.name ?? null,
      locationId: m.location_id ?? null,
      locationName: locations.get(m.location_id)?.name ?? null,
      managerMembershipId: m.manager_membership_id ?? null,
      managerName: managerUser.get(m.manager_membership_id)?.full_name ?? null,
      joinedAt: m.joined_at ?? null,
      createdAt: m.created_at,
      lastLoginAt: u.last_login_at ?? null,
      roles: assignments
        .filter((a) => a.membership_id === m.id && roles.has(a.role_id))
        .map((a) => ({ key: roles.get(a.role_id)!.key, name: roles.get(a.role_id)!.name, constraints: a.constraints ?? {} }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    };
  });
}

function byId(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((r) => [r.id as string, r]));
}

@Injectable()
export class MembersService {
  private readonly logger = new Logger('Members');

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
    private readonly mailer: MailerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Lists members the caller may see. ABAC scope is pushed into SQL so pagination stays correct. */
  async list(q: PaginationQuery & { status?: string; departmentId?: string }) {
    return this.db.tenant(async (tx) => {
      const filter: Row = { $and: [await this.authz.filter('users:read', SCOPE_FIELDS, tx)] };
      if (q.status) filter.status = q.status;
      if (q.departmentId) filter.department_id = q.departmentId;
      // Names live on the person, not the membership: filter and order the workspace's members in memory.
      let rows = await memberViews(tx, await tx.collection('memberships').find(filter));
      if (q.q) {
        const needle = q.q.toLowerCase();
        rows = rows.filter((m) => [m.fullName, m.email, m.title ?? ''].some((v) => v.toLowerCase().includes(needle)));
      }
      const key = (m: MemberView) => m.fullName.toLowerCase();
      rows.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      const cursor = decodeCursor(q.cursor);
      if (cursor) rows = rows.filter((m) => key(m) > cursor[0] || (key(m) === cursor[0] && m.id > cursor[1]));
      return page(rows.slice(0, q.limit + 1), q.limit, key);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const row = await this.load(tx, id);
      await this.authz.require('users:read', attrs(row), tx);
      return row;
    });
  }

  async invite(input: z.infer<typeof inviteMemberRequest>) {
    const result = await this.db.tenant(async (tx) => {
      const { membershipId, token } = await this.createInvitation(tx, input);
      return { member: await this.load(tx, membershipId), token };
    });
    return { member: result.member, ...(await this.inviteResult(result.token)) };
  }

  /**
   * Creates the user (if new), an invited membership with the Employee baseline plus the chosen roles, and an
   * invitation whose email is queued in the same transaction. Used by member invites and by hiring.
   */
  async createInvitation(tx: TenantTx, input: z.infer<typeof inviteMemberRequest>): Promise<{ membershipId: string; token: string }> {
    const actor = requestContext.tenantActor();
    const token = randomToken(32);
    const count = await tx.collection('memberships').count({ status: { $ne: 'suspended' } });
    await this.entitlements.requireWithinLimit('max_employees', count, tx);
    // Everyone gets the Employee self-service baseline in addition to the roles chosen.
    const roles = await this.resolveRoles(tx, [...new Set(['employee', ...input.roleKeys])]);
    await this.assertCanGrant(tx, roles.map((r) => r.key));

    const legalEntityId = input.legalEntityId ?? (await tx.collection('legal_entities').findOne({ archived_at: null }, { sort: { created_at: 1 } }))?.id ?? null;
    // Identities are global: the user is found or created outside the workspace, in this same transaction.
    const users = tx.unscoped('users');
    const existing = await users.findOne({ email: input.email }, { projection: { _id: 1 } });
    const userId = (existing ?? (await users.insert({ email: input.email, full_name: input.fullName }))).id as string;
    const already = await tx.collection('memberships').exists({ user_id: userId });
    if (already) throw Errors.conflict('already_member', 'This person is already a member of the workspace');

    const membership = await tx.collection('memberships').insert({
      user_id: userId,
      status: 'invited',
      legal_entity_id: legalEntityId,
      department_id: input.departmentId ?? null,
      location_id: input.locationId ?? null,
      manager_membership_id: input.managerMembershipId ?? null,
      invited_by: actor.membershipId,
    });
    await tx.collection('role_assignments').insertMany(roles.map((r) => ({ membership_id: membership.id, role_id: r.id, granted_by: actor.membershipId })));
    await tx.collection('invitations').insert({ membership_id: membership.id, email: input.email, token_hash: sha256(token), expires_at: inDays(INVITE_TTL_DAYS), invited_by: actor.membershipId });
    await this.queueInviteEmail(tx, input.email, token);
    await this.audit.record(tx, { action: 'membership.invited', resourceType: 'membership', resourceId: membership.id, changes: { email: input.email, roles: input.roleKeys } });
    await this.outbox.publish(tx, actor.tenantId, 'membership.invited', { membershipId: membership.id, email: input.email });
    return { membershipId: membership.id, token };
  }

  /**
   * Creates a working login straight away, for HR adding someone who should sign in today (for example at an
   * attendance kiosk or on a shared phone) rather than wait for an invitation email. The password is temporary:
   * the person must replace it at their first sign-in. An email that already has a SampCrew account cannot be given a
   * password by HR; that person joins through an invitation instead.
   */
  async createLoginWithPassword(tx: TenantTx, input: z.infer<typeof inviteMemberRequest>, temporaryPassword: string): Promise<{ membershipId: string }> {
    const actor = requestContext.tenantActor();
    const count = await tx.collection('memberships').count({ status: { $ne: 'suspended' } });
    await this.entitlements.requireWithinLimit('max_employees', count, tx);
    const roles = await this.resolveRoles(tx, [...new Set(['employee', ...input.roleKeys])]);
    await this.assertCanGrant(tx, roles.map((r) => r.key));
    const legalEntityId = input.legalEntityId ?? (await tx.collection('legal_entities').findOne({ archived_at: null }, { sort: { created_at: 1 } }))?.id ?? null;
    const hash = await hashPassword(temporaryPassword);
    const users = tx.unscoped('users');
    const userId = await (async () => {
      if (await users.exists({ email: input.email })) {
        throw Errors.conflict('account_exists', 'This email already has a SampCrew account, so HR cannot set its password. Send an invitation instead and they join with their own password.');
      }
      return (await users.insert({ email: input.email, full_name: input.fullName, password_hash: hash, must_change_password: true })).id as string;
    })();
    const membership = await tx.collection('memberships').insert({
      user_id: userId,
      status: 'active',
      legal_entity_id: legalEntityId,
      department_id: input.departmentId ?? null,
      location_id: input.locationId ?? null,
      manager_membership_id: input.managerMembershipId ?? null,
      invited_by: actor.membershipId,
      joined_at: new Date(),
    });
    await tx.collection('role_assignments').insertMany(roles.map((r) => ({ membership_id: membership.id, role_id: r.id, granted_by: actor.membershipId })));
    const workspace = (await tx.collection('tenants').findOne({}))!;
    // The password itself is never emailed: HR hands it over in person.
    await this.notifications.queueEmail(
      tx,
      actor.tenantId,
      input.email,
      `Your SampCrew login for ${workspace.name}`,
      `${actor.label} created your SampCrew login for ${workspace.name}.\n\nSign in at ${this.config.WEB_PUBLIC_URL}/login with this email and the temporary password HR gave you. You will choose your own password the first time you sign in.`,
      'login_created',
    );
    await this.audit.record(tx, { action: 'membership.login_created', resourceType: 'membership', resourceId: membership.id, changes: { email: input.email, roles: input.roleKeys, temporaryPassword: true } });
    await this.outbox.publish(tx, actor.tenantId, 'membership.created', { membershipId: membership.id, email: input.email });
    return { membershipId: membership.id };
  }

  private async queueInviteEmail(tx: TenantTx, email: string, token: string) {
    const actor = requestContext.tenantActor();
    const workspace = (await tx.collection('tenants').findOne({}))!;
    await this.notifications.queueEmail(
      tx,
      actor.tenantId,
      email,
      `You're invited to ${workspace.name} on SampCrew`,
      `${actor.label} invited you to join ${workspace.name} on SampCrew.\n\nAccept the invitation and set your password: ${this.config.WEB_PUBLIC_URL}/accept-invite?token=${token}\n\nThe link expires in ${INVITE_TTL_DAYS} days.`,
      'invitation',
    );
  }

  /** Outside staging/production the link is also returned so the flow can be tested without a mail server. */
  private async inviteResult(token: string) {
    const inviteUrl = `${this.config.WEB_PUBLIC_URL}/accept-invite?token=${token}`;
    if (!this.config.isProductionLike) this.logger.log(`Invitation link: ${inviteUrl}`);
    return { inviteUrl: this.config.isProductionLike ? undefined : inviteUrl, delivery: (await this.mailer.isConfigured()) ? ('email_queued' as const) : ('email_not_configured' as const) };
  }

  async update(id: string, input: z.infer<typeof updateMemberRequest>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const before = await this.load(tx, id);
      await this.authz.require('users:manage', attrs(before), tx);
      if (input.status === 'suspended' && id === actor.membershipId) throw Errors.badRequest('cannot_suspend_self', 'You cannot suspend yourself');
      if (input.status === 'suspended') await this.assertNotLastOwner(tx, id);
      const map: Record<string, string> = { departmentId: 'department_id', legalEntityId: 'legal_entity_id', locationId: 'location_id', managerMembershipId: 'manager_membership_id', status: 'status' };
      const entries = Object.entries(input).filter(([k, v]) => map[k] && v !== undefined);
      const linked = await tx.collection('employees').exists({ membership_id: id });
      if (linked && ['departmentId', 'legalEntityId', 'locationId', 'managerMembershipId'].some((k) => input[k as keyof typeof input] !== undefined)) {
        throw Errors.conflict('placement_on_employee', 'This member has an employee record. Change their placement there so the job history is kept.');
      }
      if (input.status && before.status === 'invited') throw Errors.badRequest('invite_pending', 'This person has not accepted their invitation yet');
      if (entries.length) await tx.collection('memberships').updateOne({ id }, { $set: Object.fromEntries(entries.map(([k, v]) => [map[k]!, v])) });
      const after = await this.load(tx, id);
      // The new placement must also be within the caller's scope (cannot move someone out of reach).
      await this.authz.require('users:manage', attrs(after), tx);
      const changes = diff(before as unknown as Record<string, unknown>, Object.fromEntries(entries.map(([k]) => [k, after[k as keyof typeof after]])));
      if (input.status === 'suspended') {
        await this.db.platform((ptx) => ptx.collection('sessions').update({ user_id: before.userId, tenant_id: actor.tenantId, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'membership_suspended' } }));
      }
      await this.audit.record(tx, { action: input.status === 'suspended' ? 'membership.suspended' : 'membership.updated', resourceType: 'membership', resourceId: id, changes });
      await this.outbox.publish(tx, actor.tenantId, 'membership.changed', { membershipId: id, fields: Object.keys(changes) });
      return after;
    });
  }

  async setRoles(id: string, input: z.infer<typeof assignRolesRequest>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const member = await this.load(tx, id);
      const roles = await this.resolveRoles(tx, input.assignments.map((a) => a.roleKey));
      await this.assertCanGrant(tx, roles.map((r) => r.key));
      const beforeKeys = member.roles.map((r) => r.key).sort();
      if (beforeKeys.includes('tenant_owner') && !roles.some((r) => r.key === 'tenant_owner')) await this.assertNotLastOwner(tx, id);
      if (id === actor.membershipId && beforeKeys.includes('tenant_owner') && !roles.some((r) => r.key === 'tenant_owner')) {
        throw Errors.badRequest('cannot_demote_self', 'Ask another owner to remove your owner role');
      }
      // Roles that come from a provisioning group stay while the person is in the group; the identity provider
      // manages those. Everything else is replaced by what was sent.
      await tx.collection('role_assignments').delete({ membership_id: id, source: 'manual' });
      for (const a of input.assignments) {
        const role = roles.find((r) => r.key === a.roleKey)!;
        const fields = { constraints: a.constraints ?? {}, granted_by: actor.membershipId };
        await tx.collection('role_assignments').upsert({ membership_id: id, role_id: role.id }, { membership_id: id, role_id: role.id, ...fields }, { $set: fields });
      }
      const after = await this.load(tx, id);
      await this.audit.record(tx, {
        action: 'membership.roles_changed', resourceType: 'membership', resourceId: id,
        changes: { roles: { from: beforeKeys, to: input.assignments.map((a) => a.roleKey).sort() }, constraints: input.assignments.filter((a) => a.constraints) },
      });
      await this.outbox.publish(tx, actor.tenantId, 'membership.roles_changed', { membershipId: id });
      return after;
    });
  }

  /** Re-issues an invitation link (previous links stop working). */
  async resendInvite(id: string) {
    const actor = requestContext.tenantActor();
    const token = randomToken(32);
    await this.db.tenant(async (tx) => {
      const m = await this.load(tx, id);
      if (m.status !== 'invited') throw Errors.badRequest('not_invited', 'This member has already joined');
      await tx.collection('invitations').update({ membership_id: id, accepted_at: null, revoked_at: null }, { $set: { revoked_at: new Date() } });
      await tx.collection('invitations').insert({ membership_id: id, email: m.email, token_hash: sha256(token), expires_at: inDays(INVITE_TTL_DAYS), invited_by: actor.membershipId });
      await this.queueInviteEmail(tx, m.email, token);
      await this.audit.record(tx, { action: 'membership.invite_resent', resourceType: 'membership', resourceId: id });
    });
    return this.inviteResult(token);
  }

  private async load(tx: TenantTx, id: string): Promise<MemberView> {
    const m = await tx.collection('memberships').findOne({ id });
    if (!m) throw Errors.notFound('Member');
    return (await memberViews(tx, [m]))[0]!;
  }

  private async resolveRoles(tx: TenantTx, keys: string[]) {
    const roles = (await tx.collection('roles').find({ key: { $in: keys } })).map((r) => ({ id: r.id as string, key: r.key as string }));
    const missing = keys.filter((k) => !roles.some((r) => r.key === k));
    if (missing.length) throw Errors.badRequest('unknown_role', `Unknown role: ${missing.join(', ')}`);
    return roles;
  }

  /** Prevents privilege escalation: only owners can grant the owner role, and roles:manage is needed for anything else. */
  private async assertCanGrant(tx: TenantTx, roleKeys: string[]) {
    const subject = await this.authz.subject(tx);
    const isOwner = subject.grants.some((g) => g.roleKey === 'tenant_owner');
    if (roleKeys.includes('tenant_owner') && !isOwner) throw Errors.forbidden('Only a workspace owner can grant the owner role');
    if (roleKeys.some((k) => k !== 'employee')) await this.authz.require('roles:manage', undefined, tx);
  }

  private async assertNotLastOwner(tx: TenantTx, membershipId: string) {
    const owner = await tx.collection('roles').findOne({ key: 'tenant_owner' });
    const holders = owner ? (await tx.collection('role_assignments').find({ role_id: owner.id })).map((a) => a.membership_id) : [];
    const owners = await tx.collection('memberships').find({ id: { $in: holders }, status: 'active' }, { projection: { _id: 1 } });
    if (owners.length === 1 && owners[0]!.id === membershipId) throw Errors.conflict('last_owner', 'A workspace needs at least one active owner');
  }
}

function attrs(row: { id: string; legalEntityId: string | null; departmentId: string | null; locationId: string | null }) {
  return { membershipId: row.id, legalEntityId: row.legalEntityId, departmentId: row.departmentId, locationId: row.locationId };
}

function inDays(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

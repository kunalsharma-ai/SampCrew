import { Inject, Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import type { assignRolesRequest, inviteMemberRequest, PaginationQuery, updateMemberRequest } from '@crew/contracts';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { randomToken, sha256 } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { decodeCursor, page } from '../../platform/http/pagination';
import { MailerService } from '../../platform/notify/mailer.service';
import { NotificationService } from '../../platform/notify/notification.service';

const INVITE_TTL_DAYS = 7;

const MEMBER_COLUMNS = `m.id, m.status, m.title, u.id as "userId", u.full_name as "fullName", u.email::text as email, u.mfa_enabled as "mfaEnabled",
  m.legal_entity_id as "legalEntityId", le.name as "legalEntityName", m.department_id as "departmentId", d.name as "departmentName",
  m.location_id as "locationId", l.name as "locationName", m.manager_membership_id as "managerMembershipId", mu.full_name as "managerName",
  m.joined_at as "joinedAt", m.created_at as "createdAt", u.last_login_at as "lastLoginAt",
  coalesce((select json_agg(json_build_object('key', r.key, 'name', r.name, 'constraints', ra.constraints) order by r.name)
              from role_assignments ra join roles r on r.id = ra.role_id where ra.membership_id = m.id), '[]') as roles`;

const MEMBER_FROM = `from memberships m
  join users u on u.id = m.user_id
  left join legal_entities le on le.id = m.legal_entity_id
  left join departments d on d.id = m.department_id
  left join locations l on l.id = m.location_id
  left join memberships mm on mm.id = m.manager_membership_id
  left join users mu on mu.id = mm.user_id`;

const SCOPE_COLS = { membershipId: 'm.id', legalEntityId: 'm.legal_entity_id', departmentId: 'm.department_id', locationId: 'm.location_id' };

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
      const params: unknown[] = [];
      const where = [await this.authz.predicate('users:read', SCOPE_COLS, params, tx)];
      if (q.q) {
        params.push(`%${q.q.toLowerCase()}%`);
        where.push(`(lower(u.full_name) like $${params.length} or lower(u.email) like $${params.length} or lower(coalesce(m.title, '')) like $${params.length})`);
      }
      if (q.status) {
        params.push(q.status);
        where.push(`m.status = $${params.length}`);
      }
      if (q.departmentId) {
        params.push(q.departmentId);
        where.push(`m.department_id = $${params.length}`);
      }
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        params.push(cursor[0], cursor[1]);
        where.push(`(lower(u.full_name), m.id) > ($${params.length - 1}, $${params.length}::uuid)`);
      }
      params.push(q.limit + 1);
      const rows = await many<{ id: string; fullName: string }>(
        tx,
        `select ${MEMBER_COLUMNS} ${MEMBER_FROM} where ${where.join(' and ')} order by lower(u.full_name), m.id limit $${params.length}`,
        params,
      );
      return page(rows, q.limit, (r) => r.fullName.toLowerCase());
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
    return { member: result.member, ...this.inviteResult(result.token) };
  }

  /**
   * Creates the user (if new), an invited membership with the Employee baseline plus the chosen roles, and an
   * invitation whose email is queued in the same transaction. Used by member invites and by hiring.
   */
  async createInvitation(tx: Tx, input: z.infer<typeof inviteMemberRequest>): Promise<{ membershipId: string; token: string }> {
    const actor = requestContext.tenantActor();
    const token = randomToken(32);
    const { count } = (await one<{ count: number }>(tx, `select count(*)::int as count from memberships where status <> 'suspended'`))!;
    await this.entitlements.requireWithinLimit('max_employees', count, tx);
    // Everyone gets the Employee self-service baseline in addition to the roles chosen.
    const roles = await this.resolveRoles(tx, [...new Set(['employee', ...input.roleKeys])]);
    await this.assertCanGrant(tx, roles.map((r) => r.key));

    const legalEntityId = input.legalEntityId ?? (await one<{ id: string }>(tx, 'select id from legal_entities where archived_at is null order by created_at limit 1'))?.id ?? null;
    // Identities are global; creating or finding the user row needs the platform role.
    const userId = await this.db.platform(async (ptx) => {
      const existing = await one<{ id: string }>(ptx, 'select id from users where email = $1', [input.email]);
      if (existing) return existing.id;
      return (await one<{ id: string }>(ptx, `insert into users (email, full_name) values ($1, $2) returning id`, [input.email, input.fullName]))!.id;
    });
    const already = await one(tx, 'select 1 from memberships where user_id = $1', [userId]);
    if (already) throw Errors.conflict('already_member', 'This person is already a member of the workspace');

    const membership = (await one<{ id: string }>(
      tx,
      `insert into memberships (tenant_id, user_id, status, legal_entity_id, department_id, location_id, manager_membership_id, title, invited_by)
       values ($1, $2, 'invited', $3, $4, $5, $6, null, $7) returning id`,
      [actor.tenantId, userId, legalEntityId, input.departmentId ?? null, input.locationId ?? null, input.managerMembershipId ?? null, actor.membershipId],
    ))!;
    for (const r of roles) {
      await tx.query('insert into role_assignments (tenant_id, membership_id, role_id, granted_by) values ($1, $2, $3, $4)', [actor.tenantId, membership.id, r.id, actor.membershipId]);
    }
    await tx.query(
      `insert into invitations (tenant_id, membership_id, email, token_hash, expires_at, invited_by) values ($1, $2, $3, $4, now() + make_interval(days => $5), $6)`,
      [actor.tenantId, membership.id, input.email, sha256(token), INVITE_TTL_DAYS, actor.membershipId],
    );
    await this.queueInviteEmail(tx, input.email, token);
    await this.audit.record(tx, { action: 'membership.invited', resourceType: 'membership', resourceId: membership.id, changes: { email: input.email, roles: input.roleKeys } });
    await this.outbox.publish(tx, actor.tenantId, 'membership.invited', { membershipId: membership.id, email: input.email });
    return { membershipId: membership.id, token };
  }

  private async queueInviteEmail(tx: Tx, email: string, token: string) {
    const actor = requestContext.tenantActor();
    const workspace = (await one<{ name: string }>(tx, 'select name from tenants where id = app_tenant_id()'))!;
    await this.notifications.queueEmail(
      tx,
      actor.tenantId,
      email,
      `You're invited to ${workspace.name} on CREW`,
      `${actor.label} invited you to join ${workspace.name} on CREW.\n\nAccept the invitation and set your password: ${this.config.WEB_PUBLIC_URL}/accept-invite?token=${token}\n\nThe link expires in ${INVITE_TTL_DAYS} days.`,
      'invitation',
    );
  }

  /** Outside staging/production the link is also returned so the flow can be tested without a mail server. */
  private inviteResult(token: string) {
    const inviteUrl = `${this.config.WEB_PUBLIC_URL}/accept-invite?token=${token}`;
    if (!this.config.isProductionLike) this.logger.log(`Invitation link: ${inviteUrl}`);
    return { inviteUrl: this.config.isProductionLike ? undefined : inviteUrl, delivery: this.mailer.configured ? ('email_queued' as const) : ('email_not_configured' as const) };
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
      const linked = await one(tx, 'select 1 from employees where membership_id = $1', [id]);
      if (linked && ['departmentId', 'legalEntityId', 'locationId', 'managerMembershipId'].some((k) => input[k as keyof typeof input] !== undefined)) {
        throw Errors.conflict('placement_on_employee', 'This member has an employee record. Change their placement there so the job history is kept.');
      }
      if (input.status && before.status === 'invited') throw Errors.badRequest('invite_pending', 'This person has not accepted their invitation yet');
      if (entries.length) await tx.query(`update memberships set ${entries.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')} where id = $1`, [id, ...entries.map(([, v]) => v)]);
      const after = await this.load(tx, id);
      // The new placement must also be within the caller's scope (cannot move someone out of reach).
      await this.authz.require('users:manage', attrs(after), tx);
      const changes = diff(before, Object.fromEntries(entries.map(([k]) => [k, after[k as keyof typeof after]])));
      if (input.status === 'suspended') {
        await this.db.platform((ptx) => ptx.query(`update sessions set revoked_at = now(), revoked_reason = 'membership_suspended' where user_id = $1 and tenant_id = $2 and revoked_at is null`, [before.userId, actor.tenantId]));
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
      const beforeKeys = (member.roles as { key: string }[]).map((r) => r.key).sort();
      if (beforeKeys.includes('tenant_owner') && !roles.some((r) => r.key === 'tenant_owner')) await this.assertNotLastOwner(tx, id);
      if (id === actor.membershipId && beforeKeys.includes('tenant_owner') && !roles.some((r) => r.key === 'tenant_owner')) {
        throw Errors.badRequest('cannot_demote_self', 'Ask another owner to remove your owner role');
      }
      await tx.query('delete from role_assignments where membership_id = $1', [id]);
      for (const a of input.assignments) {
        const role = roles.find((r) => r.key === a.roleKey)!;
        await tx.query('insert into role_assignments (tenant_id, membership_id, role_id, constraints, granted_by) values ($1, $2, $3, $4, $5)', [
          actor.tenantId, id, role.id, JSON.stringify(a.constraints ?? {}), actor.membershipId,
        ]);
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
      await tx.query('update invitations set revoked_at = now() where membership_id = $1 and accepted_at is null and revoked_at is null', [id]);
      await tx.query(
        `insert into invitations (tenant_id, membership_id, email, token_hash, expires_at, invited_by) values ($1, $2, $3, $4, now() + make_interval(days => $5), $6)`,
        [actor.tenantId, id, m.email, sha256(token), INVITE_TTL_DAYS, actor.membershipId],
      );
      await this.queueInviteEmail(tx, m.email, token);
      await this.audit.record(tx, { action: 'membership.invite_resent', resourceType: 'membership', resourceId: id });
    });
    return this.inviteResult(token);
  }

  private async load(tx: Tx, id: string) {
    const row = await one<{ id: string; status: string; userId: string; email: string; roles: unknown; legalEntityId: string | null; departmentId: string | null; locationId: string | null }>(
      tx,
      `select ${MEMBER_COLUMNS} ${MEMBER_FROM} where m.id = $1 and m.tenant_id = app_tenant_id()`,
      [id],
    );
    if (!row) throw Errors.notFound('Member');
    return row;
  }

  private async resolveRoles(tx: Tx, keys: string[]) {
    const roles = await many<{ id: string; key: string }>(tx, 'select id, key from roles where key = any($1::text[])', [keys]);
    const missing = keys.filter((k) => !roles.some((r) => r.key === k));
    if (missing.length) throw Errors.badRequest('unknown_role', `Unknown role: ${missing.join(', ')}`);
    return roles;
  }

  /** Prevents privilege escalation: only owners can grant the owner role, and roles:manage is needed for anything else. */
  private async assertCanGrant(tx: Tx, roleKeys: string[]) {
    const subject = await this.authz.subject(tx);
    const isOwner = subject.grants.some((g) => g.roleKey === 'tenant_owner');
    if (roleKeys.includes('tenant_owner') && !isOwner) throw Errors.forbidden('Only a workspace owner can grant the owner role');
    if (roleKeys.some((k) => k !== 'employee')) await this.authz.require('roles:manage', undefined, tx);
  }

  private async assertNotLastOwner(tx: Tx, membershipId: string) {
    const owners = await many<{ membership_id: string }>(
      tx,
      `select ra.membership_id from role_assignments ra join roles r on r.id = ra.role_id join memberships m on m.id = ra.membership_id
        where r.key = 'tenant_owner' and m.status = 'active'`,
    );
    if (owners.length === 1 && owners[0]!.membership_id === membershipId) throw Errors.conflict('last_owner', 'A workspace needs at least one active owner');
  }
}

function attrs(row: { id: string; legalEntityId: string | null; departmentId: string | null; locationId: string | null }) {
  return { membershipId: row.id, legalEntityId: row.legalEntityId, departmentId: row.departmentId, locationId: row.locationId };
}

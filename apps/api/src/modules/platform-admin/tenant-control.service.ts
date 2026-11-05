import { Inject, Injectable } from '@nestjs/common';
import {
  DEVICE_INTEGRATIONS,
  type ActivityRow,
  type DeviceVendor,
  type MemberAction,
  type WorkspaceUserRow,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { randomToken, sha256 } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { deviceStatus } from '../attendance/devices.service';

const INVITE_TTL_DAYS = 7;

/** Escapes a search term for ILIKE. */
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const USER_COLUMNS = `m.id as "membershipId", u.id as "userId", u.full_name as "fullName", u.email::text as email, m.status, u.status as "accountStatus",
  coalesce((select array_agg(r.name order by r.name) from role_assignments ra join roles r on r.id = ra.role_id where ra.membership_id = m.id), '{}') as roles,
  coalesce(a.blocked_features, '{}') as "blockedFeatures", u.mfa_enabled as "mfaEnabled", u.last_login_at as "lastLoginAt",
  (select max(i.created_at) from invitations i where i.membership_id = m.id) as "invitedAt", m.joined_at as "joinedAt",
  json_build_object(
    'web', (select count(*)::int from sessions s where s.user_id = u.id and s.tenant_id = m.tenant_id and s.client = 'web' and s.revoked_at is null and s.expires_at > now()),
    'mobile', (select count(*)::int from sessions s where s.user_id = u.id and s.tenant_id = m.tenant_id and s.client = 'mobile' and s.revoked_at is null and s.expires_at > now())
  ) as "liveSessions",
  t.id as "tenantId", t.name as "tenantName", t.slug::text as "tenantSlug"`;

/**
 * Everything the SAMPLEDGE Super Admin does to the people, activity and attendance machines of a customer
 * workspace from the Console. Runs with the platform role. It shows account and sign-in details, activity
 * headlines (what happened, who, when, from which app) and machine health, never HR record contents: the
 * before/after values in the audit trail stay behind an approved support grant. Every action is written to both
 * the platform audit log and the customer's own audit trail.
 */
@Injectable()
export class TenantControlService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // -----------------------------------------------------------------------------------------------------------
  // Users
  // -----------------------------------------------------------------------------------------------------------

  /** People in one workspace, or across every workspace when tenantId is left out. */
  async users(q: { q?: string; status?: string; tenantId?: string; limit: number; offset: number }): Promise<{ items: WorkspaceUserRow[]; total: number; summary: Record<string, number> }> {
    return this.db.platform(async (tx) => {
      if (q.tenantId) await this.requireTenant(tx, q.tenantId);
      const params: unknown[] = [];
      const where: string[] = ['true'];
      if (q.tenantId) {
        params.push(q.tenantId);
        where.push(`m.tenant_id = $${params.length}`);
      }
      if (q.q) {
        params.push(like(q.q));
        where.push(`(u.full_name ilike $${params.length} or u.email::text ilike $${params.length} or t.name ilike $${params.length})`);
      }
      const base = `from memberships m join users u on u.id = m.user_id join tenants t on t.id = m.tenant_id left join member_feature_access a on a.membership_id = m.id`;
      const summary = (await one<Record<string, number>>(
        tx,
        `select count(*)::int as total, count(*) filter (where m.status = 'active')::int as active, count(*) filter (where m.status = 'invited')::int as invited,
                count(*) filter (where m.status = 'suspended')::int as suspended, count(*) filter (where u.mfa_enabled)::int as "withMfa",
                count(*) filter (where u.last_login_at > now() - interval '30 days')::int as "signedIn30d"
           ${base} where ${where.join(' and ')}`,
        params,
      ))!;
      if (q.status) {
        params.push(q.status);
        where.push(`m.status = $${params.length}`);
      }
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n ${base} where ${where.join(' and ')}`, params))!.n;
      params.push(q.limit, q.offset);
      const items = await many<WorkspaceUserRow>(
        tx,
        `select ${USER_COLUMNS} ${base} where ${where.join(' and ')}
          order by (m.status = 'active') desc, t.name, u.full_name, m.id limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return { items, total, summary };
    });
  }

  async userAction(tenantId: string, membershipId: string, action: MemberAction, reason: string) {
    const admin = requestContext.platformActor();
    let inviteToken: string | null = null;
    const result = await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const m = await one<{ id: string; user_id: string; status: string; email: string; full_name: string; owner: boolean }>(
        tx,
        `select m.id, m.user_id, m.status, u.email::text as email, u.full_name,
                exists (select 1 from role_assignments ra join roles r on r.id = ra.role_id where ra.membership_id = m.id and r.key = 'tenant_owner') as owner
           from memberships m join users u on u.id = m.user_id where m.id = $1 and m.tenant_id = $2 for update of m`,
        [membershipId, tenantId],
      );
      if (!m) throw Errors.notFound('Member');
      let detail: Record<string, unknown> = {};
      switch (action) {
        case 'suspend': {
          if (m.status !== 'active') throw Errors.badRequest('not_active', m.status === 'invited' ? 'This person has not accepted their invitation yet.' : 'This person is already suspended.');
          if (m.owner) {
            const others = (await one<{ n: number }>(
              tx,
              `select count(distinct ra.membership_id)::int as n from role_assignments ra join roles r on r.id = ra.role_id join memberships x on x.id = ra.membership_id
                where r.tenant_id = $1 and r.key = 'tenant_owner' and x.status = 'active' and x.id <> $2`,
              [tenantId, m.id],
            ))!.n;
            if (!others) throw Errors.badRequest('last_owner', 'This is the workspace\'s only active owner. Suspend the whole workspace instead, or ask the customer to add another owner first.');
          }
          await tx.query(`update memberships set status = 'suspended' where id = $1`, [m.id]);
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, tenantId, 'membership_suspended') };
          break;
        }
        case 'reactivate':
          if (m.status !== 'suspended') throw Errors.badRequest('not_suspended', 'Only suspended people can be reactivated.');
          await tx.query(`update memberships set status = 'active' where id = $1`, [m.id]);
          break;
        case 'sign_out':
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, tenantId, 'signed_out_by_sampledge') };
          break;
        case 'reset_mfa': {
          const u = await one<{ mfa_enabled: boolean }>(tx, 'select mfa_enabled from users where id = $1', [m.user_id]);
          if (!u?.mfa_enabled) throw Errors.badRequest('mfa_not_enabled', 'This person has not set up two-step verification.');
          // The authenticator belongs to the account, which can be in several workspaces, so every session ends.
          await tx.query('update users set mfa_enabled = false, mfa_secret_enc = null where id = $1', [m.user_id]);
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, null, 'mfa_reset_by_sampledge') };
          break;
        }
        case 'resend_invite': {
          if (m.status !== 'invited') throw Errors.badRequest('not_invited', 'This person has already joined.');
          inviteToken = randomToken(32);
          await tx.query('update invitations set revoked_at = now() where membership_id = $1 and accepted_at is null and revoked_at is null', [m.id]);
          await tx.query(
            `insert into invitations (tenant_id, membership_id, email, token_hash, expires_at) values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
            [tenantId, m.id, m.email, sha256(inviteToken), INVITE_TTL_DAYS],
          );
          const ws = (await one<{ name: string }>(tx, 'select name from tenants where id = $1', [tenantId]))!;
          await this.notifications.queueEmail(
            tx, tenantId, m.email, `You're invited to ${ws.name} on CREW`,
            `You have been invited to join ${ws.name} on CREW.\n\nAccept the invitation and set your password: ${this.config.WEB_PUBLIC_URL}/accept-invite?token=${inviteToken}\n\nThe link expires in ${INVITE_TTL_DAYS} days.`,
            'invitation',
          );
          break;
        }
      }
      const changes = { member: m.email, action, reason, ...detail };
      await this.audit.record(tx, { tenantId, action: `membership.${action}_by_sampledge`, resourceType: 'membership', resourceId: m.id, changes, metadata: { by: 'SAMPLEDGE', admin: admin.label } });
      await this.audit.record(tx, { tenantId: null, action: `platform.member_${action}`, resourceType: 'tenant', resourceId: tenantId, changes: { membershipId: m.id, ...changes } });
      return { membershipId: m.id, action, ...detail };
    });
    const inviteUrl = inviteToken && !this.config.isProductionLike ? `${this.config.WEB_PUBLIC_URL}/accept-invite?token=${inviteToken}` : undefined;
    return { ...result, inviteUrl };
  }

  private async endSessions(tx: Tx, userId: string, tenantId: string | null, reason: string) {
    const r = await tx.query(
      `update sessions set revoked_at = now(), revoked_reason = $3 where user_id = $1 and ($2::uuid is null or tenant_id = $2) and revoked_at is null`,
      [userId, tenantId, reason],
    );
    return r.rowCount ?? 0;
  }

  // -----------------------------------------------------------------------------------------------------------
  // Activity
  // -----------------------------------------------------------------------------------------------------------

  /** The customer's audit trail as headlines: what happened, who did it, when, from which app. No record contents. */
  async activity(tenantId: string, q: { q?: string; area?: string; actorType?: string; before?: number; limit: number }) {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const params: unknown[] = [tenantId];
      const where = ['a.tenant_id = $1'];
      if (q.area) {
        params.push(`${q.area}.%`);
        where.push(`a.action like $${params.length}`);
      }
      if (q.actorType) {
        params.push(q.actorType);
        where.push(`a.actor_type = $${params.length}`);
      }
      if (q.q) {
        params.push(like(q.q));
        where.push(`(a.action ilike $${params.length} or a.actor_label ilike $${params.length} or a.resource_type ilike $${params.length})`);
      }
      if (q.before) {
        params.push(q.before);
        where.push(`a.id < $${params.length}`);
      }
      params.push(q.limit + 1);
      const rows = await many<ActivityRow>(
        tx,
        `select a.id::text, a.created_at as "createdAt", a.action, split_part(a.action, '.', 1) as area, a.actor_type as "actorType", a.actor_label as "actorLabel",
                a.resource_type as "resourceType", a.resource_id as "resourceId", a.metadata->>'client' as client, host(a.ip) as ip
           from audit_events a where ${where.join(' and ')} order by a.id desc limit $${params.length}`,
        params,
      );
      const items = rows.slice(0, q.limit);
      const summary = await one(
        tx,
        `select (select count(*)::int from audit_events where tenant_id = $1 and created_at > now() - interval '7 days') as "events7d",
                (select count(*)::int from audit_events where tenant_id = $1 and action = 'auth.login' and metadata->>'client' = 'web' and created_at > now() - interval '30 days') as "webSignIns30d",
                (select count(*)::int from audit_events where tenant_id = $1 and action = 'auth.login' and metadata->>'client' = 'mobile' and created_at > now() - interval '30 days') as "mobileSignIns30d",
                (select count(distinct actor_id)::int from audit_events where tenant_id = $1 and actor_type = 'user' and created_at > now() - interval '7 days') as "activeUsers7d",
                (select count(distinct actor_id)::int from audit_events where tenant_id = $1 and actor_type = 'user' and created_at > now() - interval '30 days') as "activeUsers30d"`,
        [tenantId],
      );
      const areas = await many<{ area: string; n: number }>(
        tx,
        `select split_part(action, '.', 1) as area, count(*)::int as n from audit_events where tenant_id = $1 and created_at > now() - interval '30 days'
          group by 1 order by n desc, area limit 12`,
        [tenantId],
      );
      return { items, nextBefore: rows.length > q.limit ? Number(items[items.length - 1]!.id) : null, summary, areas };
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // Attendance machines
  // -----------------------------------------------------------------------------------------------------------

  /** Machines in one workspace, or every workspace. Status as the workspace sees it, plus SAMPLEDGE's pause. */
  async devices(q: { q?: string; tenantId?: string; status?: string }) {
    return this.db.platform(async (tx) => {
      if (q.tenantId) await this.requireTenant(tx, q.tenantId);
      const params: unknown[] = [];
      const where = ['d.archived_at is null'];
      if (q.tenantId) {
        params.push(q.tenantId);
        where.push(`d.tenant_id = $${params.length}`);
      }
      if (q.q) {
        params.push(like(q.q));
        where.push(`(d.name ilike $${params.length} or d.serial_number ilike $${params.length} or t.name ilike $${params.length} or d.model ilike $${params.length})`);
      }
      const rows = await many<{ simulated: boolean; last_seen_at: Date | null; last_error_at: Date | null; expected_interval_seconds: number; pausedAt: string | null; vendor: string; integrationOn: boolean }>(
        tx,
        `select d.id, d.name, d.vendor, d.model, d.serial_number as "serialNumber", d.protocol, d.simulated, d.firmware, l.name as "locationName",
                d.last_seen_at as "lastSeenAt", d.last_punch_at as "lastPunchAt", d.last_error as "lastError", d.records_accepted::int as "recordsAccepted",
                d.records_rejected::int as "recordsRejected", d.paused_at as "pausedAt", d.paused_reason as "pausedReason", d.created_at as "createdAt",
                not (d.vendor = any(coalesce(c.device_vendors_disabled, '{}'))) as "integrationOn",
                (select count(*)::int from attendance_events ev where ev.device_id = d.id and ev.captured_at > now() - interval '7 days') as "punches7d",
                t.id as "tenantId", t.name as "tenantName", t.slug::text as "tenantSlug",
                d.last_seen_at as last_seen_at, d.last_error_at as last_error_at, d.expected_interval_seconds
           from attendance_devices d join tenants t on t.id = d.tenant_id join locations l on l.id = d.location_id
           left join tenant_access_controls c on c.tenant_id = d.tenant_id
          where ${where.join(' and ')} order by t.name, d.name`,
        params,
      );
      const items = rows.map(({ last_seen_at, last_error_at, expected_interval_seconds, ...r }) => ({
        ...r,
        status: r.pausedAt || !r.integrationOn ? ('paused' as const) : deviceStatus({ simulated: r.simulated, last_seen_at, last_error_at, expected_interval_seconds }),
      }));
      const filtered = q.status ? items.filter((d) => d.status === q.status) : items;
      const counts = items.reduce<Record<string, number>>((acc, d) => ((acc[d.status] = (acc[d.status] ?? 0) + 1), acc), {});
      return { items: filtered, counts, total: items.length };
    });
  }

  /** The machine integrations a workspace may use, with how many machines each has. */
  async deviceIntegrations(tenantId: string) {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const c = await one<{ off: string[] }>(tx, 'select device_vendors_disabled as off from tenant_access_controls where tenant_id = $1', [tenantId]);
      const counts = await many<{ vendor: string; n: number }>(tx, 'select vendor, count(*)::int as n from attendance_devices where tenant_id = $1 and archived_at is null group by vendor', [tenantId]);
      const off = new Set(c?.off ?? []);
      return DEVICE_INTEGRATIONS.map((i) => ({ ...i, enabled: !off.has(i.key), devices: counts.find((x) => x.vendor === i.key)?.n ?? 0 }));
    });
  }

  async setDeviceIntegrations(tenantId: string, changes: { key: DeviceVendor; enabled: boolean }[]) {
    await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      await tx.query(`insert into tenant_access_controls (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId]);
      const row = (await one<{ off: string[] }>(tx, 'select device_vendors_disabled as off from tenant_access_controls where tenant_id = $1 for update', [tenantId]))!;
      const off = new Set(row.off);
      for (const c of changes) c.enabled ? off.delete(c.key) : off.add(c.key);
      const list = [...off].sort();
      await tx.query('update tenant_access_controls set device_vendors_disabled = $2, updated_by_admin_id = $3, updated_at = now() where tenant_id = $1', [tenantId, list, requestContext.platformActor().adminId]);
      await this.recordBoth(tx, tenantId, 'access.device_integrations_switched', 'tenant', tenantId, { changes, disabledNow: list });
    });
    return this.deviceIntegrations(tenantId);
  }

  async pauseDevice(tenantId: string, deviceId: string, reason: string | null) {
    return this.db.platform(async (tx) => {
      const d = await one<{ id: string; name: string; paused_at: Date | null }>(tx, 'select id, name, paused_at from attendance_devices where id = $1 and tenant_id = $2 and archived_at is null for update', [deviceId, tenantId]);
      if (!d) throw Errors.notFound('Device');
      if (reason !== null && d.paused_at) throw Errors.badRequest('already_paused', 'This machine is already paused.');
      if (reason === null && !d.paused_at) throw Errors.badRequest('not_paused', 'This machine is not paused.');
      await tx.query(
        `update attendance_devices set paused_at = $2, paused_reason = $3, paused_by_admin_id = $4,
                -- Refusals caused by the pause are not the machine's fault; clear them when it is resumed.
                last_error = case when $2::timestamptz is null and last_error like 'Refused: %' then null else last_error end,
                last_error_at = case when $2::timestamptz is null and last_error like 'Refused: %' then null else last_error_at end
          where id = $1`,
        [deviceId, reason === null ? null : new Date(), reason, reason === null ? null : requestContext.platformActor().adminId],
      );
      await this.recordBoth(tx, tenantId, reason === null ? 'device.resumed_by_sampledge' : 'device.paused_by_sampledge', 'attendance_device', deviceId, { device: d.name, reason });
      return { id: deviceId, paused: reason !== null };
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // Subscription history
  // -----------------------------------------------------------------------------------------------------------

  async subscriptionHistory(tenantId: string) {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      return many(
        tx,
        `select id::text, action, actor_label as "actorLabel", changes, created_at as "createdAt" from audit_events
          where tenant_id is null and resource_id = $1 and action in ('platform.subscription_overridden', 'platform.access_modules_switched', 'platform.tenant_suspended', 'platform.tenant_reactivated', 'platform.tenant_created')
          order by id desc limit 50`,
        [tenantId],
      );
    });
  }

  private async requireTenant(tx: Tx, tenantId: string) {
    if (!(await one(tx, 'select 1 from tenants where id = $1', [tenantId]))) throw Errors.notFound('Workspace');
  }

  private async recordBoth(tx: Tx, tenantId: string, action: string, resourceType: string, resourceId: string, changes: Record<string, unknown>) {
    await this.audit.record(tx, { tenantId, action, resourceType, resourceId, changes, metadata: { by: 'SAMPLEDGE' } });
    await this.audit.record(tx, { tenantId: null, action: `platform.${action.replace(/\./g, '_')}`, resourceType: 'tenant', resourceId: tenantId, changes });
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  DEVICE_INTEGRATIONS,
  type ActivityEventDetail,
  type ActivityRow,
  type DeviceVendor,
  type MemberAction,
  type WorkspaceUserRow,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { hashPassword, randomToken, sha256, temporaryPasswordValue } from '../../platform/auth/crypto';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, type PlatformTx as Tx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { deviceStatus } from '../attendance/devices.service';

const INVITE_TTL_DAYS = 7;

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DAY = 86_400_000;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** One audit event as a headline. Its id is its place in the workspace's chain, which only grows. */
function activityRow(a: Doc): ActivityRow {
  return {
    id: String(a.chain_seq), createdAt: a.created_at, action: a.action, area: String(a.action).split('.')[0]!, actorType: a.actor_type, actorLabel: a.actor_label ?? null,
    resourceType: a.resource_type ?? null, resourceId: a.resource_id ?? null, client: (a.metadata?.client as string | undefined) ?? null, ip: a.ip ?? null,
    hasChanges: !!a.changes && Object.keys(a.changes).length > 0,
  } as ActivityRow;
}

/**
 * Everything the SAMPLEDGE Super Admin does to the people, activity and attendance machines of a customer
 * workspace from the Console. Runs with the platform role. It shows account and sign-in details, the workspace's
 * activity and machine health. The recorded contents of an activity event (before and after values, for example a
 * salary change) are shown without the customer's approval, as SAMPLEDGE decided on 2026-11-05, but one event at a
 * time and every read is written to both audit trails, so the customer can see what SAMPLEDGE looked at.
 * Every action is written to both the platform audit log and the customer's own audit trail.
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
      const filter: Doc = q.tenantId ? { tenant_id: q.tenantId } : {};
      if (q.q) {
        const re = ilike(q.q);
        const userIds = await tx.collection('users').distinct<string>('id', { $or: [{ full_name: re }, { email: re }] });
        const tenantIds = await tx.collection('tenants').distinct<string>('id', { name: re });
        filter.$or = [{ user_id: { $in: userIds } }, { tenant_id: { $in: tenantIds } }];
      }
      const ms = await tx.collection<{ id: string; user_id: string; tenant_id: string; status: string; joined_at: Date | null }>('memberships').find(filter);
      const users = new Map((await tx.collection('users').find({ id: { $in: [...new Set(ms.map((m) => m.user_id))] } })).map((u) => [u.id as string, u]));
      const tenants = new Map((await tx.collection('tenants').find({ id: { $in: [...new Set(ms.map((m) => m.tenant_id))] } }, { projection: { name: 1, slug: 1 } })).map((t) => [t.id as string, t]));
      const joined = ms.filter((m) => users.has(m.user_id) && tenants.has(m.tenant_id));
      const monthAgo = Date.now() - 30 * DAY;
      const summary: Record<string, number> = {
        total: joined.length,
        active: joined.filter((m) => m.status === 'active').length,
        invited: joined.filter((m) => m.status === 'invited').length,
        suspended: joined.filter((m) => m.status === 'suspended').length,
        withMfa: joined.filter((m) => users.get(m.user_id)!.mfa_enabled).length,
        signedIn30d: joined.filter((m) => ((users.get(m.user_id)!.last_login_at as Date | null)?.getTime() ?? 0) > monthAgo).length,
      };
      const rows = (q.status ? joined.filter((m) => m.status === q.status) : joined).sort((a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active')
        || cmp(tenants.get(a.tenant_id)!.name, tenants.get(b.tenant_id)!.name)
        || cmp(users.get(a.user_id)!.full_name, users.get(b.user_id)!.full_name)
        || cmp(a.id, b.id));
      const total = rows.length;
      const pageRows = rows.slice(q.offset, q.offset + q.limit);
      const ids = pageRows.map((m) => m.id);
      const assignments = await tx.collection<{ membership_id: string; role_id: string }>('role_assignments').find({ membership_id: { $in: ids } });
      const roleNames = new Map((await tx.collection<{ id: string; name: string }>('roles').find({ id: { $in: assignments.map((a) => a.role_id) } })).map((r) => [r.id, r.name]));
      const access = new Map((await tx.collection<{ membership_id: string; blocked_features: string[] }>('member_feature_access').find({ membership_id: { $in: ids } })).map((a) => [a.membership_id, a.blocked_features]));
      const invites = await tx.collection<{ membership_id: string; created_at: Date }>('invitations').find({ membership_id: { $in: ids } }, { projection: { membership_id: 1, created_at: 1 } });
      const live = await tx.collection<{ user_id: string; tenant_id: string; client: string }>('sessions').find(
        { user_id: { $in: pageRows.map((m) => m.user_id) }, revoked_at: null, expires_at: { $gt: new Date() } },
        { projection: { user_id: 1, tenant_id: 1, client: 1 } },
      );
      const now = new Date();
      const items = pageRows.map((m): WorkspaceUserRow => {
        const u = users.get(m.user_id)!;
        const t = tenants.get(m.tenant_id)!;
        const sent = invites.filter((i) => i.membership_id === m.id).map((i) => i.created_at.getTime());
        const mine = live.filter((x) => x.user_id === m.user_id && x.tenant_id === m.tenant_id);
        return {
          membershipId: m.id, userId: u.id, fullName: u.full_name, email: u.email, status: m.status, accountStatus: u.status,
          roles: assignments.filter((a) => a.membership_id === m.id).map((a) => roleNames.get(a.role_id)).filter((n): n is string => !!n).sort(cmp),
          blockedFeatures: access.get(m.id) ?? [], mfaEnabled: !!u.mfa_enabled, lastLoginAt: u.last_login_at ?? null,
          mustChangePassword: !!u.must_change_password, lockedUntil: u.locked_until && u.locked_until > now ? u.locked_until : null,
          invitedAt: sent.length ? new Date(Math.max(...sent)) : null, joinedAt: m.joined_at ?? null,
          liveSessions: { web: mine.filter((x) => x.client === 'web').length, mobile: mine.filter((x) => x.client === 'mobile').length },
          tenantId: t.id, tenantName: t.name, tenantSlug: t.slug,
        } as WorkspaceUserRow;
      });
      return { items, total, summary };
    });
  }

  async userAction(tenantId: string, membershipId: string, action: MemberAction, reason: string) {
    const admin = requestContext.platformActor();
    let inviteToken: string | null = null;
    let temporaryPassword: string | null = null;
    // Hashing is slow on purpose, so it happens before the transaction.
    const prepared = action === 'reset_password' ? temporaryPasswordValue() : null;
    const preparedHash = prepared ? await hashPassword(prepared) : null;
    const result = await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const memberships = tx.collection<{ id: string; user_id: string; status: string }>('memberships');
      if (!(await memberships.lock({ id: membershipId, tenant_id: tenantId }))) throw Errors.notFound('Member');
      const mem = (await memberships.findOne({ id: membershipId, tenant_id: tenantId }))!;
      const users = tx.collection<{ status: string; mfa_enabled: boolean; locked_until: Date | null }>('users');
      const user = await tx.collection<{ email: string; full_name: string }>('users').findOne({ id: mem.user_id });
      if (!user) throw Errors.notFound('Member');
      const ownerRoles = await tx.collection('roles').distinct<string>('id', { tenant_id: tenantId, key: 'tenant_owner' });
      const m = { ...mem, email: user.email, full_name: user.full_name, owner: await tx.collection('role_assignments').exists({ membership_id: mem.id, role_id: { $in: ownerRoles } }) };
      let detail: Record<string, unknown> = {};
      switch (action) {
        case 'suspend': {
          if (m.status !== 'active') throw Errors.badRequest('not_active', m.status === 'invited' ? 'This person has not accepted their invitation yet.' : 'This person is already suspended.');
          if (m.owner) {
            const owners = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: { $in: ownerRoles }, membership_id: { $ne: m.id } });
            const others = await memberships.count({ id: { $in: owners }, status: 'active' });
            if (!others) throw Errors.badRequest('last_owner', 'This is the workspace\'s only active owner. Suspend the whole workspace instead, or ask the customer to add another owner first.');
          }
          await memberships.updateOne({ id: m.id }, { $set: { status: 'suspended' } });
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, tenantId, 'membership_suspended') };
          break;
        }
        case 'reactivate':
          if (m.status !== 'suspended') throw Errors.badRequest('not_suspended', 'Only suspended people can be reactivated.');
          await memberships.updateOne({ id: m.id }, { $set: { status: 'active' } });
          break;
        case 'sign_out':
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, tenantId, 'signed_out_by_sampledge') };
          break;
        case 'reset_mfa': {
          const u = await users.findOne({ id: m.user_id });
          if (!u?.mfa_enabled) throw Errors.badRequest('mfa_not_enabled', 'This person has not set up two-step verification.');
          // The authenticator belongs to the account, which can be in several workspaces, so every session ends.
          await users.updateOne({ id: m.user_id }, { $set: { mfa_enabled: false, mfa_secret_enc: null } });
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, null, 'mfa_reset_by_sampledge') };
          break;
        }
        // Passwords are stored only as one-way hashes, so nobody (SAMPLEDGE included) can read one back. SAMPLEDGE can
        // set a new temporary password, shown once, which the person must replace at their next sign-in. The account
        // can be in several workspaces, so these apply to all of them and every session ends.
        case 'reset_password': {
          if (m.status === 'invited') throw Errors.badRequest('not_joined', 'This person has not joined yet. Resend the invitation instead.');
          await users.updateOne({ id: m.user_id }, { $set: { password_hash: preparedHash, must_change_password: true, failed_login_count: 0, locked_until: null } });
          temporaryPassword = prepared;
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, null, 'password_reset_by_sampledge') };
          break;
        }
        case 'force_password_change':
          if (m.status === 'invited') throw Errors.badRequest('not_joined', 'This person has not joined yet.');
          await users.updateOne({ id: m.user_id }, { $set: { must_change_password: true } });
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, null, 'password_change_forced_by_sampledge') };
          break;
        case 'lock_account': {
          const u = (await users.findOne({ id: m.user_id }))!;
          if (u.status !== 'active') throw Errors.badRequest('not_active', 'This account is already locked.');
          await users.updateOne({ id: m.user_id }, { $set: { status: 'locked' } });
          detail = { sessionsEnded: await this.endSessions(tx, m.user_id, null, 'account_locked_by_sampledge') };
          break;
        }
        case 'unlock_account': {
          const u = (await users.findOne({ id: m.user_id }))!;
          if (u.status === 'active' && !(u.locked_until && u.locked_until > new Date())) throw Errors.badRequest('not_locked', 'This account is not locked.');
          if (u.status === 'disabled') throw Errors.badRequest('account_disabled', 'This account was closed (for example by an erasure request) and cannot be unlocked.');
          await users.updateOne({ id: m.user_id }, { $set: { status: 'active', failed_login_count: 0, locked_until: null } });
          break;
        }
        case 'resend_invite': {
          if (m.status !== 'invited') throw Errors.badRequest('not_invited', 'This person has already joined.');
          inviteToken = randomToken(32);
          const invitations = tx.collection('invitations');
          await invitations.update({ membership_id: m.id, accepted_at: null, revoked_at: null }, { $set: { revoked_at: new Date() } });
          await invitations.insert({ tenant_id: tenantId, membership_id: m.id, email: m.email, token_hash: sha256(inviteToken), expires_at: new Date(Date.now() + INVITE_TTL_DAYS * DAY) });
          const ws = (await tx.collection<{ name: string }>('tenants').findOne({ id: tenantId }))!;
          await this.notifications.queueEmail(
            tx, tenantId, m.email, `You're invited to ${ws.name} on SampCrew`,
            `You have been invited to join ${ws.name} on SampCrew.\n\nAccept the invitation and set your password: ${this.config.WEB_PUBLIC_URL}/accept-invite?token=${inviteToken}\n\nThe link expires in ${INVITE_TTL_DAYS} days.`,
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
    return { ...result, inviteUrl, ...(temporaryPassword ? { temporaryPassword } : {}) };
  }

  private async endSessions(tx: Tx, userId: string, tenantId: string | null, reason: string) {
    return tx.collection('sessions').update(
      { user_id: userId, ...(tenantId ? { tenant_id: tenantId } : {}), revoked_at: null },
      { $set: { revoked_at: new Date(), revoked_reason: reason } },
    );
  }

  // -----------------------------------------------------------------------------------------------------------
  // Activity
  // -----------------------------------------------------------------------------------------------------------

  /** The customer's audit trail as headlines: what happened, who did it, when, from which app. Contents: activityEvent. */
  async activity(tenantId: string, q: { q?: string; area?: string; actorType?: string; before?: number; limit: number }) {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const filter: Doc = { tenant_id: tenantId };
      if (q.area) filter.action = { $regex: `^${ilike(q.area).$regex}\\.` };
      if (q.actorType) filter.actor_type = q.actorType;
      if (q.q) {
        const re = ilike(q.q);
        filter.$or = [{ action: re }, { actor_label: re }, { resource_type: re }];
      }
      if (q.before) filter.chain_seq = { $lt: q.before };
      const events = tx.collection('audit_events');
      const rows = (await events.find(filter, { sort: { chain_seq: -1 }, limit: q.limit + 1 })).map(activityRow);
      const items = rows.slice(0, q.limit);
      const week = new Date(Date.now() - 7 * DAY);
      const month = new Date(Date.now() - 30 * DAY);
      const summary = {
        events7d: await events.count({ tenant_id: tenantId, created_at: { $gt: week } }),
        webSignIns30d: await events.count({ tenant_id: tenantId, action: 'auth.login', 'metadata.client': 'web', created_at: { $gt: month } }),
        mobileSignIns30d: await events.count({ tenant_id: tenantId, action: 'auth.login', 'metadata.client': 'mobile', created_at: { $gt: month } }),
        activeUsers7d: (await events.distinct('actor_id', { tenant_id: tenantId, actor_type: 'user', created_at: { $gt: week }, actor_id: { $ne: null } })).length,
        activeUsers30d: (await events.distinct('actor_id', { tenant_id: tenantId, actor_type: 'user', created_at: { $gt: month }, actor_id: { $ne: null } })).length,
      };
      const recent = await events.find({ tenant_id: tenantId, created_at: { $gt: month } }, { projection: { action: 1 } });
      const byArea = new Map<string, number>();
      for (const e of recent) {
        const area = String(e.action).split('.')[0]!;
        byArea.set(area, (byArea.get(area) ?? 0) + 1);
      }
      const areas = [...byArea].map(([area, n]) => ({ area, n })).sort((a, b) => b.n - a.n || cmp(a.area, b.area)).slice(0, 12);
      return { items, nextBefore: rows.length > q.limit ? Number(items[items.length - 1]!.id) : null, summary, areas };
    });
  }

  /**
   * One event with its recorded contents (before and after values) and the history of the same record. Shown without
   * the customer's approval; every read is recorded in the customer's trail (`activity.contents_viewed_by_sampledge`)
   * and the platform log, with who looked and which event.
   */
  async activityEvent(tenantId: string, eventId: string): Promise<ActivityEventDetail> {
    const admin = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const events = tx.collection('audit_events');
      const seq = Number(eventId);
      const doc = Number.isSafeInteger(seq) ? await events.findOne({ tenant_id: tenantId, chain_seq: seq }) : undefined;
      if (!doc) throw Errors.notFound('Activity event');
      const ev = { ...activityRow(doc), changes: doc.changes, metadata: doc.metadata, userAgent: doc.user_agent ?? null, requestId: doc.request_id ?? null } as ActivityEventDetail;
      ev.history = ev.resourceId
        ? (await events.find(
            { tenant_id: tenantId, resource_type: doc.resource_type, resource_id: doc.resource_id, chain_seq: { $ne: seq } },
            { sort: { chain_seq: -1 }, limit: 50 },
          )).map((h) => ({ ...activityRow(h), changes: h.changes })) as ActivityEventDetail['history']
        : [];
      const viewed = { eventId: ev.id, eventAction: ev.action, resourceType: ev.resourceType, resourceId: ev.resourceId, historyEvents: ev.history.length };
      await this.audit.record(tx, {
        tenantId,
        action: 'activity.contents_viewed_by_sampledge',
        resourceType: 'audit_event',
        resourceId: ev.id,
        changes: viewed,
        metadata: { by: 'SAMPLEDGE', admin: admin.label },
      });
      await this.audit.record(tx, { tenantId: null, action: 'platform.activity_contents_viewed', resourceType: 'tenant', resourceId: tenantId, changes: viewed });
      return ev;
    });
  }

  // -----------------------------------------------------------------------------------------------------------
  // Attendance machines
  // -----------------------------------------------------------------------------------------------------------

  /** Machines in one workspace, or every workspace. Status as the workspace sees it, plus SAMPLEDGE's pause. */
  async devices(q: { q?: string; tenantId?: string; status?: string }) {
    return this.db.platform(async (tx) => {
      if (q.tenantId) await this.requireTenant(tx, q.tenantId);
      const filter: Doc = { archived_at: null };
      if (q.tenantId) filter.tenant_id = q.tenantId;
      if (q.q) {
        const re = ilike(q.q);
        const tenantIds = await tx.collection('tenants').distinct<string>('id', { name: re });
        filter.$or = [{ name: re }, { serial_number: re }, { model: re }, { tenant_id: { $in: tenantIds } }];
      }
      const ds = await tx.collection('attendance_devices').find(filter);
      const tenantIds = [...new Set(ds.map((d) => d.tenant_id as string))];
      const tenants = new Map((await tx.collection('tenants').find({ id: { $in: tenantIds } }, { projection: { name: 1, slug: 1 } })).map((t) => [t.id as string, t]));
      const locations = new Map((await tx.collection('locations').find({ id: { $in: ds.map((d) => d.location_id) } }, { projection: { name: 1 } })).map((l) => [l.id as string, l.name as string]));
      const off = new Map((await tx.collection('tenant_access_controls').find({ tenant_id: { $in: tenantIds } })).map((c) => [c.tenant_id as string, new Set<string>((c.device_vendors_disabled as string[]) ?? [])]));
      const week = new Date(Date.now() - 7 * DAY);
      const punches = new Map<string, number>();
      for (const e of await tx.collection('attendance_events').find({ device_id: { $in: ds.map((d) => d.id) }, captured_at: { $gt: week } }, { projection: { device_id: 1 } })) {
        punches.set(e.device_id, (punches.get(e.device_id) ?? 0) + 1);
      }
      const rows = ds
        .filter((d) => tenants.has(d.tenant_id) && locations.has(d.location_id))
        .map((d) => {
          const t = tenants.get(d.tenant_id)!;
          return {
            id: d.id as string, name: d.name as string, vendor: d.vendor as string, model: d.model ?? null, serialNumber: d.serial_number ?? null, protocol: d.protocol, simulated: !!d.simulated,
            firmware: d.firmware ?? null, locationName: locations.get(d.location_id)!, lastSeenAt: d.last_seen_at ?? null, lastPunchAt: d.last_punch_at ?? null, lastError: d.last_error ?? null,
            recordsAccepted: d.records_accepted ?? 0, recordsRejected: d.records_rejected ?? 0, pausedAt: (d.paused_at ?? null) as Date | null, pausedReason: d.paused_reason ?? null,
            createdAt: d.created_at, integrationOn: !off.get(d.tenant_id)?.has(d.vendor), punches7d: punches.get(d.id) ?? 0,
            tenantId: t.id as string, tenantName: t.name as string, tenantSlug: t.slug as string,
            last_seen_at: (d.last_seen_at ?? null) as Date | null, last_error_at: (d.last_error_at ?? null) as Date | null, expected_interval_seconds: d.expected_interval_seconds as number,
          };
        })
        .sort((a, b) => cmp(a.tenantName, b.tenantName) || cmp(a.name, b.name));
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
      const c = await tx.collection<{ device_vendors_disabled: string[] }>('tenant_access_controls').findOne({ tenant_id: tenantId });
      const vendors = (await tx.collection<{ vendor: string }>('attendance_devices').find({ tenant_id: tenantId, archived_at: null }, { projection: { vendor: 1 } })).map((d) => d.vendor);
      const off = new Set(c?.device_vendors_disabled ?? []);
      return DEVICE_INTEGRATIONS.map((i) => ({ ...i, enabled: !off.has(i.key), devices: vendors.filter((v) => v === i.key).length }));
    });
  }

  async setDeviceIntegrations(tenantId: string, changes: { key: DeviceVendor; enabled: boolean }[]) {
    await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const controls = tx.collection<{ device_vendors_disabled: string[] }>('tenant_access_controls');
      if (!(await controls.exists({ tenant_id: tenantId }))) await controls.insert({ tenant_id: tenantId });
      await controls.lock({ tenant_id: tenantId });
      const row = (await controls.findOne({ tenant_id: tenantId }))!;
      const off = new Set(row.device_vendors_disabled);
      for (const c of changes) c.enabled ? off.delete(c.key) : off.add(c.key);
      const list = [...off].sort();
      await controls.updateOne({ tenant_id: tenantId }, { $set: { device_vendors_disabled: list, updated_by_admin_id: requestContext.platformActor().adminId, updated_at: new Date() } });
      await this.recordBoth(tx, tenantId, 'access.device_integrations_switched', 'tenant', tenantId, { changes, disabledNow: list });
    });
    return this.deviceIntegrations(tenantId);
  }

  async pauseDevice(tenantId: string, deviceId: string, reason: string | null) {
    return this.db.platform(async (tx) => {
      const devices = tx.collection<{ id: string; name: string; paused_at: Date | null; last_error: string | null }>('attendance_devices');
      if (!(await devices.lock({ id: deviceId, tenant_id: tenantId, archived_at: null }))) throw Errors.notFound('Device');
      const d = (await devices.findOne({ id: deviceId }))!;
      if (reason !== null && d.paused_at) throw Errors.badRequest('already_paused', 'This machine is already paused.');
      if (reason === null && !d.paused_at) throw Errors.badRequest('not_paused', 'This machine is not paused.');
      // Refusals caused by the pause are not the machine's fault; clear them when it is resumed.
      const clearRefusal = reason === null && !!d.last_error?.startsWith('Refused: ');
      await devices.updateOne({ id: deviceId }, {
        $set: {
          paused_at: reason === null ? null : new Date(), paused_reason: reason, paused_by_admin_id: reason === null ? null : requestContext.platformActor().adminId,
          ...(clearRefusal ? { last_error: null, last_error_at: null } : {}),
        },
      });
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
      const rows = await tx.collection('audit_events').find(
        { tenant_id: null, resource_id: tenantId, action: { $in: ['platform.subscription_overridden', 'platform.access_modules_switched', 'platform.tenant_suspended', 'platform.tenant_reactivated', 'platform.tenant_created'] } },
        { sort: { chain_seq: -1 }, limit: 50 },
      );
      return rows.map((e) => ({ id: String(e.chain_seq), action: e.action, actorLabel: e.actor_label ?? null, changes: e.changes, createdAt: e.created_at }));
    });
  }

  private async requireTenant(tx: Tx, tenantId: string) {
    if (!(await tx.collection('tenants').exists({ id: tenantId }))) throw Errors.notFound('Workspace');
  }

  private async recordBoth(tx: Tx, tenantId: string, action: string, resourceType: string, resourceId: string, changes: Record<string, unknown>) {
    await this.audit.record(tx, { tenantId, action, resourceType, resourceId, changes, metadata: { by: 'SAMPLEDGE' } });
    await this.audit.record(tx, { tenantId: null, action: `platform.${action.replace(/\./g, '_')}`, resourceType: 'tenant', resourceId: tenantId, changes });
  }
}

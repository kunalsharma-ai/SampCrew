import { Injectable } from '@nestjs/common';
import {
  BOOLEAN_FEATURES,
  isCoreFeature,
  PERMISSION_MODULE_FEATURE,
  PERMISSIONS,
  type FeatureSwitchState,
  type MemberAccessRow,
  type WorkspaceAccess,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, type PlatformTx as Tx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';

/**
 * Workspace access controls for the Super Admin Console: switch modules and permissions on or off for a whole
 * workspace, and choose which modules each member may use. The API enforces all three (EntitlementsService for
 * modules, AuthzService.loadSubject for permissions), so a switched-off module is closed even to direct API calls.
 *
 * The member list shows account details only (name, email, roles, status), never HR records; every change is
 * written to both the platform audit log and the customer's own audit trail.
 */
@Injectable()
export class AccessControlsService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  async workspace(tenantId: string): Promise<WorkspaceAccess> {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const subRow = await tx.collection<{ plan_id: string; status: string; feature_overrides: Record<string, boolean | number> }>('subscriptions').findOne({ tenant_id: tenantId });
      const plan = subRow ? await tx.collection<{ key: string; name: string }>('plans').findOne({ id: subRow.plan_id }) : undefined;
      const sub = subRow && plan ? { ...subRow, plan_key: plan.key, plan_name: plan.name } : undefined;
      const inPlan = new Set(sub ? await tx.collection('plan_features').distinct<string>('feature_key', { plan_id: sub.plan_id }) : []);
      const subLive = sub && sub.status !== 'cancelled' && sub.status !== 'suspended';
      const controls = await tx.collection<{ disabled_permissions: string[]; updated_at: Date; web_portal_enabled: boolean; mobile_app_enabled: boolean; web_off_features: string[]; mobile_off_features: string[] }>('tenant_access_controls').findOne({ tenant_id: tenantId });
      const sessions = tx.collection('sessions');
      const open = { tenant_id: tenantId, revoked_at: null, expires_at: { $gt: new Date() } };
      const live = { web: await sessions.count({ ...open, client: 'web' }), mobile: await sessions.count({ ...open, client: 'mobile' }) };
      const disabled = new Set(controls?.disabled_permissions ?? []);
      const memberships = await tx.collection<{ id: string; status: string }>('memberships').find({ tenant_id: tenantId }, { projection: { status: 1 } });
      const notSuspended = new Set(memberships.filter((m) => m.status !== 'suspended').map((m) => m.id));
      const activeMembers = new Set(memberships.filter((m) => m.status === 'active').map((m) => m.id));
      const blocked = new Map<string, number>();
      for (const a of await tx.collection<{ membership_id: string; blocked_features: string[] }>('member_feature_access').find({ tenant_id: tenantId })) {
        if (!notSuspended.has(a.membership_id)) continue;
        for (const k of a.blocked_features) blocked.set(k, (blocked.get(k) ?? 0) + 1);
      }
      const roleIds = await tx.collection('roles').distinct<string>('id', { tenant_id: tenantId });
      const rolePerms = await tx.collection<{ role_id: string; permission: string }>('role_permissions').find({ role_id: { $in: roleIds } });
      const assignments = await tx.collection<{ role_id: string; membership_id: string }>('role_assignments').find({ role_id: { $in: roleIds } });
      const holdersOf = new Map<string, { roles: Set<string>; members: Set<string> }>();
      for (const rp of rolePerms) {
        const h = holdersOf.get(rp.permission) ?? { roles: new Set<string>(), members: new Set<string>() };
        h.roles.add(rp.role_id);
        for (const ra of assignments) if (ra.role_id === rp.role_id && activeMembers.has(ra.membership_id)) h.members.add(ra.membership_id);
        holdersOf.set(rp.permission, h);
      }
      const holders = [...holdersOf].map(([permission, h]) => ({ permission, roles: h.roles.size, members: h.members.size }));
      const blockedCounts = [...blocked].map(([key, n]) => ({ key, n }));
      const overrides = sub?.feature_overrides ?? {};
      const features = BOOLEAN_FEATURES.map((f) => {
        const core = isCoreFeature(f.key);
        const override = typeof overrides[f.key] === 'boolean' && !core ? (overrides[f.key] as boolean) : null;
        const planHas = inPlan.has(f.key);
        return {
          key: f.key, name: f.name, module: f.module, core, inPlan: planHas, override,
          effective: Boolean(subLive) && (core ? planHas : override ?? planHas),
          blockedMembers: blockedCounts.find((b) => b.key === f.key)?.n ?? 0,
        };
      });
      const effective = new Map(features.map((f) => [f.key, f.effective]));
      const permissions = PERMISSIONS.map((p) => {
        const feature = PERMISSION_MODULE_FEATURE[p.module] ?? null;
        const h = holders.find((x) => x.permission === p.key);
        return {
          key: p.key, module: p.module, description: p.description, sensitive: 'sensitive' in p && p.sensitive === true,
          enabled: !disabled.has(p.key), feature, featureOn: feature ? effective.get(feature) ?? false : true,
          roles: h?.roles ?? 0, members: h?.members ?? 0,
        };
      });
      return {
        plan: sub ? { key: sub.plan_key, name: sub.plan_name, status: sub.status } : null,
        features,
        permissions,
        channels: {
          web: controls?.web_portal_enabled ?? true,
          mobile: controls?.mobile_app_enabled ?? true,
          webOff: controls?.web_off_features ?? [],
          mobileOff: controls?.mobile_off_features ?? [],
          liveSessions: live,
        },
        updatedAt: controls?.updated_at ? controls.updated_at.toISOString() : null,
      };
    });
  }

  /** Applies the changes, then returns the workspace's access as now stored. */
  async setFeatures(tenantId: string, changes: { key: string; state: FeatureSwitchState }[]): Promise<WorkspaceAccess> {
    await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      await tx.collection('subscriptions').lock({ tenant_id: tenantId });
      const sub = await tx.collection<{ id: string; feature_overrides: Record<string, boolean | number> }>('subscriptions').findOne({ tenant_id: tenantId });
      if (!sub) throw Errors.badRequest('no_subscription', 'This workspace has no subscription, so its modules cannot be switched.');
      const before = { ...(sub.feature_overrides ?? {}) };
      const next = { ...before };
      for (const c of changes) {
        if (isCoreFeature(c.key)) throw Errors.badRequest('core_feature', 'Core HR cannot be switched off.');
        if (c.state === 'plan') delete next[c.key];
        else next[c.key] = c.state === 'on';
      }
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { feature_overrides: next } });
      const diff = changes.map((c) => ({ module: c.key, from: stateOf(before[c.key]), to: c.state }));
      await this.record(tx, tenantId, 'access.modules_switched', 'subscription', sub.id, { modules: diff });
    });
    return this.workspace(tenantId);
  }

  async setPermissions(tenantId: string, changes: { key: string; enabled: boolean }[]): Promise<WorkspaceAccess> {
    await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      await this.ensureRow(tx, tenantId);
      await tx.collection('tenant_access_controls').lock({ tenant_id: tenantId });
      const row = await tx.collection<{ disabled_permissions: string[] }>('tenant_access_controls').findOne({ tenant_id: tenantId });
      const disabled = new Set(row?.disabled_permissions ?? []);
      for (const c of changes) c.enabled ? disabled.delete(c.key) : disabled.add(c.key);
      const list = [...disabled].sort();
      await tx.collection('tenant_access_controls').updateOne(
        { tenant_id: tenantId },
        { $set: { disabled_permissions: list, updated_by_admin_id: requestContext.platformActor().adminId, updated_at: new Date() } },
      );
      await this.record(tx, tenantId, 'access.permissions_switched', 'tenant', tenantId, { permissions: changes, disabledNow: list });
    });
    return this.workspace(tenantId);
  }

  /**
   * Apps: the Web Portal and the mobile app can each be switched off for the whole workspace (their open sessions
   * end at once), and single modules can be switched off in one app only.
   */
  async setChannels(tenantId: string, input: { web?: boolean; mobile?: boolean; modules?: { key: string; web: boolean; mobile: boolean }[] }): Promise<WorkspaceAccess> {
    await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      await this.ensureRow(tx, tenantId);
      await tx.collection('tenant_access_controls').lock({ tenant_id: tenantId });
      const c = (await tx.collection<{ web_portal_enabled: boolean; mobile_app_enabled: boolean; web_off_features: string[]; mobile_off_features: string[] }>('tenant_access_controls').findOne({ tenant_id: tenantId }))!;
      const before = { web: c.web_portal_enabled, mobile: c.mobile_app_enabled, web_off: c.web_off_features, mobile_off: c.mobile_off_features };
      const web = input.web ?? before.web;
      const mobile = input.mobile ?? before.mobile;
      if (!web && !mobile) throw Errors.badRequest('no_app_left', 'Keep at least one app on. To stop all access, suspend the workspace instead.');
      const webOff = new Set(before.web_off);
      const mobileOff = new Set(before.mobile_off);
      for (const m of input.modules ?? []) {
        m.web ? webOff.delete(m.key) : webOff.add(m.key);
        m.mobile ? mobileOff.delete(m.key) : mobileOff.add(m.key);
      }
      const after = { web, mobile, webOff: [...webOff].sort(), mobileOff: [...mobileOff].sort() };
      await tx.collection('tenant_access_controls').updateOne({ tenant_id: tenantId }, {
        $set: {
          web_portal_enabled: after.web, mobile_app_enabled: after.mobile, web_off_features: after.webOff, mobile_off_features: after.mobileOff,
          updated_by_admin_id: requestContext.platformActor().adminId, updated_at: new Date(),
        },
      });
      let signedOut = 0;
      for (const app of ['web', 'mobile'] as const) {
        if (before[app] && !after[app]) {
          signedOut += await tx.collection('sessions').update({ tenant_id: tenantId, client: app, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'app_switched_off' } });
        }
      }
      await this.record(tx, tenantId, 'access.apps_switched', 'tenant', tenantId, {
        before: { web: before.web, mobile: before.mobile, webOff: before.web_off, mobileOff: before.mobile_off }, after, sessionsEnded: signedOut,
      });
    });
    return this.workspace(tenantId);
  }

  async members(tenantId: string, q: { q?: string; limit: number; offset: number }): Promise<{ items: MemberAccessRow[]; total: number }> {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const ms = await tx.collection<{ id: string; user_id: string; status: string }>('memberships').find({ tenant_id: tenantId });
      const users = new Map((await tx.collection<{ id: string; full_name: string; email: string }>('users').find({ id: { $in: ms.map((m) => m.user_id) } })).map((u) => [u.id, u]));
      const re = q.q ? new RegExp(ilike(q.q).$regex, 'i') : null;
      const rows = ms
        .map((m) => ({ m, u: users.get(m.user_id) }))
        .filter((r): r is { m: typeof r.m; u: NonNullable<typeof r.u> } => !!r.u && (!re || re.test(r.u.full_name) || re.test(r.u.email)))
        .sort((a, b) => Number(b.m.status === 'active') - Number(a.m.status === 'active') || cmp(a.u.full_name, b.u.full_name) || cmp(a.m.id, b.m.id));
      const total = rows.length;
      const page = rows.slice(q.offset, q.offset + q.limit);
      const ids = page.map((r) => r.m.id);
      const assignments = await tx.collection<{ membership_id: string; role_id: string }>('role_assignments').find({ membership_id: { $in: ids } });
      const roleNames = new Map((await tx.collection<{ id: string; name: string }>('roles').find({ id: { $in: assignments.map((a) => a.role_id) } })).map((r) => [r.id, r.name]));
      const access = new Map((await tx.collection<{ membership_id: string; blocked_features: string[] }>('member_feature_access').find({ membership_id: { $in: ids } })).map((a) => [a.membership_id, a.blocked_features]));
      const items: MemberAccessRow[] = page.map(({ m, u }) => ({
        membershipId: m.id, fullName: u.full_name, email: u.email, status: m.status,
        roles: assignments.filter((a) => a.membership_id === m.id).map((a) => roleNames.get(a.role_id)).filter((n): n is string => !!n).sort(cmp),
        blockedFeatures: access.get(m.id) ?? [],
      } as MemberAccessRow));
      return { items, total };
    });
  }

  async setMemberFeatures(tenantId: string, membershipId: string, blockedFeatures: string[]) {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const membership = await tx.collection<{ user_id: string }>('memberships').findOne({ id: membershipId, tenant_id: tenantId });
      const m = membership ? await tx.collection<{ email: string }>('users').findOne({ id: membership.user_id }) : undefined;
      if (!m) throw Errors.notFound('Member');
      const access = tx.collection<{ blocked_features: string[] }>('member_feature_access');
      const before = (await access.findOne({ membership_id: membershipId }))?.blocked_features ?? [];
      if (blockedFeatures.length) {
        const set = { blocked_features: blockedFeatures, updated_by_admin_id: requestContext.platformActor().adminId, updated_at: new Date() };
        await access.upsert({ tenant_id: tenantId, membership_id: membershipId }, { tenant_id: tenantId, membership_id: membershipId, ...set }, { $set: set });
      } else {
        await access.delete({ membership_id: membershipId });
      }
      await this.record(tx, tenantId, 'access.member_modules_changed', 'membership', membershipId, { member: m.email, blockedBefore: before, blockedNow: blockedFeatures });
      return { membershipId, blockedFeatures };
    });
  }

  private async ensureRow(tx: Tx, tenantId: string) {
    const controls = tx.collection('tenant_access_controls');
    if (!(await controls.exists({ tenant_id: tenantId }))) await controls.insert({ tenant_id: tenantId });
  }

  private async requireTenant(tx: Tx, tenantId: string) {
    if (!(await tx.collection('tenants').exists({ id: tenantId }))) throw Errors.notFound('Workspace');
  }

  private async record(tx: Tx, tenantId: string, action: string, resourceType: string, resourceId: string, changes: Record<string, unknown>) {
    await this.audit.record(tx, { tenantId, action, resourceType, resourceId, changes, metadata: { by: 'SAMPLEDGE' } });
    await this.audit.record(tx, { tenantId: null, action: `platform.${action.replace('.', '_')}`, resourceType: 'tenant', resourceId: tenantId, changes });
  }
}

function stateOf(v: boolean | number | undefined): FeatureSwitchState {
  return v === true ? 'on' : v === false ? 'off' : 'plan';
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

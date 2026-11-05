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
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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
      const sub = await one<{ plan_id: string; plan_key: string; plan_name: string; status: string; feature_overrides: Record<string, boolean | number> }>(
        tx,
        `select s.plan_id, p.key as plan_key, p.name as plan_name, s.status, s.feature_overrides
           from subscriptions s join plans p on p.id = s.plan_id where s.tenant_id = $1`,
        [tenantId],
      );
      const inPlan = new Set(sub ? (await many<{ feature_key: string }>(tx, 'select feature_key from plan_features where plan_id = $1', [sub.plan_id])).map((r) => r.feature_key) : []);
      const subLive = sub && sub.status !== 'cancelled' && sub.status !== 'suspended';
      const controls = await one<{ disabled_permissions: string[]; updated_at: string; web_portal_enabled: boolean; mobile_app_enabled: boolean; web_off_features: string[]; mobile_off_features: string[] }>(
        tx, 'select disabled_permissions, updated_at, web_portal_enabled, mobile_app_enabled, web_off_features, mobile_off_features from tenant_access_controls where tenant_id = $1', [tenantId],
      );
      const live = await one<{ web: number; mobile: number }>(
        tx,
        `select count(*) filter (where client = 'web')::int as web, count(*) filter (where client = 'mobile')::int as mobile
           from sessions where tenant_id = $1 and revoked_at is null and expires_at > now()`,
        [tenantId],
      );
      const disabled = new Set(controls?.disabled_permissions ?? []);
      const blockedCounts = await many<{ key: string; n: number }>(
        tx,
        `select k as key, count(*)::int as n from member_feature_access a join memberships m on m.id = a.membership_id and m.status <> 'suspended',
                unnest(a.blocked_features) k where a.tenant_id = $1 group by k`,
        [tenantId],
      );
      const holders = await many<{ permission: string; roles: number; members: number }>(
        tx,
        `select rp.permission, count(distinct r.id)::int as roles, count(distinct ra.membership_id) filter (where m.status = 'active')::int as members
           from roles r join role_permissions rp on rp.role_id = r.id
           left join role_assignments ra on ra.role_id = r.id
           left join memberships m on m.id = ra.membership_id
          where r.tenant_id = $1 group by rp.permission`,
        [tenantId],
      );
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
          liveSessions: live ?? { web: 0, mobile: 0 },
        },
        updatedAt: controls?.updated_at ?? null,
      };
    });
  }

  /** Applies the changes, then returns the workspace's access as now stored. */
  async setFeatures(tenantId: string, changes: { key: string; state: FeatureSwitchState }[]): Promise<WorkspaceAccess> {
    await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const sub = await one<{ id: string; feature_overrides: Record<string, boolean | number> }>(tx, 'select id, feature_overrides from subscriptions where tenant_id = $1 for update', [tenantId]);
      if (!sub) throw Errors.badRequest('no_subscription', 'This workspace has no subscription, so its modules cannot be switched.');
      const before = { ...(sub.feature_overrides ?? {}) };
      const next = { ...before };
      for (const c of changes) {
        if (isCoreFeature(c.key)) throw Errors.badRequest('core_feature', 'Core HR cannot be switched off.');
        if (c.state === 'plan') delete next[c.key];
        else next[c.key] = c.state === 'on';
      }
      await tx.query('update subscriptions set feature_overrides = $2 where id = $1', [sub.id, JSON.stringify(next)]);
      const diff = changes.map((c) => ({ module: c.key, from: stateOf(before[c.key]), to: c.state }));
      await this.record(tx, tenantId, 'access.modules_switched', 'subscription', sub.id, { modules: diff });
    });
    return this.workspace(tenantId);
  }

  async setPermissions(tenantId: string, changes: { key: string; enabled: boolean }[]): Promise<WorkspaceAccess> {
    await this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const row = await one<{ disabled_permissions: string[] }>(tx, 'select disabled_permissions from tenant_access_controls where tenant_id = $1 for update', [tenantId]);
      const disabled = new Set(row?.disabled_permissions ?? []);
      for (const c of changes) c.enabled ? disabled.delete(c.key) : disabled.add(c.key);
      const list = [...disabled].sort();
      await tx.query(
        `insert into tenant_access_controls (tenant_id, disabled_permissions, updated_by_admin_id, updated_at) values ($1, $2, $3, now())
         on conflict (tenant_id) do update set disabled_permissions = excluded.disabled_permissions, updated_by_admin_id = excluded.updated_by_admin_id, updated_at = now()`,
        [tenantId, list, requestContext.platformActor().adminId],
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
      const before = (await one<{ web: boolean; mobile: boolean; web_off: string[]; mobile_off: string[] }>(
        tx, 'select web_portal_enabled as web, mobile_app_enabled as mobile, web_off_features as web_off, mobile_off_features as mobile_off from tenant_access_controls where tenant_id = $1 for update', [tenantId],
      ))!;
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
      await tx.query(
        `update tenant_access_controls set web_portal_enabled = $2, mobile_app_enabled = $3, web_off_features = $4, mobile_off_features = $5,
                updated_by_admin_id = $6, updated_at = now() where tenant_id = $1`,
        [tenantId, after.web, after.mobile, after.webOff, after.mobileOff, requestContext.platformActor().adminId],
      );
      let signedOut = 0;
      for (const app of ['web', 'mobile'] as const) {
        if (before[app] && !after[app]) {
          signedOut += (await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'app_switched_off' where tenant_id = $1 and client = $2 and revoked_at is null`, [tenantId, app])).rowCount ?? 0;
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
      const params: unknown[] = [tenantId];
      let filter = '';
      if (q.q) {
        params.push(`%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        filter = `and (u.full_name ilike $${params.length} or u.email::text ilike $${params.length})`;
      }
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n from memberships m join users u on u.id = m.user_id where m.tenant_id = $1 ${filter}`, params))!.n;
      params.push(q.limit, q.offset);
      const items = await many<MemberAccessRow>(
        tx,
        `select m.id as "membershipId", u.full_name as "fullName", u.email::text as email, m.status,
                coalesce((select array_agg(r.name order by r.name) from role_assignments ra join roles r on r.id = ra.role_id where ra.membership_id = m.id), '{}') as roles,
                coalesce(a.blocked_features, '{}') as "blockedFeatures"
           from memberships m join users u on u.id = m.user_id
           left join member_feature_access a on a.membership_id = m.id
          where m.tenant_id = $1 ${filter}
          order by (m.status = 'active') desc, u.full_name, m.id
          limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      return { items, total };
    });
  }

  async setMemberFeatures(tenantId: string, membershipId: string, blockedFeatures: string[]) {
    return this.db.platform(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const m = await one<{ email: string }>(tx, 'select u.email::text as email from memberships m join users u on u.id = m.user_id where m.id = $1 and m.tenant_id = $2', [membershipId, tenantId]);
      if (!m) throw Errors.notFound('Member');
      const before = (await one<{ blocked_features: string[] }>(tx, 'select blocked_features from member_feature_access where membership_id = $1 for update', [membershipId]))?.blocked_features ?? [];
      if (blockedFeatures.length) {
        await tx.query(
          `insert into member_feature_access (tenant_id, membership_id, blocked_features, updated_by_admin_id, updated_at) values ($1, $2, $3, $4, now())
           on conflict (tenant_id, membership_id) do update set blocked_features = excluded.blocked_features, updated_by_admin_id = excluded.updated_by_admin_id, updated_at = now()`,
          [tenantId, membershipId, blockedFeatures, requestContext.platformActor().adminId],
        );
      } else {
        await tx.query('delete from member_feature_access where membership_id = $1', [membershipId]);
      }
      await this.record(tx, tenantId, 'access.member_modules_changed', 'membership', membershipId, { member: m.email, blockedBefore: before, blockedNow: blockedFeatures });
      return { membershipId, blockedFeatures };
    });
  }

  private async ensureRow(tx: Tx, tenantId: string) {
    await tx.query(`insert into tenant_access_controls (tenant_id) values ($1) on conflict (tenant_id) do nothing`, [tenantId]);
  }

  private async requireTenant(tx: Tx, tenantId: string) {
    if (!(await one(tx, 'select 1 from tenants where id = $1', [tenantId]))) throw Errors.notFound('Workspace');
  }

  private async record(tx: Tx, tenantId: string, action: string, resourceType: string, resourceId: string, changes: Record<string, unknown>) {
    await this.audit.record(tx, { tenantId, action, resourceType, resourceId, changes, metadata: { by: 'SAMPLEDGE' } });
    await this.audit.record(tx, { tenantId: null, action: `platform.${action.replace('.', '_')}`, resourceType: 'tenant', resourceId: tenantId, changes });
  }
}

function stateOf(v: boolean | number | undefined): FeatureSwitchState {
  return v === true ? 'on' : v === false ? 'off' : 'plan';
}

import { Inject, Injectable } from '@nestjs/common';
import { mongo } from '@crew/db';
import type { z } from 'zod';
import type { platformCreateTenantRequest } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { hashPassword, randomToken, sha256 } from '../../platform/auth/crypto';
import { requestContext } from '../../platform/context/request-context';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { currentKeyId, fieldKeyStatus } from '../../platform/auth/field-key-rotation';
import { pingClamd } from '../../platform/storage/malware-scan';
import { countBy, ilike, MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { PlatformIntegrationsService } from '../../platform/integrations/platform-integrations.service';
import { decodeCursor, page } from '../../platform/http/pagination';

/**
 * SAMPLEDGE Super Admin operations. Runs with the platform database role, so every method here is written
 * to touch only platform-level data (tenants, subscriptions, plans, health), never tenant HR data. Viewing a
 * tenant's workspace requires an approved support access grant (see supportView).
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly integrations: PlatformIntegrationsService,
  ) {}

  async metrics() {
    return this.db.platform(async (tx) => {
      const all = await tx.collection<{ id: string; status: string; is_demo: boolean; created_at: Date }>('tenants').find({}, { projection: { status: 1, is_demo: 1, created_at: 1 } });
      const monthAgo = Date.now() - 30 * DAY;
      const tenants = {
        total: all.length,
        active: all.filter((t) => t.status === 'active').length,
        suspended: all.filter((t) => t.status === 'suspended').length,
        demo: all.filter((t) => t.is_demo).length,
        newLast30Days: all.filter((t) => t.created_at.getTime() > monthAgo).length,
      };
      const byId = new Map(all.map((t) => [t.id, t]));
      const subsAll = await tx.collection<SubRow>('subscriptions').find();
      const plans = new Map((await tx.collection<{ id: string; key: string; name: string; sort_order: number }>('plans').find()).map((p) => [p.id, p]));
      const real = subsAll.filter((x) => byId.has(x.tenant_id) && !byId.get(x.tenant_id)!.is_demo && plans.has(x.plan_id));
      const groups = new Map<string, { plan: string; status: string; tenants: number; seats: number; order: number }>();
      for (const x of real) {
        const p = plans.get(x.plan_id)!;
        const g = groups.get(`${p.key}|${x.status}`) ?? { plan: p.key, status: x.status, tenants: 0, seats: 0, order: p.sort_order };
        g.tenants += 1;
        g.seats += x.seats;
        groups.set(`${p.key}|${x.status}`, g);
      }
      const subs = [...groups.values()].sort((a, b) => a.order - b.order).map(({ order: _o, ...g }) => g);
      const cents = new Map<string, bigint>();
      for (const x of real.filter((r) => r.status === 'active')) cents.set(x.currency, (cents.get(x.currency) ?? 0n) + BigInt(x.seats) * toCents(x.unit_price));
      const mrr = [...cents].sort(([a], [b]) => cmp(a, b)).map(([currency, c]) => ({ currency, mrr: fromCents(c) }));
      const today = isoDay(new Date());
      const weekOut = isoDay(new Date(Date.now() + 7 * DAY));
      const trialsEnding = subsAll
        .filter((x) => x.status === 'trialing' && x.trial_ends_on && x.trial_ends_on <= weekOut && byId.has(x.tenant_id))
        .sort((a, b) => cmp(a.trial_ends_on!, b.trial_ends_on!))
        .slice(0, 20);
      const trialTenants = new Map((await tx.collection<{ id: string; name: string; slug: string }>('tenants').find({ id: { $in: trialsEnding.map((x) => x.tenant_id) } })).map((t) => [t.id, t]));
      const memberships = tx.collection('memberships');
      const members = { total: await memberships.count(), active: await memberships.count({ status: 'active' }) };
      const signups = Array.from({ length: 30 }, (_, i) => {
        const day = isoDay(new Date(Date.parse(today) - (29 - i) * DAY));
        return { day, count: all.filter((t) => isoDay(t.created_at) === day).length };
      });
      return {
        tenants, subscriptions: subs, mrrByCurrency: mrr,
        trialsEnding: trialsEnding.map((x) => ({ id: x.tenant_id, name: trialTenants.get(x.tenant_id)?.name, slug: trialTenants.get(x.tenant_id)?.slug, trialEndsOn: x.trial_ends_on })),
        members, signups, note: 'MRR counts active (non-trial, non-demo) subscriptions at list price.',
      };
    });
  }

  async tenants(q: { limit: number; cursor?: string; q?: string; status?: string }) {
    return this.db.platform(async (tx) => {
      const and: Record<string, unknown>[] = [];
      if (q.q) and.push({ $or: [{ name: ilike(q.q) }, { slug: ilike(q.q) }] });
      if (q.status) and.push({ status: q.status });
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        const at = new Date(cursor[0]);
        and.push({ $or: [{ created_at: { $lt: at } }, { created_at: at, id: { $lt: cursor[1] } }] });
      }
      const ts = await tx.collection<{ id: string; name: string; slug: string; status: string; region: string; country_code: string; is_demo: boolean; created_at: Date }>('tenants')
        .find(and.length ? { $and: and } : {}, { sort: { created_at: -1, id: -1 }, limit: q.limit + 1 });
      const ids = ts.map((t) => t.id);
      const subs = new Map((await tx.collection<SubRow>('subscriptions').find({ tenant_id: { $in: ids } })).map((x) => [x.tenant_id, x]));
      const plans = new Map((await tx.collection<{ id: string; key: string }>('plans').find()).map((p) => [p.id, p.key]));
      const active = await countBy(tx, 'memberships', 'tenant_id', ids, { status: 'active' });
      const rows = ts.map((t) => {
        const x = subs.get(t.id);
        return {
          id: t.id, name: t.name, slug: t.slug, status: t.status, region: t.region, countryCode: t.country_code, isDemo: t.is_demo, createdAt: t.created_at,
          plan: x ? plans.get(x.plan_id) ?? null : null, subscriptionStatus: x?.status ?? null, seats: x?.seats ?? null, trialEndsOn: x?.trial_ends_on ?? null,
          activeMembers: active.get(t.id) ?? 0,
        };
      });
      return page(rows, q.limit, (r) => r.createdAt.toISOString());
    });
  }

  async tenant(id: string) {
    return this.db.platform(async (tx) => {
      const t = await tx.collection<{
        id: string; name: string; slug: string; status: string; status_reason: string | null; region: string; country_code: string; timezone: string; currency: string;
        is_demo: boolean; require_mfa: boolean; created_at: Date;
      }>('tenants').findOne({ id });
      if (!t) throw Errors.notFound('Workspace');
      const x = await tx.collection<SubRow>('subscriptions').findOne({ tenant_id: id });
      const p = x ? await tx.collection<{ key: string; name: string }>('plans').findOne({ id: x.plan_id }) : undefined;
      const ms = await tx.collection<{ user_id: string; status: string }>('memberships').find({ tenant_id: id }, { projection: { user_id: 1, status: 1 } });
      const logins = (await tx.collection<{ last_login_at: Date | null }>('users').find({ id: { $in: ms.map((m) => m.user_id) } }, { projection: { last_login_at: 1 } }))
        .map((u) => u.last_login_at).filter((d): d is Date => d instanceof Date);
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const credits = (await tx.collection<{ quantity: string }>('usage_records').find({ tenant_id: id, metric: 'ai_credits', occurred_at: { $gte: monthStart } }, { projection: { quantity: 1 } }))
        .reduce((a, r) => a + Number(r.quantity), 0);
      const grantRows = await tx.collection<{ id: string; reason: string; status: string; duration_minutes: number; created_at: Date; expires_at: Date | null; platform_admin_id: string }>('support_access_grants')
        .find({ tenant_id: id }, { sort: { created_at: -1 }, limit: 20 });
      const emails = new Map((await tx.collection<{ id: string; email: string }>('platform_admins').find({ id: { $in: grantRows.map((g) => g.platform_admin_id) } })).map((a) => [a.id, a.email]));
      return {
        id: t.id, name: t.name, slug: t.slug, status: t.status, statusReason: t.status_reason ?? null, region: t.region, countryCode: t.country_code, timezone: t.timezone, currency: t.currency,
        isDemo: t.is_demo, requireMfa: t.require_mfa, createdAt: t.created_at,
        subscription: {
          plan: p?.key ?? null, planName: p?.name ?? null, status: x?.status ?? null, billingCycle: x?.billing_cycle ?? null, seats: x?.seats ?? null, currency: x?.currency ?? null,
          unitPrice: x?.unit_price ?? null, trialEndsOn: x?.trial_ends_on ?? null, currentPeriodEnd: x?.current_period_end ?? null, currentPeriodStart: x?.current_period_start ?? null,
          cancelAtPeriodEnd: x?.cancel_at_period_end ?? null, featureOverrides: x?.feature_overrides ?? null, provider: x?.provider ?? null,
        },
        activeMembers: ms.filter((m) => m.status === 'active').length,
        pendingInvites: ms.filter((m) => m.status === 'invited').length,
        legalEntities: await tx.collection('legal_entities').count({ tenant_id: id, archived_at: null }),
        lastActivityAt: logins.length ? new Date(Math.max(...logins.map((d) => d.getTime()))) : null,
        aiCreditsThisMonth: credits,
        supportAccess: grantRows.map((g) => ({
          id: g.id, reason: g.reason, status: g.status, durationMinutes: g.duration_minutes, createdAt: g.created_at, expiresAt: g.expires_at ?? null, requestedBy: emails.get(g.platform_admin_id) ?? null,
        })),
      };
    });
  }

  async createTenant(input: z.infer<typeof platformCreateTenantRequest>) {
    const token = randomToken(32);
    return this.db.platform(async (tx) => {
      try {
        const t = await mongo.provisionTenantMongo(tx, {
          name: input.companyName,
          slug: input.slug,
          countryCode: input.countryCode,
          currency: input.currency,
          timezone: input.timezone,
          owner: { email: input.ownerEmail, fullName: input.ownerName, passwordHash: null },
          plan: { key: input.planKey, seats: input.seats, billingCycle: 'annual', trialDays: input.trialDays },
        });
        if (!t.existingUser) {
          await tx.collection('invitations').insert({
            tenant_id: t.tenantId, membership_id: t.ownerMembershipId, email: input.ownerEmail, token_hash: sha256(token), expires_at: new Date(Date.now() + 7 * DAY),
          });
        }
        await this.audit.record(tx, { tenantId: t.tenantId, action: 'tenant.created', resourceType: 'tenant', resourceId: t.tenantId, metadata: { via: 'platform_console', plan: input.planKey } });
        await this.audit.record(tx, { tenantId: null, action: 'platform.tenant_created', resourceType: 'tenant', resourceId: t.tenantId, metadata: { slug: input.slug, plan: input.planKey } });
        await this.outbox.publish(tx, t.tenantId, 'tenant.created', { tenantId: t.tenantId });
        const isLocal = process.env.CREW_ENV !== 'production' && process.env.CREW_ENV !== 'staging';
        return {
          tenantId: t.tenantId,
          ownerInviteUrl: !t.existingUser && isLocal ? `${process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000'}/accept-invite?token=${token}` : undefined,
          ownerAlreadyHadAccount: t.existingUser,
        };
      } catch (e) {
        if (e instanceof mongo.SlugTakenError) throw Errors.conflict('slug_taken', e.message);
        throw e;
      }
    });
  }

  async setStatus(id: string, status: 'active' | 'suspended', reason: string) {
    return this.db.platform(async (tx) => {
      if (!(await tx.collection('tenants').exists({ id }))) throw Errors.notFound('Workspace');
      await tx.collection('tenants').updateOne({ id }, { $set: { status, status_reason: reason } });
      if (status === 'suspended') await tx.collection('sessions').update({ tenant_id: id, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'tenant_suspended' } });
      await this.audit.record(tx, { tenantId: id, action: `tenant.${status === 'active' ? 'reactivated' : 'suspended'}`, resourceType: 'tenant', resourceId: id, metadata: { reason, by: 'SAMPLEDGE' } });
      await this.audit.record(tx, { tenantId: null, action: `platform.tenant_${status === 'active' ? 'reactivated' : 'suspended'}`, resourceType: 'tenant', resourceId: id, metadata: { reason } });
      return { id, status };
    });
  }

  async overrideSubscription(id: string, input: {
    planKey?: string; status?: string; seats?: number; trialEndsOn?: string | null; featureOverrides?: Record<string, boolean | number>;
    billingCycle?: string; unitPrice?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; limits?: Partial<Record<string, number | null>>;
  }) {
    return this.db.platform(async (tx) => {
      const subscriptions = tx.collection<{ id: string; feature_overrides: Record<string, boolean | number>; current_period_start: string }>('subscriptions');
      if (!(await subscriptions.lock({ tenant_id: id }))) throw Errors.notFound('Subscription');
      const sub = (await subscriptions.findOne({ tenant_id: id }))!;
      const set: Record<string, unknown> = {};
      if (input.planKey) {
        const plan = await tx.collection<{ id: string }>('plans').findOne({ key: input.planKey });
        if (!plan) throw Errors.badRequest('unknown_plan', 'Unknown plan');
        set.plan_id = plan.id;
      }
      if (input.status) set.status = input.status;
      if (input.seats) set.seats = input.seats;
      if (input.trialEndsOn !== undefined) set.trial_ends_on = input.trialEndsOn;
      if (input.billingCycle) set.billing_cycle = input.billingCycle;
      if (input.unitPrice) set.unit_price = input.unitPrice;
      if (input.cancelAtPeriodEnd !== undefined) set.cancel_at_period_end = input.cancelAtPeriodEnd;
      if (input.currentPeriodEnd) {
        if (input.currentPeriodEnd <= sub.current_period_start) throw Errors.badRequest('period_end_before_start', `The period end must be after the period start (${sub.current_period_start}).`);
        set.current_period_end = input.currentPeriodEnd;
      }
      if (input.limits && !input.featureOverrides) {
        // Limits live with the module switches; merge so neither overwrites the other.
        const next = { ...(sub.feature_overrides ?? {}) };
        for (const [k, v] of Object.entries(input.limits)) {
          if (v === null || v === undefined) delete next[k];
          else next[k] = v;
        }
        set.feature_overrides = next;
      }
      if (input.featureOverrides) {
        const known = new Set(await tx.collection('features').distinct<string>('key'));
        const unknown = Object.keys(input.featureOverrides).filter((k) => !known.has(k));
        if (unknown.length) throw Errors.badRequest('unknown_feature', `Unknown feature: ${unknown.join(', ')}`);
        set.feature_overrides = input.featureOverrides;
      }
      if (!Object.keys(set).length) return { ok: true };
      await subscriptions.updateOne({ tenant_id: id }, { $set: set });
      await this.audit.record(tx, { tenantId: id, action: 'subscription.overridden', resourceType: 'subscription', resourceId: sub.id, changes: input, metadata: { by: 'SAMPLEDGE' } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.subscription_overridden', resourceType: 'tenant', resourceId: id, changes: input });
      return { ok: true };
    });
  }

  async setPrice(planKey: string, input: { currency: string; monthly: string; annualPerMonth: string }) {
    return this.db.platform(async (tx) => {
      const plan = await tx.collection<{ id: string }>('plans').findOne({ key: planKey });
      if (!plan) throw Errors.notFound('Plan');
      const price = { monthly_per_seat: input.monthly, annual_per_seat_month: input.annualPerMonth };
      await tx.collection('plan_prices').upsert({ plan_id: plan.id, currency: input.currency }, { plan_id: plan.id, currency: input.currency, ...price }, { $set: price });
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_price_changed', resourceType: 'plan', resourceId: planKey, changes: input });
      return { ok: true, note: 'New prices apply to new subscriptions and plan changes. Existing subscriptions keep their price until renewal.' };
    });
  }

  async health() {
    const scanner = await this.integrations.scanningUrl();
    const services = await this.integrations.workspaceStatus();
    const started = Date.now();
    return this.db.platform(async (tx) => {
      const db = tx.database;
      await db.command({ ping: 1 });
      const latencyMs = Date.now() - started;
      const outboxEvents = tx.collection<{ occurred_at: Date }>('outbox_events');
      const oldest = await outboxEvents.findOne({ published_at: null }, { sort: { occurred_at: 1 }, projection: { occurred_at: 1 } });
      const outbox = {
        pending: await outboxEvents.count({ published_at: null }),
        retrying: await outboxEvents.count({ published_at: null, attempts: { $gt: 0 } }),
        oldestPendingSeconds: oldest ? Math.round((Date.now() - oldest.occurred_at.getTime()) / 1000) : null,
      };
      const applied = new Set((await db.collection<{ _id: string }>(mongo.MIGRATIONS_COLLECTION).find({}, { session: tx.session }).toArray()).map((m) => String(m._id)));
      const chain = await mongo.verifyAuditChain(db, null);
      return {
        api: { status: 'ok', uptimeSeconds: Math.round(process.uptime()), node: process.version, memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
        database: { status: 'ok', latencyMs, ...(await databaseStats(tx)) },
        migrations: { applied: applied.size, pending: mongo.MONGO_MIGRATIONS.map((m) => m.name).filter((n) => !applied.has(n)) },
        outbox,
        platformAuditChain: { checked: chain.checked, intact: chain.firstBrokenSeq === null },
        fieldEncryption: await this.fieldEncryption(),
        uploadScanning: scanner ? { configured: true, reachable: await pingClamd(scanner) } : { configured: false, reachable: false },
        integrations: services.map((s) => ({ key: s.key, name: s.name, on: s.on })),
        notConfigured: [
          ...(this.config.REDIS_URL ? [] : ['Redis (rate limits shared by several API servers)']),
          ...services.filter((s) => !s.on).map((s) => `${s.name} (Console > Integrations)`),
          'Object storage (files are on the API server\'s disk)',
          'Error tracking (Sentry)',
          'Payment provider',
        ],
      };
    });
  }

  /** Which key encrypts new values, and how many stored values still need the re-encryption job. */
  private async fieldEncryption() {
    const status = await fieldKeyStatus(this.db, this.config.fieldKeys);
    return {
      keyId: currentKeyId(this.config.fieldKeys),
      previousKeys: this.config.fieldKeys.split(',').length - 1,
      olderValues: status.reduce((a, r) => a + r.pending, 0),
    };
  }

  async platformAudit(limit = 100) {
    return this.db.platform(async (tx) =>
      (await tx.collection('audit_events').find({ tenant_id: null }, { sort: { chain_seq: -1 }, limit })).map((e) => ({
        id: String(e.id), actorType: e.actor_type, actorLabel: e.actor_label ?? null, action: e.action, resourceType: e.resource_type ?? null, resourceId: e.resource_id ?? null,
        changes: e.changes ?? null, metadata: e.metadata ?? null, ip: e.ip ?? null, createdAt: e.created_at,
      })),
    );
  }

  async requestSupportAccess(tenantId: string, reason: string, durationMinutes: number) {
    const a = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      if (!(await tx.collection('tenants').exists({ id: tenantId }))) throw Errors.notFound('Workspace');
      const g = await tx.collection<{ id: string }>('support_access_grants').insert({ tenant_id: tenantId, platform_admin_id: a.adminId, reason, duration_minutes: durationMinutes });
      await this.audit.record(tx, { tenantId, action: 'support_access.requested', resourceType: 'support_access_grant', resourceId: g.id, metadata: { reason, durationMinutes, by: a.label } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.support_access_requested', resourceType: 'tenant', resourceId: tenantId, metadata: { reason } });
      return { id: g.id, status: 'pending', note: 'A workspace owner or admin must approve this in SampCrew under Settings > Support access.' };
    });
  }

  /** Read-only workspace snapshot, available only during an approved and unexpired support grant. */
  async supportView(tenantId: string) {
    const a = requestContext.platformActor();
    const grant = await this.db.platform((tx) =>
      tx.collection<{ id: string }>('support_access_grants').findOne(
        { tenant_id: tenantId, platform_admin_id: a.adminId, status: 'approved', expires_at: { $gt: new Date() } },
        { sort: { expires_at: -1 } },
      ),
    );
    if (!grant) throw Errors.forbidden('No approved support access for this workspace. Request access and wait for the customer to approve it.');
    // Read through the tenant role so RLS still applies, exactly as for a tenant user.
    return this.db.tenant(
      async (tx) => {
        await this.audit.record(tx, { tenantId, action: 'support_access.viewed', resourceType: 'tenant', resourceId: tenantId, metadata: { grantId: grant.id, by: a.label } });
        const overview = {
          legalEntities: await tx.collection('legal_entities').count({ archived_at: null }),
          locations: await tx.collection('locations').count({ archived_at: null }),
          departments: await tx.collection('departments').count({ archived_at: null }),
          activeMembers: await tx.collection('memberships').count({ status: 'active' }),
        };
        const recentAudit = (await tx.collection('audit_events').find({}, { sort: { chain_seq: -1 }, limit: 25 }))
          .map((e) => ({ action: e.action, actorLabel: e.actor_label ?? null, createdAt: e.created_at }));
        const roleRows = await tx.collection<{ id: string; name: string }>('roles').find({}, { projection: { name: 1 } });
        const held = await countBy(tx, 'role_assignments', 'role_id', roleRows.map((r) => r.id));
        const byName = new Map<string, number>();
        for (const r of roleRows) byName.set(r.name, (byName.get(r.name) ?? 0) + (held.get(r.id) ?? 0));
        const roles = [...byName].map(([name, members]) => ({ name, members })).sort((x, y) => y.members - x.members);
        return { grantId: grant.id, overview, roles, recentAudit };
      },
      { tenantId },
    );
  }

  admins() {
    return this.db.platform(async (tx) =>
      (await tx.collection('platform_admins').find({}, { sort: { email: 1 } })).map((a) => ({
        id: a.id, email: a.email, fullName: a.full_name, role: a.role, mfaEnabled: a.mfa_enabled, status: a.status, lastLoginAt: a.last_login_at ?? null,
        mustChangePassword: a.must_change_password === true, locked: !!a.locked_until && (a.locked_until as Date) > new Date(),
      })),
    );
  }

  async createAdmin(input: { email: string; fullName: string; role: string; password: string }) {
    const hash = await hashPassword(input.password);
    return this.db.platform(async (tx) => {
      if (await tx.collection('platform_admins').exists({ email: input.email })) throw Errors.conflict('admin_exists', 'An admin with this email exists');
      // The password was chosen by someone else, so the new admin picks their own at first sign-in.
      const r = await tx.collection<{ id: string }>('platform_admins').insert({ email: input.email, full_name: input.fullName, role: input.role, password_hash: hash, must_change_password: true });
      await this.audit.record(tx, { tenantId: null, action: 'platform.admin_created', resourceType: 'platform_admin', resourceId: r.id, changes: { email: input.email, role: input.role } });
      return { id: r.id };
    });
  }

  /**
   * Changes another admin's name, role or status. Nobody changes their own role or status (so a Super admin cannot
   * lock themselves out by mistake), and the last active Super admin cannot be demoted or disabled. Disabling signs
   * the admin out everywhere at once.
   */
  async updateAdmin(id: string, input: { fullName?: string; role?: string; status?: 'active' | 'disabled' }) {
    const actor = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      const admins = tx.collection<AdminRecord>('platform_admins');
      const target = await admins.findOne({ id });
      if (!target) throw Errors.notFound('Admin');
      if (id === actor.adminId && ((input.role && input.role !== target.role) || (input.status && input.status !== target.status))) {
        throw Errors.conflict('own_account', 'You cannot change your own role or status. Ask another Super admin.');
      }
      const role = input.role ?? target.role;
      const status = input.status ?? target.status;
      if (target.role === 'super_admin' && target.status === 'active' && (role !== 'super_admin' || status !== 'active')) await this.keepOneSuperAdmin(tx, id);
      const changes: Record<string, unknown> = {};
      if (input.fullName !== undefined && input.fullName !== target.full_name) changes.full_name = input.fullName;
      if (role !== target.role) changes.role = role;
      if (status !== target.status) changes.status = status;
      if (!Object.keys(changes).length) return this.adminView(target);
      await admins.updateOne({ id }, { $set: changes });
      // A new role or a disabled account takes effect now, not when the current tokens run out.
      if (changes.role || status === 'disabled') await this.revokeSessions(tx, id);
      const action = changes.status ? (status === 'disabled' ? 'platform.admin_disabled' : 'platform.admin_enabled') : 'platform.admin_updated';
      await this.audit.record(tx, { tenantId: null, action, resourceType: 'platform_admin', resourceId: id, changes: { ...changes, email: target.email } });
      return this.adminView({ ...target, ...changes } as AdminRecord);
    });
  }

  /**
   * Gives another admin a temporary password (forgotten password): clears a lockout, signs them out everywhere and
   * makes them choose a new password at their next sign-in. Two-step verification stays as it was.
   */
  async resetAdminPassword(id: string, password: string) {
    const actor = requestContext.platformActor();
    if (id === actor.adminId) throw Errors.conflict('own_account', 'Change your own password from your account menu instead.');
    const hash = await hashPassword(password);
    return this.db.platform(async (tx) => {
      const admins = tx.collection<AdminRecord>('platform_admins');
      const target = await admins.findOne({ id });
      if (!target) throw Errors.notFound('Admin');
      await admins.updateOne({ id }, { $set: { password_hash: hash, must_change_password: true, failed_login_count: 0, locked_until: null } });
      await this.revokeSessions(tx, id);
      await this.audit.record(tx, { tenantId: null, action: 'platform.admin_password_reset', resourceType: 'platform_admin', resourceId: id, changes: { email: target.email } });
      return { ok: true };
    });
  }

  /**
   * Removes another admin's two-step verification (lost or replaced phone). They sign in with their password and set
   * it up again before they can do anything in the console.
   */
  async resetAdminMfa(id: string) {
    const actor = requestContext.platformActor();
    if (id === actor.adminId) throw Errors.conflict('own_account', 'Ask another Super admin to reset your two-step verification.');
    return this.db.platform(async (tx) => {
      const admins = tx.collection<AdminRecord>('platform_admins');
      const target = await admins.findOne({ id });
      if (!target) throw Errors.notFound('Admin');
      await admins.updateOne({ id }, { $set: { mfa_enabled: false, mfa_secret_enc: null, failed_login_count: 0, locked_until: null } });
      await this.revokeSessions(tx, id);
      await this.audit.record(tx, { tenantId: null, action: 'platform.admin_mfa_reset', resourceType: 'platform_admin', resourceId: id, changes: { email: target.email } });
      return { ok: true };
    });
  }

  /** Clears a sign-in lockout (five wrong passwords or codes) before its 15 minutes are up. */
  async unlockAdmin(id: string) {
    return this.db.platform(async (tx) => {
      const admins = tx.collection<AdminRecord>('platform_admins');
      const target = await admins.findOne({ id });
      if (!target) throw Errors.notFound('Admin');
      await admins.updateOne({ id }, { $set: { failed_login_count: 0, locked_until: null } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.admin_unlocked', resourceType: 'platform_admin', resourceId: id, changes: { email: target.email } });
      return { ok: true };
    });
  }

  /**
   * Refuses a change that would leave no active Super admin. The remaining ones are locked first, so two Super admins
   * demoting each other at the same moment conflict and the second sees the first's change.
   */
  private async keepOneSuperAdmin(tx: PlatformTx, leavingId: string) {
    const admins = tx.collection<AdminRecord>('platform_admins');
    const others = await admins.find({ role: 'super_admin', status: 'active', id: { $ne: leavingId } }, { projection: { id: 1 } });
    for (const o of others) await admins.lock({ id: o.id, role: 'super_admin', status: 'active' });
    const still = await admins.count({ role: 'super_admin', status: 'active', id: { $ne: leavingId } });
    if (!still) throw Errors.conflict('last_super_admin', 'This is the last active Super admin. Make someone else a Super admin first.');
  }

  private async revokeSessions(tx: PlatformTx, adminId: string) {
    await tx.collection('platform_sessions').update({ admin_id: adminId, revoked_at: null }, { $set: { revoked_at: new Date() } });
  }

  private adminView(a: AdminRecord) {
    return { id: a.id, email: a.email, fullName: a.full_name, role: a.role, status: a.status, mfaEnabled: a.mfa_enabled };
  }
}

interface AdminRecord { id: string; email: string; full_name: string; role: string; status: 'active' | 'disabled'; mfa_enabled: boolean }

const DAY = 86_400_000;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

interface SubRow {
  tenant_id: string; plan_id: string; status: string; seats: number; currency: string; unit_price: string; billing_cycle: string;
  trial_ends_on: string | null; current_period_start: string; current_period_end: string; cancel_at_period_end: boolean;
  feature_overrides: Record<string, boolean | number>; provider: string;
}

/** A decimal string such as "12.5" or "-3.10" as whole cents. */
function toCents(v: string): bigint {
  const neg = v.startsWith('-');
  const [w = '0', f = ''] = v.replace(/^[-+]/, '').split('.');
  const c = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
}

function fromCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** Size on disk and open connections, worded like the Console expects. Either reading may be refused by a managed host. */
async function databaseStats(tx: PlatformTx): Promise<{ size: string; connections: number }> {
  let size = 'unknown size';
  let connections = 0;
  try {
    const st = (await tx.database.command({ dbStats: 1 })) as { storageSize?: number; indexSize?: number; totalSize?: number };
    size = prettyBytes(st.totalSize ?? (st.storageSize ?? 0) + (st.indexSize ?? 0));
  } catch {
    /* not allowed for this user */
  }
  try {
    const ss = (await tx.database.admin().command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0 })) as { connections?: { current?: number } };
    connections = ss.connections?.current ?? 0;
  } catch {
    /* not allowed for this user */
  }
  return { size, connections };
}

function prettyBytes(n: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 10_240 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${Math.round(n)} ${units[i]}`;
}

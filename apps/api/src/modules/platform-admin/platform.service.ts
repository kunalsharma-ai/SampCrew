import { Injectable } from '@nestjs/common';
import { provisionTenant, readMigrations, SlugTakenError } from '@crew/db';
import type { z } from 'zod';
import type { platformCreateTenantRequest } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { hashPassword, randomToken, sha256 } from '../../platform/auth/crypto';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
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
  ) {}

  async metrics() {
    return this.db.platform(async (tx) => {
      const tenants = await one(
        tx,
        `select count(*)::int as total,
                count(*) filter (where status = 'active')::int as active,
                count(*) filter (where status = 'suspended')::int as suspended,
                count(*) filter (where is_demo)::int as demo,
                count(*) filter (where created_at > now() - interval '30 days')::int as "newLast30Days"
           from tenants`,
      );
      const subs = await many(
        tx,
        `select p.key as plan, s.status, count(*)::int as tenants, sum(s.seats)::int as seats
           from subscriptions s join plans p on p.id = s.plan_id join tenants t on t.id = s.tenant_id
          where not t.is_demo group by p.key, s.status, p.sort_order order by p.sort_order`,
      );
      const mrr = await many(
        tx,
        `select s.currency, sum(s.seats * s.unit_price)::numeric(14,2)::text as mrr
           from subscriptions s join tenants t on t.id = s.tenant_id
          where s.status = 'active' and not t.is_demo group by s.currency order by s.currency`,
      );
      const trialsEnding = await many(
        tx,
        `select t.id, t.name, t.slug::text, to_char(s.trial_ends_on, 'YYYY-MM-DD') as "trialEndsOn"
           from subscriptions s join tenants t on t.id = s.tenant_id
          where s.status = 'trialing' and s.trial_ends_on <= current_date + 7 order by s.trial_ends_on limit 20`,
      );
      const members = await one(tx, `select count(*)::int as total, count(*) filter (where status = 'active')::int as active from memberships`);
      const signups = await many(
        tx,
        `select to_char(d, 'YYYY-MM-DD') as day, (select count(*)::int from tenants t where t.created_at::date = d) as count
           from generate_series(current_date - 29, current_date, interval '1 day') d order by d`,
      );
      return { tenants, subscriptions: subs, mrrByCurrency: mrr, trialsEnding, members, signups, note: 'MRR counts active (non-trial, non-demo) subscriptions at list price.' };
    });
  }

  async tenants(q: { limit: number; cursor?: string; q?: string; status?: string }) {
    return this.db.platform(async (tx) => {
      const params: unknown[] = [];
      const where = ['true'];
      if (q.q) {
        params.push(`%${q.q.toLowerCase()}%`);
        where.push(`(lower(t.name) like $${params.length} or t.slug::text like $${params.length})`);
      }
      if (q.status) {
        params.push(q.status);
        where.push(`t.status = $${params.length}`);
      }
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        params.push(cursor[0], cursor[1]);
        where.push(`(t.created_at, t.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(q.limit + 1);
      const rows = await many<{ id: string; createdAt: Date }>(
        tx,
        `select t.id, t.name, t.slug::text, t.status, t.region, t.country_code as "countryCode", t.is_demo as "isDemo", t.created_at as "createdAt",
                p.key as plan, s.status as "subscriptionStatus", s.seats, to_char(s.trial_ends_on, 'YYYY-MM-DD') as "trialEndsOn",
                (select count(*)::int from memberships m where m.tenant_id = t.id and m.status = 'active') as "activeMembers"
           from tenants t left join subscriptions s on s.tenant_id = t.id left join plans p on p.id = s.plan_id
          where ${where.join(' and ')} order by t.created_at desc, t.id desc limit $${params.length}`,
        params,
      );
      return page(rows, q.limit, (r) => r.createdAt.toISOString());
    });
  }

  async tenant(id: string) {
    return this.db.platform(async (tx) => {
      const t = await one(
        tx,
        `select t.id, t.name, t.slug::text, t.status, t.status_reason as "statusReason", t.region, t.country_code as "countryCode", t.timezone, t.currency,
                t.is_demo as "isDemo", t.require_mfa as "requireMfa", t.created_at as "createdAt",
                json_build_object('plan', p.key, 'planName', p.name, 'status', s.status, 'billingCycle', s.billing_cycle, 'seats', s.seats, 'currency', s.currency,
                  'unitPrice', s.unit_price::text, 'trialEndsOn', to_char(s.trial_ends_on, 'YYYY-MM-DD'), 'currentPeriodEnd', to_char(s.current_period_end, 'YYYY-MM-DD'),
                  'featureOverrides', s.feature_overrides, 'provider', s.provider) as subscription,
                (select count(*)::int from memberships m where m.tenant_id = t.id and m.status = 'active') as "activeMembers",
                (select count(*)::int from memberships m where m.tenant_id = t.id and m.status = 'invited') as "pendingInvites",
                (select count(*)::int from legal_entities le where le.tenant_id = t.id and le.archived_at is null) as "legalEntities",
                (select max(u.last_login_at) from memberships m join users u on u.id = m.user_id where m.tenant_id = t.id) as "lastActivityAt",
                (select coalesce(sum(quantity), 0)::float8 from usage_records ur where ur.tenant_id = t.id and ur.metric = 'ai_credits' and ur.occurred_at >= date_trunc('month', now())) as "aiCreditsThisMonth"
           from tenants t left join subscriptions s on s.tenant_id = t.id left join plans p on p.id = s.plan_id where t.id = $1`,
        [id],
      );
      if (!t) throw Errors.notFound('Workspace');
      const grants = await many(
        tx,
        `select g.id, g.reason, g.status, g.duration_minutes as "durationMinutes", g.created_at as "createdAt", g.expires_at as "expiresAt", a.email::text as "requestedBy"
           from support_access_grants g join platform_admins a on a.id = g.platform_admin_id where g.tenant_id = $1 order by g.created_at desc limit 20`,
        [id],
      );
      return { ...t, supportAccess: grants };
    });
  }

  async createTenant(input: z.infer<typeof platformCreateTenantRequest>) {
    const token = randomToken(32);
    return this.db.platform(async (tx) => {
      try {
        const t = await provisionTenant(tx, {
          name: input.companyName,
          slug: input.slug,
          countryCode: input.countryCode,
          currency: input.currency,
          timezone: input.timezone,
          owner: { email: input.ownerEmail, fullName: input.ownerName, passwordHash: null },
          plan: { key: input.planKey, seats: input.seats, billingCycle: 'annual', trialDays: input.trialDays },
        });
        if (!t.existingUser) {
          await tx.query(
            `insert into invitations (tenant_id, membership_id, email, token_hash, expires_at) values ($1, $2, $3, $4, now() + interval '7 days')`,
            [t.tenantId, t.ownerMembershipId, input.ownerEmail, sha256(token)],
          );
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
        if (e instanceof SlugTakenError) throw Errors.conflict('slug_taken', e.message);
        throw e;
      }
    });
  }

  async setStatus(id: string, status: 'active' | 'suspended', reason: string) {
    return this.db.platform(async (tx) => {
      const r = await tx.query('update tenants set status = $2, status_reason = $3 where id = $1 returning id', [id, status, reason]);
      if (!r.rowCount) throw Errors.notFound('Workspace');
      if (status === 'suspended') await tx.query(`update sessions set revoked_at = now(), revoked_reason = 'tenant_suspended' where tenant_id = $1 and revoked_at is null`, [id]);
      await this.audit.record(tx, { tenantId: id, action: `tenant.${status === 'active' ? 'reactivated' : 'suspended'}`, resourceType: 'tenant', resourceId: id, metadata: { reason, by: 'SAMPLEDGE' } });
      await this.audit.record(tx, { tenantId: null, action: `platform.tenant_${status === 'active' ? 'reactivated' : 'suspended'}`, resourceType: 'tenant', resourceId: id, metadata: { reason } });
      return { id, status };
    });
  }

  async overrideSubscription(id: string, input: { planKey?: string; status?: string; seats?: number; trialEndsOn?: string | null; featureOverrides?: Record<string, boolean | number> }) {
    return this.db.platform(async (tx) => {
      const sub = await one<{ id: string }>(tx, 'select id from subscriptions where tenant_id = $1 for update', [id]);
      if (!sub) throw Errors.notFound('Subscription');
      const sets: string[] = [];
      const params: unknown[] = [id];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        sets.push(sql.replace('?', `$${params.length}`));
      };
      if (input.planKey) {
        const plan = await one<{ id: string }>(tx, 'select id from plans where key = $1', [input.planKey]);
        if (!plan) throw Errors.badRequest('unknown_plan', 'Unknown plan');
        add('plan_id = ?', plan.id);
      }
      if (input.status) add('status = ?', input.status);
      if (input.seats) add('seats = ?', input.seats);
      if (input.trialEndsOn !== undefined) add('trial_ends_on = ?', input.trialEndsOn);
      if (input.featureOverrides) {
        const known = new Set((await many<{ key: string }>(tx, 'select key from features')).map((f) => f.key));
        const unknown = Object.keys(input.featureOverrides).filter((k) => !known.has(k));
        if (unknown.length) throw Errors.badRequest('unknown_feature', `Unknown feature: ${unknown.join(', ')}`);
        add('feature_overrides = ?', JSON.stringify(input.featureOverrides));
      }
      if (!sets.length) return { ok: true };
      await tx.query(`update subscriptions set ${sets.join(', ')} where tenant_id = $1`, params);
      await this.audit.record(tx, { tenantId: id, action: 'subscription.overridden', resourceType: 'subscription', resourceId: sub.id, changes: input, metadata: { by: 'SAMPLEDGE' } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.subscription_overridden', resourceType: 'tenant', resourceId: id, changes: input });
      return { ok: true };
    });
  }

  plans() {
    return this.db.platform(async (tx) => {
      const plans = await many<{ id: string }>(tx, 'select id, key, name, tagline, quote_only as "quoteOnly", minimum_seats as "minimumSeats", is_public as "isPublic" from plans order by sort_order');
      const prices = await many<{ plan_id: string }>(tx, 'select plan_id, currency, monthly_per_seat::text as monthly, annual_per_seat_month::text as "annualPerMonth" from plan_prices order by currency');
      const features = await many<{ plan_id: string }>(tx, 'select plan_id, feature_key as key, limit_value as "limitValue" from plan_features order by feature_key');
      const counts = await many<{ plan_id: string; n: number }>(tx, 'select plan_id, count(*)::int as n from subscriptions group by plan_id');
      return plans.map((p) => ({
        ...p,
        prices: prices.filter((x) => x.plan_id === p.id).map(({ plan_id: _p, ...rest }) => rest),
        features: features.filter((x) => x.plan_id === p.id).map(({ plan_id: _p, ...rest }) => rest),
        tenants: counts.find((c) => c.plan_id === p.id)?.n ?? 0,
      }));
    });
  }

  async setPrice(planKey: string, input: { currency: string; monthly: string; annualPerMonth: string }) {
    return this.db.platform(async (tx) => {
      const plan = await one<{ id: string }>(tx, 'select id from plans where key = $1', [planKey]);
      if (!plan) throw Errors.notFound('Plan');
      await tx.query(
        `insert into plan_prices (plan_id, currency, monthly_per_seat, annual_per_seat_month) values ($1, $2, $3, $4)
         on conflict (plan_id, currency) do update set monthly_per_seat = excluded.monthly_per_seat, annual_per_seat_month = excluded.annual_per_seat_month`,
        [plan.id, input.currency, input.monthly, input.annualPerMonth],
      );
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_price_changed', resourceType: 'plan', resourceId: planKey, changes: input });
      return { ok: true, note: 'New prices apply to new subscriptions and plan changes. Existing subscriptions keep their price until renewal.' };
    });
  }

  async health() {
    const started = Date.now();
    return this.db.platform(async (tx) => {
      await tx.query('select 1');
      const latencyMs = Date.now() - started;
      const outbox = await one(
        tx,
        `select count(*) filter (where published_at is null)::int as pending, count(*) filter (where published_at is null and attempts > 0)::int as retrying,
                extract(epoch from now() - min(occurred_at) filter (where published_at is null))::int as "oldestPendingSeconds" from outbox_events`,
      );
      const applied = await many<{ name: string }>(tx, 'select name, applied_at as "appliedAt" from schema_migrations order by name');
      const files = readMigrations().map((m) => m.name);
      const chain = await one<{ checked: string; first_broken_seq: string | null }>(tx, 'select * from audit_verify_chain(null)');
      const db = await one(tx, `select pg_size_pretty(pg_database_size(current_database())) as size, (select count(*)::int from pg_stat_activity where datname = current_database()) as connections`);
      return {
        api: { status: 'ok', uptimeSeconds: Math.round(process.uptime()), node: process.version, memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
        database: { status: 'ok', latencyMs, ...db },
        migrations: { applied: applied.length, pending: files.filter((f) => !applied.some((a) => a.name === f)) },
        outbox,
        platformAuditChain: { checked: Number(chain!.checked), intact: chain!.first_broken_seq === null },
        notConfigured: ['Redis (queues and distributed rate limits)', 'Object storage', 'Error tracking (Sentry)', 'Payment provider'],
      };
    });
  }

  async platformAudit(limit = 100) {
    return this.db.platform((tx) =>
      many(
        tx,
        `select id::text, actor_type as "actorType", actor_label as "actorLabel", action, resource_type as "resourceType", resource_id as "resourceId",
                changes, metadata, host(ip) as ip, created_at as "createdAt"
           from audit_events where tenant_id is null order by chain_seq desc limit $1`,
        [limit],
      ),
    );
  }

  async requestSupportAccess(tenantId: string, reason: string, durationMinutes: number) {
    const a = requestContext.platformActor();
    return this.db.platform(async (tx) => {
      if (!(await one(tx, 'select 1 from tenants where id = $1', [tenantId]))) throw Errors.notFound('Workspace');
      const g = (await one<{ id: string }>(
        tx,
        `insert into support_access_grants (tenant_id, platform_admin_id, reason, duration_minutes) values ($1, $2, $3, $4) returning id`,
        [tenantId, a.adminId, reason, durationMinutes],
      ))!;
      await this.audit.record(tx, { tenantId, action: 'support_access.requested', resourceType: 'support_access_grant', resourceId: g.id, metadata: { reason, durationMinutes, by: a.label } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.support_access_requested', resourceType: 'tenant', resourceId: tenantId, metadata: { reason } });
      return { id: g.id, status: 'pending', note: 'A workspace owner or admin must approve this in CREW under Settings > Support access.' };
    });
  }

  /** Read-only workspace snapshot, available only during an approved and unexpired support grant. */
  async supportView(tenantId: string) {
    const a = requestContext.platformActor();
    const grant = await this.db.platform((tx) =>
      one<{ id: string }>(
        tx,
        `select id from support_access_grants where tenant_id = $1 and platform_admin_id = $2 and status = 'approved' and expires_at > now() order by expires_at desc limit 1`,
        [tenantId, a.adminId],
      ),
    );
    if (!grant) throw Errors.forbidden('No approved support access for this workspace. Request access and wait for the customer to approve it.');
    // Read through the tenant role so RLS still applies, exactly as for a tenant user.
    return this.db.tenant(
      async (tx) => {
        await this.audit.record(tx, { tenantId, action: 'support_access.viewed', resourceType: 'tenant', resourceId: tenantId, metadata: { grantId: grant.id, by: a.label } });
        const overview = await one(
          tx,
          `select (select count(*)::int from legal_entities where archived_at is null) as "legalEntities", (select count(*)::int from locations where archived_at is null) as locations,
                  (select count(*)::int from departments where archived_at is null) as departments, (select count(*)::int from memberships where status = 'active') as "activeMembers"`,
        );
        const recentAudit = await many(tx, `select action, actor_label as "actorLabel", created_at as "createdAt" from audit_events order by chain_seq desc limit 25`);
        const roles = await many(tx, `select r.name, count(ra.id)::int as members from roles r left join role_assignments ra on ra.role_id = r.id group by r.name order by members desc`);
        return { grantId: grant.id, overview, roles, recentAudit };
      },
      { tenantId },
    );
  }

  admins() {
    return this.db.platform((tx) =>
      many(tx, `select id, email::text, full_name as "fullName", role, mfa_enabled as "mfaEnabled", status, last_login_at as "lastLoginAt" from platform_admins order by email`),
    );
  }

  async createAdmin(input: { email: string; fullName: string; role: string; password: string }) {
    const hash = await hashPassword(input.password);
    return this.db.platform(async (tx) => {
      if (await one(tx, 'select 1 from platform_admins where email = $1', [input.email])) throw Errors.conflict('admin_exists', 'An admin with this email exists');
      const r = (await one<{ id: string }>(tx, `insert into platform_admins (email, full_name, role, password_hash) values ($1, $2, $3, $4) returning id`, [input.email, input.fullName, input.role, hash]))!;
      await this.audit.record(tx, { tenantId: null, action: 'platform.admin_created', resourceType: 'platform_admin', resourceId: r.id, changes: { email: input.email, role: input.role } });
      return { id: r.id };
    });
  }
}

import { Injectable } from '@nestjs/common';
import { FEATURES, isCoreFeature, LIMIT_KEYS, type PlanCreate, type PlanEntitlementsUpdate, type PlanUpdate } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';

const BOOLEAN_KEYS = new Set<string>(FEATURES.filter((f) => f.kind === 'boolean').map((f) => f.key));
const CORE_KEYS = FEATURES.filter((f) => isCoreFeature(f.key)).map((f) => f.key as string);

interface PlanRow { id: string; key: string; name: string; quote_only: boolean; is_public: boolean; archived_at: string | null }

/**
 * The plan builder. SAMPLEDGE decides here which modules and limits each plan includes; a workspace's
 * subscription then decides what it can use (EntitlementsService reads plan_features on every request, so a
 * change applies to every workspace on the plan straight away). Workspace-specific switches and limits in the
 * Console still sit on top of the plan.
 */
@Injectable()
export class PlansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  list() {
    return this.db.platform(async (tx) => {
      const plans = await many<{ id: string }>(
        tx,
        `select p.id, p.key, p.name, coalesce(p.tagline, '') as tagline, p.quote_only as "quoteOnly", p.minimum_seats as "minimumSeats", p.is_public as "isPublic",
                p.sort_order as "sortOrder", p.customised_at as "customisedAt", a.full_name as "customisedBy", p.archived_at as "archivedAt"
           from plans p left join platform_admins a on a.id = p.customised_by_admin_id order by p.archived_at is not null, p.sort_order, p.name`,
      );
      const prices = await many<{ plan_id: string }>(tx, 'select plan_id, currency, monthly_per_seat::text as monthly, annual_per_seat_month::text as "annualPerMonth" from plan_prices order by currency');
      const features = await many<{ plan_id: string }>(tx, 'select plan_id, feature_key as key, limit_value as "limitValue" from plan_features order by feature_key');
      const counts = await many<{ plan_id: string; n: number; active: number }>(
        tx, `select plan_id, count(*)::int as n, count(*) filter (where status in ('trialing', 'active', 'past_due'))::int as active from subscriptions group by plan_id`,
      );
      const requests = await many<{ plan_id: string; n: number }>(tx, `select plan_id, count(*)::int as n from plan_requests where status = 'pending' group by plan_id`);
      return plans.map((p) => ({
        ...p,
        prices: prices.filter((x) => x.plan_id === p.id).map(({ plan_id: _p, ...rest }) => rest),
        features: features.filter((x) => x.plan_id === p.id).map(({ plan_id: _p, ...rest }) => rest),
        tenants: counts.find((c) => c.plan_id === p.id)?.n ?? 0,
        activeTenants: counts.find((c) => c.plan_id === p.id)?.active ?? 0,
        pendingRequests: requests.find((c) => c.plan_id === p.id)?.n ?? 0,
      }));
    });
  }

  async create(input: PlanCreate) {
    return this.db.platform(async (tx) => {
      if (await one(tx, 'select 1 from plans where key = $1', [input.key])) throw Errors.conflict('plan_key_taken', `A plan with the key "${input.key}" already exists`);
      const source = input.copyFrom ? await this.plan(tx, input.copyFrom) : undefined;
      const order = input.sortOrder ?? ((await one<{ n: number }>(tx, 'select coalesce(max(sort_order), 0)::int + 1 as n from plans'))!.n);
      const created = (await one<{ id: string }>(
        tx,
        `insert into plans (key, name, tagline, sort_order, minimum_seats, quote_only, is_public, customised_at, customised_by_admin_id)
         values ($1, $2, $3, $4, $5, $6, $7, now(), $8) returning id`,
        [input.key, input.name, input.tagline ?? '', order, input.minimumSeats ?? 1, input.quoteOnly ?? false, input.isPublic ?? false, requestContext.platformActor().adminId],
      ))!;
      if (source) {
        await tx.query('insert into plan_features (plan_id, feature_key, limit_value) select $1, feature_key, limit_value from plan_features where plan_id = $2', [created.id, source.id]);
        await tx.query('insert into plan_prices (plan_id, currency, monthly_per_seat, annual_per_seat_month) select $1, currency, monthly_per_seat, annual_per_seat_month from plan_prices where plan_id = $2', [created.id, source.id]);
      } else {
        for (const key of CORE_KEYS) await tx.query('insert into plan_features (plan_id, feature_key) values ($1, $2)', [created.id, key]);
        // A new plan with no source starts at zero for every limit, so nothing is unlimited by accident.
        for (const key of LIMIT_KEYS) await tx.query('insert into plan_features (plan_id, feature_key, limit_value) values ($1, $2, 0)', [created.id, key]);
      }
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_created', resourceType: 'plan', resourceId: input.key, changes: { ...input } });
      return { key: input.key, id: created.id };
    });
  }

  async update(key: string, input: PlanUpdate) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      const cols: Record<keyof PlanUpdate, string> = { name: 'name', tagline: 'tagline', minimumSeats: 'minimum_seats', quoteOnly: 'quote_only', isPublic: 'is_public', sortOrder: 'sort_order' };
      const sets: string[] = [];
      const params: unknown[] = [plan.id];
      for (const [k, v] of Object.entries(input) as [keyof PlanUpdate, unknown][]) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${cols[k]} = $${params.length}`);
      }
      if (!sets.length) return { ok: true };
      params.push(requestContext.platformActor().adminId);
      await tx.query(`update plans set ${sets.join(', ')}, customised_at = now(), customised_by_admin_id = $${params.length} where id = $1`, params);
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_updated', resourceType: 'plan', resourceId: key, changes: { ...input } });
      return { ok: true };
    });
  }

  /**
   * Replaces the modules a plan includes and sets its limits. The foundation (Core HR) is always included.
   * Takes effect on the next request of every workspace on the plan.
   */
  async setEntitlements(key: string, input: PlanEntitlementsUpdate) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      const unknown = input.features.filter((f) => !BOOLEAN_KEYS.has(f));
      if (unknown.length) throw Errors.badRequest('unknown_feature', `Unknown module: ${unknown.join(', ')}`);
      const next = new Set([...input.features, ...CORE_KEYS]);
      const before = await many<{ feature_key: string; limit_value: number | null; kind: string }>(
        tx, 'select pf.feature_key, pf.limit_value, f.kind from plan_features pf join features f on f.key = pf.feature_key where pf.plan_id = $1', [plan.id],
      );
      const had = new Set(before.filter((r) => r.kind === 'boolean').map((r) => r.feature_key));
      const added = [...next].filter((k) => !had.has(k)).sort();
      const removed = [...had].filter((k) => !next.has(k)).sort();
      await tx.query(`delete from plan_features pf using features f where f.key = pf.feature_key and f.kind = 'boolean' and pf.plan_id = $1`, [plan.id]);
      for (const k of [...next].sort()) await tx.query('insert into plan_features (plan_id, feature_key) values ($1, $2)', [plan.id, k]);
      const limitChanges: Record<string, { from: number | null; to: number }> = {};
      for (const [k, v] of Object.entries(input.limits)) {
        if (v === undefined) continue;
        const prev = before.find((r) => r.feature_key === k)?.limit_value ?? null;
        if (prev !== v) limitChanges[k] = { from: prev, to: v };
        await tx.query(
          `insert into plan_features (plan_id, feature_key, limit_value) values ($1, $2, $3) on conflict (plan_id, feature_key) do update set limit_value = excluded.limit_value`,
          [plan.id, k, v],
        );
      }
      await tx.query('update plans set customised_at = now(), customised_by_admin_id = $2 where id = $1', [plan.id, requestContext.platformActor().adminId]);
      const affected = (await one<{ n: number }>(tx, `select count(*)::int as n from subscriptions where plan_id = $1 and status in ('trialing', 'active', 'past_due')`, [plan.id]))!.n;
      await this.audit.record(tx, {
        tenantId: null, action: 'platform.plan_entitlements_changed', resourceType: 'plan', resourceId: key,
        changes: { added, removed, limits: limitChanges }, metadata: { workspaces: affected },
      });
      // Each affected workspace's own trail records the change too, so its admins can see why a module appeared or went.
      if (added.length || removed.length || Object.keys(limitChanges).length) {
        const tenants = await many<{ tenant_id: string }>(tx, 'select tenant_id from subscriptions where plan_id = $1', [plan.id]);
        for (const t of tenants) {
          await this.audit.record(tx, { tenantId: t.tenant_id, action: 'subscription.plan_contents_changed', resourceType: 'subscription', resourceId: t.tenant_id, changes: { plan: key, added, removed, limits: limitChanges } });
        }
      }
      return { ok: true, added, removed, workspaces: affected };
    });
  }

  async setArchived(key: string, archived: boolean) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      await tx.query(`update plans set archived_at = ${archived ? 'now()' : 'null'} where id = $1`, [plan.id]);
      if (archived) {
        // Open requests for a plan that is no longer sold are declined, so the customer is not left waiting.
        const open = await many<{ id: string; tenant_id: string; requested_by_membership_id: string | null }>(
          tx, `update plan_requests set status = 'declined', decision_note = 'This plan is no longer offered', decided_at = now(), decided_by_admin_id = $2
                where plan_id = $1 and status = 'pending' returning id, tenant_id, requested_by_membership_id`, [plan.id, requestContext.platformActor().adminId],
        );
        for (const r of open) await this.notifications.notify(tx, { membershipIds: [r.requested_by_membership_id], kind: 'billing.plan_request_declined', title: `Your request for the ${plan.name} plan was declined`, body: 'This plan is no longer offered.', link: '/settings/billing' });
      }
      await this.audit.record(tx, { tenantId: null, action: archived ? 'platform.plan_archived' : 'platform.plan_restored', resourceType: 'plan', resourceId: key });
      const n = (await one<{ n: number }>(tx, 'select count(*)::int as n from subscriptions where plan_id = $1', [plan.id]))!.n;
      return { ok: true, note: archived ? `${plan.name} is no longer offered. ${n} workspace(s) on it keep it until they change plan.` : `${plan.name} is offered again.` };
    });
  }

  /** Deletes a plan nobody has ever subscribed to (for example, one created by mistake). */
  async remove(key: string) {
    return this.db.platform(async (tx) => {
      const plan = await this.plan(tx, key);
      if (['starter', 'professional', 'business', 'enterprise'].includes(key)) throw Errors.badRequest('launch_plan', 'The four launch plans can be archived but not deleted');
      if (await one(tx, 'select 1 from subscriptions where plan_id = $1 limit 1', [plan.id])) throw Errors.conflict('plan_in_use', 'Workspaces are on this plan. Archive it instead.');
      await tx.query('delete from plan_requests where plan_id = $1', [plan.id]);
      await tx.query('delete from plans where id = $1', [plan.id]);
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_deleted', resourceType: 'plan', resourceId: key });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Plan requests from workspace admins
  // ---------------------------------------------------------------------------------------------------------

  requests(status?: string) {
    return this.db.platform((tx) =>
      many(
        tx,
        `select r.id, r.tenant_id as "tenantId", t.name as "tenantName", p.key as "planKey", p.name as "planName", cp.key as "currentPlanKey", cp.name as "currentPlanName",
                r.seats, r.billing_cycle as "billingCycle", r.message, r.status, r.requested_by_label as "requestedBy", r.created_at as "createdAt",
                r.decision_note as "decisionNote", r.decided_at as "decidedAt", a.full_name as "decidedBy"
           from plan_requests r join tenants t on t.id = r.tenant_id join plans p on p.id = r.plan_id
           left join subscriptions s on s.tenant_id = r.tenant_id left join plans cp on cp.id = s.plan_id
           left join platform_admins a on a.id = r.decided_by_admin_id
          where ($1::text is null or r.status = $1) order by r.status = 'pending' desc, r.created_at desc limit 200`,
        [status ?? null],
      ),
    );
  }

  async decide(id: string, decision: 'approved' | 'declined', note?: string) {
    return this.db.platform(async (tx) => {
      const r = await one<{ id: string; tenant_id: string; plan_id: string; plan_key: string; plan_name: string; seats: number; billing_cycle: string; status: string; requested_by_membership_id: string | null; archived_at: string | null }>(
        tx,
        `select r.id, r.tenant_id, r.plan_id, p.key as plan_key, p.name as plan_name, r.seats, r.billing_cycle, r.status, r.requested_by_membership_id, p.archived_at
           from plan_requests r join plans p on p.id = r.plan_id where r.id = $1 for update of r`,
        [id],
      );
      if (!r) throw Errors.notFound('Plan request');
      if (r.status !== 'pending') throw Errors.conflict('request_decided', 'This request has already been answered');
      const adminId = requestContext.platformActor().adminId;
      if (decision === 'approved') {
        if (r.archived_at) throw Errors.badRequest('plan_archived', 'This plan is archived. Restore it before approving.');
        const sub = (await one<{ currency: string; plan_key: string; unit_price: string }>(
          tx, 'select s.currency, p.key as plan_key, s.unit_price::text from subscriptions s join plans p on p.id = s.plan_id where s.tenant_id = $1 for update of s', [r.tenant_id],
        ))!;
        const price = await one<{ monthly: string; annual: string }>(tx, 'select monthly_per_seat::text as monthly, annual_per_seat_month::text as annual from plan_prices where plan_id = $1 and currency = $2', [r.plan_id, sub.currency]);
        // A quote-only plan has no list price: the subscription keeps its price until SAMPLEDGE sets the negotiated one.
        const unit = price ? (r.billing_cycle === 'annual' ? price.annual : price.monthly) : sub.unit_price;
        await tx.query(
          `update subscriptions set plan_id = $2, seats = $3, billing_cycle = $4, unit_price = $5,
             status = case when status in ('trialing', 'active') then status else 'active' end
           where tenant_id = $1`,
          [r.tenant_id, r.plan_id, r.seats, r.billing_cycle, unit],
        );
        await this.audit.record(tx, {
          tenantId: r.tenant_id, action: 'subscription.changed', resourceType: 'subscription', resourceId: r.tenant_id,
          changes: { from: { plan: sub.plan_key }, to: { plan: r.plan_key, seats: r.seats, cycle: r.billing_cycle }, via: 'plan_request', requestId: r.id },
        });
      }
      await tx.query('update plan_requests set status = $2, decision_note = $3, decided_at = now(), decided_by_admin_id = $4 where id = $1', [r.id, decision, note ?? null, adminId]);
      await this.audit.record(tx, { tenantId: null, action: `platform.plan_request_${decision}`, resourceType: 'plan_request', resourceId: r.id, metadata: { tenantId: r.tenant_id, plan: r.plan_key } });
      await this.notifications.notify(tx, {
        membershipIds: [r.requested_by_membership_id],
        kind: `billing.plan_request_${decision}`,
        title: decision === 'approved' ? `Your workspace is now on the ${r.plan_name} plan` : `Your request for the ${r.plan_name} plan was declined`,
        body: note,
        link: '/settings/billing',
        email: true,
      });
      return { ok: true };
    });
  }

  private async plan(tx: Tx, key: string): Promise<PlanRow> {
    const p = await one<PlanRow>(tx, 'select id, key, name, quote_only, is_public, archived_at from plans where key = $1', [key]);
    if (!p) throw Errors.notFound('Plan');
    return p;
  }
}

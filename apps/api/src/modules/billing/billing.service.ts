import { Injectable } from '@nestjs/common';
import { UNLIMITED, type ChangeSubscriptionRequest } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';

export interface PlanView {
  id: string;
  key: string;
  name: string;
  tagline: string;
  quoteOnly: boolean;
  minimumSeats: number;
  prices: { currency: string; monthly: string; annualPerMonth: string }[];
  features: string[];
  limits: Record<string, number>;
  /** False for a hidden or archived plan, shown only because the workspace is on it. */
  offered: boolean;
}

/**
 * Subscription management. Payment collection is delegated to a payment provider adapter (Stripe / Razorpay)
 * that is not connected yet; subscriptions use provider 'manual', and invoices are produced as drafts for
 * SAMPLEDGE finance to issue. Nothing in the UI claims a card was charged.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async plans(tx?: Tx): Promise<PlanView[]> {
    const run = async (t: Tx) => {
      // Plans on sale, plus the workspace's own plan when SAMPLEDGE hid or archived it (so its contents still show).
      const plans = await many<{ id: string; key: string; name: string; tagline: string; quote_only: boolean; minimum_seats: number; offered: boolean }>(
        t,
        `select p.*, (p.is_public and p.archived_at is null) as offered from plans p
          where (p.is_public and p.archived_at is null) or p.id = (select plan_id from subscriptions limit 1)
          order by p.sort_order, p.name`,
      );
      const prices = await many<{ plan_id: string; currency: string; monthly_per_seat: string; annual_per_seat_month: string }>(t, 'select * from plan_prices order by currency');
      const pf = await many<{ plan_id: string; feature_key: string; limit_value: number | null; kind: string }>(t, 'select pf.*, f.kind from plan_features pf join features f on f.key = pf.feature_key');
      return plans.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        tagline: p.tagline ?? '',
        quoteOnly: p.quote_only,
        offered: p.offered,
        minimumSeats: p.minimum_seats,
        prices: prices.filter((x) => x.plan_id === p.id).map((x) => ({ currency: x.currency, monthly: x.monthly_per_seat, annualPerMonth: x.annual_per_seat_month })),
        features: pf.filter((x) => x.plan_id === p.id && x.kind === 'boolean').map((x) => x.feature_key),
        limits: Object.fromEntries(pf.filter((x) => x.plan_id === p.id && x.kind === 'limit').map((x) => [x.feature_key, x.limit_value ?? UNLIMITED])),
      }));
    };
    return tx ? run(tx) : this.db.tenant(run);
  }

  subscription() {
    return this.db.tenant(async (tx) => {
      const sub = await one(
        tx,
        `select s.id, p.key as "planKey", p.name as "planName", s.status, s.billing_cycle as "billingCycle", s.currency, s.seats, s.unit_price as "unitPrice",
                to_char(s.trial_ends_on, 'YYYY-MM-DD') as "trialEndsOn", to_char(s.current_period_start, 'YYYY-MM-DD') as "currentPeriodStart",
                to_char(s.current_period_end, 'YYYY-MM-DD') as "currentPeriodEnd", s.cancel_at_period_end as "cancelAtPeriodEnd", s.provider,
                (s.seats * s.unit_price * case when s.billing_cycle = 'annual' then 12 else 1 end)::numeric(14,2)::text as "periodAmount"
           from subscriptions s join plans p on p.id = s.plan_id`,
      );
      const usage = await one(
        tx,
        `select (select count(*)::int from memberships where status <> 'suspended') as "members",
                (select count(*)::int from legal_entities where archived_at is null) as "legalEntities",
                (select coalesce(sum(quantity), 0)::float8 from usage_records where metric = 'ai_credits' and occurred_at >= date_trunc('month', now())) as "aiCreditsThisMonth"`,
      );
      return { subscription: sub, usage, paymentProvider: { connected: false, note: 'Online card and UPI payments are not connected yet. Invoices are issued by SAMPLEDGE finance.' } };
    });
  }

  /** Validates a plan change against current usage, then applies it (upgrade now; downgrade only if usage fits). */
  async change(input: ChangeSubscriptionRequest) {
    return this.db.tenant(async (tx) => {
      const plans = await this.plans(tx);
      const plan = plans.find((p) => p.key === input.planKey);
      if (!plan) {
        if (await one(tx, 'select 1 from plans where key = $1', [input.planKey])) throw Errors.badRequest('plan_not_offered', 'This plan is not offered. Choose another plan.');
        throw Errors.notFound('Plan');
      }
      if (plan.quoteOnly) throw Errors.badRequest('quote_only', `${plan.name} is sold by quotation. Send SAMPLEDGE a request from Plan & billing.`);
      if (input.seats < plan.minimumSeats) throw Errors.badRequest('seats_below_minimum', `${plan.name} needs at least ${plan.minimumSeats} seats`);

      const current = (await one<{ currency: string; status: string; plan_key: string }>(tx, 'select s.currency, s.status, p.key as plan_key from subscriptions s join plans p on p.id = s.plan_id'))!;
      if (current.status === 'suspended' || current.status === 'cancelled') throw Errors.badRequest('subscription_inactive', 'Contact SAMPLEDGE support to reactivate this subscription');
      // A plan that is no longer on sale can only be kept (seats or cycle), not moved to.
      if (!plan.offered && plan.key !== current.plan_key) throw Errors.badRequest('plan_not_offered', `${plan.name} is not offered. Choose another plan.`);
      const currency = input.currency ?? current.currency;
      const price = plan.prices.find((p) => p.currency === currency);
      if (!price) throw Errors.badRequest('currency_unavailable', `${plan.name} is not priced in ${currency}`);

      const usage = (await one<{ members: number; entities: number; custom_roles: number }>(
        tx,
        `select (select count(*)::int from memberships where status <> 'suspended') as members,
                (select count(*)::int from legal_entities where archived_at is null) as entities,
                (select count(*)::int from roles r where not r.is_system and exists (select 1 from role_assignments ra where ra.role_id = r.id)) as custom_roles`,
      ))!;
      const blockers: string[] = [];
      const maxEmployees = plan.limits.max_employees ?? UNLIMITED;
      const maxEntities = plan.limits.max_legal_entities ?? UNLIMITED;
      if (maxEmployees !== UNLIMITED && usage.members > maxEmployees) blockers.push(`You have ${usage.members} members; ${plan.name} allows ${maxEmployees}.`);
      if (maxEntities !== UNLIMITED && usage.entities > maxEntities) blockers.push(`You have ${usage.entities} legal entities; ${plan.name} allows ${maxEntities}.`);
      if (usage.custom_roles > 0 && !plan.features.includes('custom_roles')) blockers.push('Custom roles are in use and are not included in this plan.');
      if (usage.entities > 1 && !plan.features.includes('multi_entity')) blockers.push(`You have ${usage.entities} legal entities and ${plan.name} does not include multiple legal entities.`);
      if (input.seats < usage.members) blockers.push(`Seats (${input.seats}) cannot be fewer than active members (${usage.members}).`);
      if (blockers.length) throw Errors.conflict('downgrade_blocked', blockers.join(' '));

      const unit = input.billingCycle === 'annual' ? price.annualPerMonth : price.monthly;
      const before = await one(tx, `select p.key as plan, s.billing_cycle as cycle, s.seats, s.currency from subscriptions s join plans p on p.id = s.plan_id`);
      await tx.query(
        `update subscriptions set plan_id = $1, billing_cycle = $2, seats = $3, currency = $4, unit_price = $5,
           status = case when status = 'trialing' then 'trialing' else 'active' end,
           current_period_end = case when billing_cycle <> $2 then current_date + case when $2 = 'annual' then 365 else 30 end else current_period_end end`,
        [plan.id, input.billingCycle, input.seats, currency, unit],
      );
      await this.audit.record(tx, {
        action: 'subscription.changed', resourceType: 'subscription', resourceId: requestContext.tenantActor().tenantId,
        changes: { from: before, to: { plan: plan.key, cycle: input.billingCycle, seats: input.seats, currency } },
      });
      await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'subscription.changed', { plan: plan.key, seats: input.seats });
      return { ok: true, plan: plan.key };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Requests to SAMPLEDGE for a plan the workspace cannot switch to itself (quote-only plans)
  // ---------------------------------------------------------------------------------------------------------

  planRequests() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select r.id, p.key as "planKey", p.name as "planName", r.seats, r.billing_cycle as "billingCycle", r.message, r.status, r.requested_by_label as "requestedBy",
                r.created_at as "createdAt", r.decision_note as "decisionNote", r.decided_at as "decidedAt"
           from plan_requests r join plans p on p.id = r.plan_id order by r.created_at desc limit 50`,
      ),
    );
  }

  async requestPlan(input: { planKey: string; seats: number; billingCycle: 'monthly' | 'annual'; message?: string }) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const plan = await one<{ id: string; name: string; quote_only: boolean; minimum_seats: number }>(
        tx, 'select id, name, quote_only, minimum_seats from plans where key = $1 and is_public and archived_at is null', [input.planKey],
      );
      if (!plan) throw Errors.notFound('Plan');
      if (!plan.quote_only) throw Errors.badRequest('self_serve_plan', `${plan.name} can be chosen straight away on Plan & billing; no request is needed.`);
      if (input.seats < plan.minimum_seats) throw Errors.badRequest('seats_below_minimum', `${plan.name} needs at least ${plan.minimum_seats} seats`);
      if (await one(tx, `select 1 from plan_requests where status = 'pending'`)) throw Errors.conflict('request_pending', 'Your workspace already has a plan request waiting for SAMPLEDGE. Withdraw it to send a new one.');
      const label = (await one<{ label: string }>(tx, 'select coalesce(u.full_name, u.email::text) as label from memberships m join users u on u.id = m.user_id where m.id = $1', [actor.membershipId]))?.label ?? 'Workspace admin';
      const row = (await one<{ id: string }>(
        tx,
        `insert into plan_requests (tenant_id, plan_id, seats, billing_cycle, message, requested_by_membership_id, requested_by_label) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [actor.tenantId, plan.id, input.seats, input.billingCycle, input.message ?? null, actor.membershipId, label],
      ))!;
      await this.audit.record(tx, { action: 'subscription.plan_requested', resourceType: 'plan_request', resourceId: row.id, changes: { plan: input.planKey, seats: input.seats, cycle: input.billingCycle } });
      return { id: row.id, note: `Your request for ${plan.name} is with SAMPLEDGE. You will be notified when it is answered.` };
    });
  }

  async withdrawPlanRequest(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one<{ status: string }>(tx, 'select status from plan_requests where id = $1 for update', [id]);
      if (!r) throw Errors.notFound('Plan request');
      if (r.status !== 'pending') throw Errors.conflict('request_decided', 'This request has already been answered');
      await tx.query(`update plan_requests set status = 'withdrawn', decided_at = now() where id = $1`, [id]);
      await this.audit.record(tx, { action: 'subscription.plan_request_withdrawn', resourceType: 'plan_request', resourceId: id });
      return { ok: true };
    });
  }

  invoices() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select id, number, status, currency, subtotal::text, tax::text, total::text, to_char(period_start, 'YYYY-MM-DD') as "periodStart",
                to_char(period_end, 'YYYY-MM-DD') as "periodEnd", issued_at as "issuedAt", due_at as "dueAt", paid_at as "paidAt"
           from invoices order by created_at desc limit 100`,
      ),
    );
  }
}

import { Injectable } from '@nestjs/common';
import { money, UNLIMITED, type ChangeSubscriptionRequest } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
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

  async plans(tx?: TenantTx): Promise<PlanView[]> {
    const run = async (t: TenantTx) => {
      // Plans on sale, plus the workspace's own plan when SAMPLEDGE hid or archived it (so its contents still show).
      const own = (await t.collection('subscriptions').findOne({}))?.plan_id ?? null;
      const plans = (
        await t.collection('plans').find({ $or: [{ is_public: true, archived_at: null }, { id: own }] }, { sort: { sort_order: 1, name: 1 } })
      ).map((p) => ({ ...p, offered: p.is_public && !p.archived_at })) as { id: string; key: string; name: string; tagline: string; quote_only: boolean; minimum_seats: number; offered: boolean }[];
      const prices = await t.collection('plan_prices').find({ plan_id: { $in: plans.map((p) => p.id) } }, { sort: { currency: 1 } });
      const features = await t.collection('plan_features').find({ plan_id: { $in: plans.map((p) => p.id) } });
      const kinds = new Map((await t.collection('features').find({})).map((f) => [f.key as string, f.kind as string]));
      const pf = features.filter((x) => kinds.has(x.feature_key)).map((x) => ({ plan_id: x.plan_id as string, feature_key: x.feature_key as string, limit_value: (x.limit_value ?? null) as number | null, kind: kinds.get(x.feature_key)! }));
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
      const s = await tx.collection('subscriptions').findOne({});
      const p = s && (await tx.collection('plans').findOne({ id: s.plan_id }));
      const sub = s && p && {
        id: s.id,
        planKey: p.key,
        planName: p.name,
        status: s.status,
        billingCycle: s.billing_cycle,
        currency: s.currency,
        seats: s.seats,
        unitPrice: s.unit_price,
        trialEndsOn: s.trial_ends_on ?? null,
        currentPeriodStart: s.current_period_start ?? null,
        currentPeriodEnd: s.current_period_end ?? null,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        provider: s.provider,
        periodAmount: money.fromMinor(money.toMinor(s.unit_price) * BigInt(s.seats * (s.billing_cycle === 'annual' ? 12 : 1))),
      };
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const credits = await tx.collection('usage_records').aggregate<{ total: number }>([
        { $match: { metric: 'ai_credits', occurred_at: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: { $toDouble: '$quantity' } } } },
      ]);
      const usage = {
        members: await tx.collection('memberships').count({ status: { $ne: 'suspended' } }),
        legalEntities: await tx.collection('legal_entities').count({ archived_at: null }),
        aiCreditsThisMonth: credits[0]?.total ?? 0,
      };
      return { subscription: sub, usage, paymentProvider: { connected: false, note: 'Online card and UPI payments are not connected yet. Invoices are issued by SAMPLEDGE finance.' } };
    });
  }

  /** Validates a plan change against current usage, then applies it (upgrade now; downgrade only if usage fits). */
  async change(input: ChangeSubscriptionRequest) {
    return this.db.tenant(async (tx) => {
      const plans = await this.plans(tx);
      const plan = plans.find((p) => p.key === input.planKey);
      if (!plan) {
        if (await tx.collection('plans').exists({ key: input.planKey })) throw Errors.badRequest('plan_not_offered', 'This plan is not offered. Choose another plan.');
        throw Errors.notFound('Plan');
      }
      if (plan.quoteOnly) throw Errors.badRequest('quote_only', `${plan.name} is sold by quotation. Send SAMPLEDGE a request from Plan & billing.`);
      if (input.seats < plan.minimumSeats) throw Errors.badRequest('seats_below_minimum', `${plan.name} needs at least ${plan.minimumSeats} seats`);

      const subscription = (await tx.collection('subscriptions').findOne({}))!;
      const currentPlan = (await tx.collection('plans').findOne({ id: subscription.plan_id }))!;
      const current = { currency: subscription.currency as string, status: subscription.status as string, plan_key: currentPlan.key as string };
      if (current.status === 'suspended' || current.status === 'cancelled') throw Errors.badRequest('subscription_inactive', 'Contact SAMPLEDGE support to reactivate this subscription');
      // A plan that is no longer on sale can only be kept (seats or cycle), not moved to.
      if (!plan.offered && plan.key !== current.plan_key) throw Errors.badRequest('plan_not_offered', `${plan.name} is not offered. Choose another plan.`);
      const currency = input.currency ?? current.currency;
      const price = plan.prices.find((p) => p.currency === currency);
      if (!price) throw Errors.badRequest('currency_unavailable', `${plan.name} is not priced in ${currency}`);

      const customRoleIds = (await tx.collection('roles').find({ is_system: false }, { projection: { _id: 1 } })).map((r) => r.id);
      const usage = {
        members: await tx.collection('memberships').count({ status: { $ne: 'suspended' } }),
        entities: await tx.collection('legal_entities').count({ archived_at: null }),
        custom_roles: (await tx.collection('role_assignments').distinct('role_id', { role_id: { $in: customRoleIds } })).length,
      };
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
      const before = { plan: current.plan_key, cycle: subscription.billing_cycle, seats: subscription.seats, currency: subscription.currency };
      const cycleChanged = subscription.billing_cycle !== input.billingCycle;
      const periodEnd = new Date();
      periodEnd.setUTCDate(periodEnd.getUTCDate() + (input.billingCycle === 'annual' ? 365 : 30));
      await tx.collection('subscriptions').updateOne(
        { id: subscription.id },
        {
          $set: {
            plan_id: plan.id,
            billing_cycle: input.billingCycle,
            seats: input.seats,
            currency,
            unit_price: unit,
            status: subscription.status === 'trialing' ? 'trialing' : 'active',
            ...(cycleChanged ? { current_period_end: periodEnd.toISOString().slice(0, 10) } : {}),
          },
        },
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
    return this.db.tenant(async (tx) => {
      const requests = await tx.collection('plan_requests').find({}, { sort: { created_at: -1 }, limit: 50 });
      const plans = new Map((await tx.collection('plans').find({ id: { $in: requests.map((r) => r.plan_id) } })).map((p) => [p.id as string, p]));
      return requests
        .filter((r) => plans.has(r.plan_id))
        .map((r) => ({
          id: r.id,
          planKey: plans.get(r.plan_id)!.key,
          planName: plans.get(r.plan_id)!.name,
          seats: r.seats,
          billingCycle: r.billing_cycle,
          message: r.message ?? null,
          status: r.status,
          requestedBy: r.requested_by_label,
          createdAt: r.created_at,
          decisionNote: r.decision_note ?? null,
          decidedAt: r.decided_at ?? null,
        }));
    });
  }

  async requestPlan(input: { planKey: string; seats: number; billingCycle: 'monthly' | 'annual'; message?: string }) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const plan = await tx.collection<{ id: string; name: string; quote_only: boolean; minimum_seats: number }>('plans').findOne({ key: input.planKey, is_public: true, archived_at: null });
      if (!plan) throw Errors.notFound('Plan');
      if (!plan.quote_only) throw Errors.badRequest('self_serve_plan', `${plan.name} can be chosen straight away on Plan & billing; no request is needed.`);
      if (input.seats < plan.minimum_seats) throw Errors.badRequest('seats_below_minimum', `${plan.name} needs at least ${plan.minimum_seats} seats`);
      if (await tx.collection('plan_requests').exists({ status: 'pending' })) throw Errors.conflict('request_pending', 'Your workspace already has a plan request waiting for SAMPLEDGE. Withdraw it to send a new one.');
      const me = await tx.collection('memberships').findOne({ id: actor.membershipId });
      const user = me && (await (await tx.users()).findOne({ id: me.user_id }));
      const label = (user?.full_name as string | undefined) ?? (user?.email as string | undefined) ?? 'Workspace admin';
      const row = await tx.collection('plan_requests').insert({
        plan_id: plan.id,
        seats: input.seats,
        billing_cycle: input.billingCycle,
        message: input.message ?? null,
        requested_by_membership_id: actor.membershipId,
        requested_by_label: label,
      });
      await this.audit.record(tx, { action: 'subscription.plan_requested', resourceType: 'plan_request', resourceId: row.id, changes: { plan: input.planKey, seats: input.seats, cycle: input.billingCycle } });
      return { id: row.id, note: `Your request for ${plan.name} is with SAMPLEDGE. You will be notified when it is answered.` };
    });
  }

  async withdrawPlanRequest(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('plan_requests').findOne({ id });
      if (!r) throw Errors.notFound('Plan request');
      if (r.status !== 'pending') throw Errors.conflict('request_decided', 'This request has already been answered');
      // The status check is part of the write, so a decision made meanwhile is not overwritten.
      if (!(await tx.collection('plan_requests').updateOne({ id, status: 'pending' }, { $set: { status: 'withdrawn', decided_at: new Date() } }))) throw Errors.conflict('request_decided', 'This request has already been answered');
      await this.audit.record(tx, { action: 'subscription.plan_request_withdrawn', resourceType: 'plan_request', resourceId: id });
      return { ok: true };
    });
  }

  invoices() {
    return this.db.tenant(async (tx) =>
      (await tx.collection('invoices').find({}, { sort: { created_at: -1 }, limit: 100 })).map((i) => ({
        id: i.id,
        number: i.number,
        status: i.status,
        currency: i.currency,
        subtotal: i.subtotal,
        tax: i.tax,
        total: i.total,
        periodStart: i.period_start ?? null,
        periodEnd: i.period_end ?? null,
        issuedAt: i.issued_at ?? null,
        dueAt: i.due_at ?? null,
        paidAt: i.paid_at ?? null,
      })),
    );
  }
}

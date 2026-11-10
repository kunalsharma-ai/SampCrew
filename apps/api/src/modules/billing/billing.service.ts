import { Injectable } from '@nestjs/common';
import { money, UNLIMITED, type CheckoutRequest } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { activeDeal, BillingEngine } from './billing-engine.service';
import { renderInvoice } from './invoice-pdf';

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
  trialDays: number;
  /** Modules in the trial; empty means the whole plan. */
  trialFeatures: string[];
  /** Limits the plan bills beyond instead of blocking, with the price per extra unit. */
  overage: Record<string, { policy: 'block' | 'overage'; prices: Record<string, string> }>;
}

/**
 * Plan & billing for a workspace. Money moves through BillingEngine: payments are taken by Razorpay or Stripe when
 * SAMPLEDGE has set them up in Console > Integrations; otherwise changes apply at once and invoices are paid by
 * bank transfer and marked paid by SAMPLEDGE finance. Nothing in the UI claims a card was charged unless a gateway
 * confirmed it.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly engine: BillingEngine,
  ) {}

  async plans(tx?: TenantTx): Promise<PlanView[]> {
    const run = async (t: TenantTx) => {
      // Plans on sale, plus the workspace's own plan when SAMPLEDGE hid or archived it (so its contents still show).
      const own = (await t.collection('subscriptions').findOne({}))?.plan_id ?? null;
      const plans = (
        await t.collection('plans').find({ $or: [{ is_public: true, archived_at: null }, { id: own }] }, { sort: { sort_order: 1, name: 1 } })
      ).map((p) => ({ ...p, offered: p.is_public && !p.archived_at })) as { id: string; key: string; name: string; tagline: string; quote_only: boolean; minimum_seats: number; offered: boolean; trial_days: number | null; trial_features: string[] | null; overage: PlanView['overage'] | null }[];
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
        trialDays: p.trial_days ?? 0,
        trialFeatures: p.trial_features ?? [],
        overage: p.overage ?? {},
        minimumSeats: p.minimum_seats,
        prices: prices.filter((x) => x.plan_id === p.id).map((x) => ({ currency: x.currency, monthly: x.monthly_per_seat, annualPerMonth: x.annual_per_seat_month })),
        features: pf.filter((x) => x.plan_id === p.id && x.kind === 'boolean').map((x) => x.feature_key),
        limits: Object.fromEntries(pf.filter((x) => x.plan_id === p.id && x.kind === 'limit').map((x) => [x.feature_key, x.limit_value ?? UNLIMITED])),
      }));
    };
    return tx ? run(tx) : this.db.tenant(run);
  }

  async subscription() {
    const base = await this.db.tenant(async (tx) => {
      const s = await tx.collection('subscriptions').findOne({});
      const p = s && (await tx.collection('plans').findOne({ id: s.plan_id }));
      const deal = s ? activeDeal(s) : null;
      const sub = s && p && {
        id: s.id,
        planKey: p.key,
        planName: p.name,
        status: s.status,
        billingCycle: s.billing_cycle,
        currency: s.currency,
        seats: s.seats,
        unitPrice: deal?.unitPrice && deal.planId === s.plan_id ? deal.unitPrice : s.unit_price,
        trialEndsOn: s.trial_ends_on ?? null,
        currentPeriodStart: s.current_period_start ?? null,
        currentPeriodEnd: s.current_period_end ?? null,
        cancelAtPeriodEnd: s.cancel_at_period_end,
        autoRenew: !s.cancel_at_period_end,
        provider: s.provider,
        savedCard: Boolean(s.provider_method_ref),
        periodAmount: money.fromMinor(money.toMinor(s.unit_price) * BigInt(s.seats * (s.billing_cycle === 'annual' ? 12 : 1))),
        scheduledChange: s.scheduled_change ?? null,
        trialReturn: s.trial_return ? { planKey: s.trial_return.planKey as string } : null,
        trialUsed: Boolean(s.trial_used_at),
        pastDueSince: s.past_due_since ?? null,
        locked: Boolean(s.locked_at),
        lockedAt: s.locked_at ?? null,
        deal: deal ? { unitPrice: deal.unitPrice ?? null, discountPercent: deal.discountPercent ?? null, features: deal.features ?? [], endsOn: deal.endsOn ?? null, partner: deal.partner ?? null } : null,
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
      return { sub, usage };
    });
    const gateway = base.sub ? await this.engine.gatewayFor(base.sub.currency) : null;
    const name = gateway?.provider === 'razorpay' ? 'Razorpay' : 'Stripe';
    return {
      subscription: base.sub,
      usage: base.usage,
      paymentProvider: gateway
        ? { connected: true, provider: gateway.provider, note: `Pay online with ${name}${gateway.provider === 'razorpay' ? ' (cards, UPI, net banking, wallets)' : ' (cards and wallets)'}. Payments are confirmed by ${name} and applied at once.` }
        : { connected: false, provider: null, note: 'Online payment is not set up for your billing currency yet. Changes apply at once and SAMPLEDGE finance sends the invoice for payment by bank transfer.' },
    };
  }

  quote(input: CheckoutRequest) {
    const actor = requestContext.tenantActor();
    return this.db.platform((tx) => this.engine.quote(tx, actor.tenantId, input));
  }

  /** Plan change from Plan & billing: a downgrade waits for the period end; an upgrade is charged for the days left. */
  async change(input: CheckoutRequest) {
    const actor = requestContext.tenantActor();
    const r = await this.engine.change(actor.tenantId, input, actor.membershipId);
    if (r.mode !== 'checkout') await this.db.tenant((tx) => this.outbox.publish(tx, actor.tenantId, 'subscription.changed', { plan: r.plan, seats: input.seats, mode: r.mode }));
    return { ok: true, ...r };
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
      (await tx.collection('invoices').find({ status: { $ne: 'draft' } }, { sort: { created_at: -1 }, limit: 100 })).map((i) => ({
        id: i.id,
        number: i.number,
        kind: i.kind ?? 'manual',
        status: i.status,
        currency: i.currency,
        subtotal: i.subtotal,
        tax: i.tax,
        total: i.total,
        taxLines: i.tax_lines ?? [],
        periodStart: i.period_start ?? null,
        periodEnd: i.period_end ?? null,
        issuedAt: i.issued_at ?? null,
        dueAt: i.due_at ?? null,
        paidAt: i.paid_at ?? null,
        overdue: i.status === 'open' && i.due_at && new Date(i.due_at) < new Date(),
      })),
    );
  }

  async invoicePdf(id: string): Promise<{ filename: string; pdf: Buffer }> {
    const { inv, lines } = await this.db.tenant(async (tx) => {
      const inv = await tx.collection('invoices').findOne({ id });
      if (!inv || inv.status === 'draft') throw Errors.notFound('Invoice');
      return { inv, lines: await tx.collection('invoice_lines').find({ invoice_id: id }) };
    });
    return { filename: `${String(inv.number).replace(/[^A-Za-z0-9-]/g, '_')}.pdf`, pdf: await renderInvoice(inv, lines) };
  }

  /** A payment the workspace was sent to the gateway for (the return page shows whether it was confirmed). */
  order(id: string) {
    return this.db.tenant(async (tx) => {
      const o = await tx.collection('payment_orders').findOne({ id });
      if (!o) throw Errors.notFound('Payment');
      return { id: o.id, status: o.status, provider: o.provider, purpose: o.purpose, amount: o.amount, currency: o.currency, description: o.description, paidAt: o.paid_at ?? null, failureReason: o.failure_reason ?? null };
    });
  }
}

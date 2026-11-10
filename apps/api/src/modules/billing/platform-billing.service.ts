import { Inject, Injectable } from '@nestjs/common';
import {
  billingMath as bm,
  FEATURES,
  LIMIT_KEYS,
  type AddonCreate,
  type AddonUpdate,
  type CouponCreate,
  type DealInput,
  type PlanBillingUpdate,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { activeDeal, BillingEngine, today } from './billing-engine.service';
import { BillingJobsService } from './billing-jobs.service';
import { renderInvoice } from './invoice-pdf';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const BOOLEAN_KEYS = new Set<string>(FEATURES.filter((f) => f.kind === 'boolean').map((f) => f.key));
const DAY = 86_400_000;

const invoiceView = (i: Row, tenants: Map<string, Row>) => ({
  id: i.id, number: i.number, tenantId: i.tenant_id, tenant: tenants.get(i.tenant_id)?.name ?? '', kind: i.kind ?? 'manual', status: i.status,
  currency: i.currency, subtotal: i.subtotal, tax: i.tax, total: i.total, taxLines: i.tax_lines ?? [], issuedAt: i.issued_at ?? null, dueAt: i.due_at ?? null,
  paidAt: i.paid_at ?? null, provider: i.provider ?? 'manual', reference: i.paid_reference ?? null, periodStart: i.period_start, periodEnd: i.period_end,
  overdue: i.status === 'open' && i.due_at && new Date(i.due_at) < new Date(), voidReason: i.void_reason ?? null,
});

/**
 * Billing in the Super Admin Console: settings, the add-on catalogue, coupons, contract deals, invoices (mark paid
 * for a bank transfer, void, issue by hand), the read-only lock, trials and overage per plan, and the revenue report.
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly engine: BillingEngine,
    private readonly jobs: BillingJobsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // Revenue
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * MRR and ARR per currency, subscriptions by status, MRR movements, churn and trial conversion over the last 30
   * and 90 days, money collected per month, money outstanding, and per plan: workspaces, MRR and add-ons.
   */
  async revenue() {
    return this.db.platform(async (tx) => {
      const subs = await tx.collection('subscriptions').find({});
      const tenants = new Map((await tx.collection('tenants').find({}, { projection: { name: 1, is_demo: 1, status: 1 } })).map((t) => [t.id as string, t]));
      const plans = new Map((await tx.collection('plans').find({})).map((p) => [p.id as string, p]));
      const addons = await tx.collection('subscription_addons').find({ status: 'active' });
      const addonDefs = new Map((await tx.collection('addons').find({})).map((a) => [a.id as string, a]));
      const real = subs.filter((s) => !tenants.get(s.tenant_id)?.is_demo);
      const mrr: Record<string, string> = {};
      const perPlan = new Map<string, { key: string; name: string; workspaces: number; paying: number; trialing: number; mrr: Record<string, string> }>();
      for (const s of real) {
        const ctx = { sub: s, addons: addons.filter((a) => a.tenant_id === s.tenant_id).map((row) => ({ row, def: addonDefs.get(row.addon_id) ?? {} })) };
        const m = this.engine.mrr(ctx);
        mrr[s.currency] = bm.sum([mrr[s.currency] ?? '0', m]);
        const p = plans.get(s.plan_id);
        const e = perPlan.get(s.plan_id) ?? { key: p?.key ?? "?", name: p?.name ?? "?", workspaces: 0, paying: 0, trialing: 0, mrr: {} as Record<string, string> };
        if (['trialing', 'active', 'past_due'].includes(s.status)) e.workspaces += 1;
        if (s.status === 'active' || s.status === 'past_due') e.paying += 1;
        if (s.status === 'trialing') e.trialing += 1;
        e.mrr[s.currency] = bm.sum([e.mrr[s.currency] ?? '0', m]);
        perPlan.set(s.plan_id, e);
      }
      const byStatus = Object.fromEntries(['trialing', 'active', 'past_due', 'cancelled', 'suspended'].map((st) => [st, real.filter((s) => s.status === st).length]));
      const locked = real.filter((s) => s.locked_at).length;
      const since30 = new Date(Date.now() - 30 * DAY);
      const since90 = new Date(Date.now() - 90 * DAY);
      const events = (await tx.collection('billing_events').find({ occurred_at: { $gte: since90 } })).filter((e) => !tenants.get(e.tenant_id)?.is_demo);
      const last30 = events.filter((e) => e.occurred_at >= since30);
      const movement = (kind: string) => {
        const list = last30.filter((e) => e.kind === kind);
        const by: Record<string, string> = {};
        for (const e of list) if (e.currency) by[e.currency] = bm.sum([by[e.currency] ?? '0', e.mrr_delta]);
        return { count: list.length, mrr: by };
      };
      const cancelled30 = last30.filter((e) => e.kind === 'cancelled').length;
      const payingNow = byStatus.active! + byStatus.past_due!;
      const startOfWindow = payingNow + cancelled30 - last30.filter((e) => e.kind === 'trial_converted' || e.kind === 'new').length;
      const converted = events.filter((e) => e.kind === 'trial_converted').length;
      const expired = events.filter((e) => e.kind === 'trial_expired').length;
      // Money collected per month (paid invoices), last 12 months.
      const yearAgo = new Date(Date.now() - 365 * DAY);
      const paid = await tx.collection('invoices').find({ status: 'paid', paid_at: { $gte: yearAgo } }, { projection: { total: 1, currency: 1, paid_at: 1, tenant_id: 1 } });
      const collected = new Map<string, Record<string, string>>();
      for (const i of paid) {
        if (tenants.get(i.tenant_id)?.is_demo) continue;
        const month = (i.paid_at as Date).toISOString().slice(0, 7);
        const row = collected.get(month) ?? {};
        row[i.currency] = bm.sum([row[i.currency] ?? '0', i.total]);
        collected.set(month, row);
      }
      const open = await tx.collection('invoices').find({ status: 'open' }, { projection: { total: 1, currency: 1, due_at: 1 } });
      const outstanding: Record<string, { total: string; overdue: string; count: number }> = {};
      for (const i of open) {
        const o = outstanding[i.currency] ?? { total: '0.00', overdue: '0.00', count: 0 };
        o.total = bm.sum([o.total, i.total]);
        if (i.due_at && new Date(i.due_at) < new Date()) o.overdue = bm.sum([o.overdue, i.total]);
        o.count += 1;
        outstanding[i.currency] = o;
      }
      const addonSales = new Map<string, { name: string; workspaces: number; units: number }>();
      for (const a of addons) {
        if (tenants.get(a.tenant_id)?.is_demo) continue;
        const d = addonDefs.get(a.addon_id);
        const e = addonSales.get(a.addon_id) ?? { name: d?.name ?? '?', workspaces: 0, units: 0 };
        e.workspaces += 1;
        e.units += a.quantity;
        addonSales.set(a.addon_id, e);
      }
      const trialsEnding = real.filter((s) => s.status === 'trialing' && s.trial_ends_on && s.trial_ends_on <= new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10)).length;
      return {
        mrr, arr: Object.fromEntries(Object.entries(mrr).map(([c, v]) => [c, bm.times(v, 12)])),
        subscriptions: { ...byStatus, locked, trialsEndingIn7Days: trialsEnding },
        last30Days: {
          new: movement('new'), upgrades: movement('upgrade'), downgrades: movement('downgrade'), cancellations: movement('cancelled'),
          trialConversions: movement('trial_converted'), addons: movement('addon_added'), paymentsFailed: last30.filter((e) => e.kind === 'payment_failed').length,
          churnRate: startOfWindow > 0 ? Math.round((cancelled30 / startOfWindow) * 1000) / 10 : 0,
        },
        trialConversion90Days: { converted, expired, rate: converted + expired > 0 ? Math.round((converted / (converted + expired)) * 1000) / 10 : null },
        collected: [...collected].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, amounts]) => ({ month, amounts })),
        outstanding,
        plans: [...perPlan.values()].sort((a, b) => b.workspaces - a.workspaces),
        addons: [...addonSales.values()].sort((a, b) => b.workspaces - a.workspaces),
        excludesDemo: true,
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------------------------------------------

  async invoices(q: { status?: string; tenantId?: string }) {
    return this.db.platform(async (tx) => {
      const filter: Row = {};
      if (q.status === 'overdue') Object.assign(filter, { status: 'open', due_at: { $lt: new Date() } });
      else if (q.status) filter.status = q.status;
      if (q.tenantId) filter.tenant_id = q.tenantId;
      const rows = await tx.collection('invoices').find(filter, { sort: { created_at: -1 }, limit: 200 });
      const tenants = new Map((await tx.collection('tenants').find({ id: { $in: [...new Set(rows.map((r) => r.tenant_id))] } }, { projection: { name: 1 } })).map((t) => [t.id as string, t]));
      return rows.map((i) => invoiceView(i, tenants));
    });
  }

  async invoicePdf(id: string) {
    const { inv, lines } = await this.db.platform(async (tx) => {
      const inv = await tx.collection('invoices').findOne({ id });
      if (!inv) throw Errors.notFound('Invoice');
      return { inv, lines: await tx.collection('invoice_lines').find({ invoice_id: id }) };
    });
    return { filename: `${String(inv.number).replace(/[^A-Za-z0-9-]/g, '_')}.pdf`, pdf: await renderInvoice(inv, lines) };
  }

  /** A bank transfer or cheque received for an invoice. */
  async markPaid(id: string, input: { reference: string; paidOn?: string }) {
    return this.db.platform(async (tx) => {
      const inv = await tx.collection('invoices').findOne({ id });
      if (!inv) throw Errors.notFound('Invoice');
      await this.engine.markInvoicePaid(tx, inv, { provider: 'manual', reference: input.reference, on: input.paidOn });
      return { ok: true };
    });
  }

  async voidInvoice(id: string, reason: string) {
    return this.db.platform(async (tx) => {
      const inv = await tx.collection('invoices').findOne({ id });
      if (!inv) throw Errors.notFound('Invoice');
      await this.engine.voidInvoice(tx, inv, reason);
      return { ok: true };
    });
  }

  /** An invoice SAMPLEDGE issues by hand (onboarding, consulting, a one-off charge). */
  async manualInvoice(tenantId: string, input: { description: string; amount: string; currency: string }) {
    return this.db.platform(async (tx) => {
      const ctx = await this.engine.load(tx, tenantId);
      const inv = await this.engine.issueInvoice(tx, ctx, { kind: 'manual', lines: [{ kind: 'manual', description: input.description, quantity: '1', unitAmount: input.amount, amount: input.amount }], currency: input.currency, periodStart: today(), periodEnd: today(), paid: null });
      return { id: inv.id as string, number: inv.number as string };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // One workspace
  // ---------------------------------------------------------------------------------------------------------------

  async tenantBilling(tenantId: string) {
    const usage = await this.engine.usage(tenantId).catch(() => []);
    return this.db.platform(async (tx) => {
      const ctx = await this.engine.load(tx, tenantId);
      const s = ctx.sub;
      const tenants = new Map([[tenantId, ctx.tenant]]);
      const invoices = (await tx.collection('invoices').find({ tenant_id: tenantId }, { sort: { created_at: -1 }, limit: 50 })).map((i) => invoiceView(i, tenants));
      const orders = (await tx.collection('payment_orders').find({ tenant_id: tenantId }, { sort: { created_at: -1 }, limit: 20 })).map((o) => ({ id: o.id, provider: o.provider, purpose: o.purpose, status: o.status, amount: o.amount, currency: o.currency, description: o.description, createdAt: o.created_at, paidAt: o.paid_at ?? null, failureReason: o.failure_reason ?? null }));
      const coupon = s.coupon_id ? await tx.collection('coupons').findOne({ id: s.coupon_id }) : null;
      return {
        plan: { key: ctx.plan.key, name: ctx.plan.name }, status: s.status, currency: s.currency, billingCycle: s.billing_cycle, seats: s.seats, unitPrice: s.unit_price,
        periodStart: s.current_period_start, periodEnd: s.current_period_end, autoRenew: !s.cancel_at_period_end, provider: s.provider, savedCard: Boolean(s.provider_method_ref),
        mrr: this.engine.mrr(ctx), scheduledChange: s.scheduled_change ?? null, trialEndsOn: s.trial_ends_on ?? null, trialReturn: s.trial_return?.planKey ?? null,
        pastDueSince: s.past_due_since ?? null, lockedAt: s.locked_at ?? null,
        deal: s.deal ?? null, dealActive: Boolean(activeDeal(s)),
        coupon: coupon ? { code: String(coupon.code).toUpperCase(), name: coupon.name, cyclesLeft: s.coupon_cycles_left ?? null } : null,
        addons: ctx.addons.map((a) => ({ key: a.def.key, name: a.def.name, quantity: a.row.quantity, unitPrice: a.row.unit_price, endsAtPeriodEnd: a.row.cancel_at_period_end })),
        profile: ctx.profile ? { legalName: ctx.profile.legal_name, gstin: ctx.profile.gstin ?? null, stateCode: ctx.profile.state_code ?? null, countryCode: ctx.profile.country_code, email: ctx.profile.email } : null,
        invoices, orders, usage,
      };
    });
  }

  /** Contract terms for one workspace: its own price per seat, a discount, extra modules, until an end date. */
  async setDeal(tenantId: string, input: DealInput) {
    const unknown = input.features.filter((k) => !BOOLEAN_KEYS.has(k));
    if (unknown.length) throw Errors.validation([{ path: 'features', message: `Unknown modules: ${unknown.join(', ')}` }]);
    if (input.endsOn && input.endsOn < today()) throw Errors.validation([{ path: 'endsOn', message: 'The end date is in the past' }]);
    return this.db.platform(async (tx) => {
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
      if (!sub) throw Errors.notFound('Subscription');
      const empty = !input.unitPrice && !input.discountPercent && !input.features.length;
      const deal = empty ? null : { unitPrice: input.unitPrice ?? null, discountPercent: input.discountPercent ?? null, features: input.features, endsOn: input.endsOn ?? null, partner: input.partner || null, note: input.note || null, planId: sub.plan_id, setAt: new Date().toISOString(), setBy: requestContext.platformActor().adminId };
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { deal } });
      await this.audit.record(tx, { tenantId, action: 'platform.subscription_deal_set', resourceType: 'subscription', resourceId: tenantId, changes: { before: sub.deal ?? null, after: deal } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.subscription_deal_set', resourceType: 'tenant', resourceId: tenantId, changes: { after: deal } });
      return { deal };
    });
  }

  /** Lifts the read-only lock by hand (for example while a payment is on its way). Reminders continue. */
  async unlock(tenantId: string, reason: string) {
    return this.db.platform(async (tx) => {
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
      if (!sub?.locked_at) throw Errors.badRequest('not_locked', 'This workspace is not read-only.');
      // Kept open for 7 days; the billing job locks it again after that if the invoice is still unpaid.
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { locked_at: null, lock_paused_until: new Date(Date.now() + 7 * DAY) } });
      await this.engine.event(tx, tenantId, { kind: 'unlocked', detail: { byHand: true, reason } });
      await this.audit.record(tx, { tenantId, action: 'subscription.unlocked', resourceType: 'subscription', resourceId: tenantId, metadata: { reason, byHand: true } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.subscription_unlocked', resourceType: 'tenant', resourceId: tenantId, metadata: { reason } });
      return { ok: true, relocksAfterDays: 7 };
    });
  }

  /** Runs the billing clock now (renewals, trials, reminders, lock, usage). A test date is accepted outside production. */
  async run(input: { tenantId?: string; asOf?: string }) {
    if (input.asOf && this.config.isProductionLike) throw Errors.badRequest('as_of_not_allowed', 'A test date can only be used outside production.');
    const results = await this.jobs.runAll(input);
    await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.billing_run', resourceType: 'billing', resourceId: input.tenantId ?? 'all', metadata: { asOf: input.asOf ?? null, workspaces: results.length } }));
    return results;
  }

  async paymentEvents() {
    return this.db.platform(async (tx) => (await tx.collection('payment_events').find({}, { sort: { received_at: -1 }, limit: 100 })).map((e) => ({ provider: e.provider, eventId: e.event_id, type: e.type, status: e.status, detail: e.detail ?? null, receivedAt: e.received_at })));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Plans: trials and overage
  // ---------------------------------------------------------------------------------------------------------------

  async setPlanBilling(key: string, input: PlanBillingUpdate) {
    const unknown = input.trialFeatures.filter((k) => !BOOLEAN_KEYS.has(k));
    if (unknown.length) throw Errors.validation([{ path: 'trialFeatures', message: `Unknown modules: ${unknown.join(', ')}` }]);
    for (const [k, v] of Object.entries(input.overage)) {
      if (!LIMIT_KEYS.includes(k as never)) throw Errors.validation([{ path: `overage.${k}`, message: 'Unknown limit' }]);
      if (v.policy === 'overage' && !Object.keys(v.prices).length) throw Errors.validation([{ path: `overage.${k}.prices`, message: 'Set a price per extra unit in at least one currency' }]);
    }
    return this.db.platform(async (tx) => {
      const plan = await tx.collection('plans').findOne({ key });
      if (!plan) throw Errors.notFound('Plan');
      const before = { trialDays: plan.trial_days ?? 0, trialFeatures: plan.trial_features ?? [], overage: plan.overage ?? {} };
      await tx.collection('plans').updateOne({ id: plan.id }, { $set: { trial_days: input.trialDays, trial_features: input.trialFeatures, overage: input.overage, customised_at: new Date(), customised_by_admin_id: requestContext.platformActor().adminId } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.plan_billing_changed', resourceType: 'plan', resourceId: key, changes: { before, after: input } });
      return { key, ...input };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Add-on catalogue
  // ---------------------------------------------------------------------------------------------------------------

  async addons() {
    return this.db.platform(async (tx) => {
      const rows = await tx.collection('addons').find({}, { sort: { name: 1 } });
      const active = await tx.collection('subscription_addons').find({ status: 'active' }, { projection: { addon_id: 1, quantity: 1 } });
      return rows.map((a) => ({
        key: a.key, name: a.name, description: a.description ?? '', kind: a.kind, featureKey: a.feature_key, unitQuantity: a.unit_quantity, prices: a.prices, planKeys: a.plan_keys,
        isPublic: a.is_public, archived: Boolean(a.archived_at), workspaces: active.filter((x) => x.addon_id === a.id).length,
      }));
    });
  }

  private checkAddon(input: { kind?: string; featureKey?: string }) {
    if (!input.kind || !input.featureKey) return;
    const f = (FEATURES as readonly { key: string; kind: string }[]).find((x) => x.key === input.featureKey);
    if (!f) throw Errors.validation([{ path: 'featureKey', message: 'Unknown module or limit' }]);
    if (input.kind === 'module' && f.kind !== 'boolean') throw Errors.validation([{ path: 'featureKey', message: 'Choose a module' }]);
    if (input.kind === 'limit' && f.kind !== 'limit') throw Errors.validation([{ path: 'featureKey', message: 'Choose a limit (employees, AI credits, storage, legal entities)' }]);
  }

  async createAddon(input: AddonCreate) {
    this.checkAddon(input);
    return this.db.platform(async (tx) => {
      if (await tx.collection('addons').exists({ key: input.key })) throw Errors.conflict('addon_exists', `An add-on with the key ${input.key} already exists`);
      const row = await tx.collection('addons').insert({ key: input.key, name: input.name, description: input.description ?? null, kind: input.kind, feature_key: input.featureKey, unit_quantity: input.kind === 'module' ? 1 : input.unitQuantity, prices: input.prices, plan_keys: input.planKeys, is_public: input.isPublic });
      await this.audit.record(tx, { tenantId: null, action: 'platform.addon_created', resourceType: 'addon', resourceId: input.key, changes: { after: input } });
      return { key: row.key };
    });
  }

  async updateAddon(key: string, input: AddonUpdate) {
    return this.db.platform(async (tx) => {
      const a = await tx.collection('addons').findOne({ key });
      if (!a) throw Errors.notFound('Add-on');
      const set: Row = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.description !== undefined) set.description = input.description;
      if (input.unitQuantity !== undefined && a.kind === 'limit') set.unit_quantity = input.unitQuantity;
      if (input.prices !== undefined) set.prices = input.prices;
      if (input.planKeys !== undefined) set.plan_keys = input.planKeys;
      if (input.isPublic !== undefined) set.is_public = input.isPublic;
      if (input.archived !== undefined) set.archived_at = input.archived ? new Date() : null;
      await tx.collection('addons').updateOne({ id: a.id }, { $set: set });
      await this.audit.record(tx, { tenantId: null, action: 'platform.addon_updated', resourceType: 'addon', resourceId: key, changes: { after: input } });
      return { key };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Coupons
  // ---------------------------------------------------------------------------------------------------------------

  async coupons() {
    return this.db.platform(async (tx) => (await tx.collection('coupons').find({}, { sort: { created_at: -1 } })).map((c) => ({
      id: c.id, code: String(c.code).toUpperCase(), name: c.name, kind: c.kind, value: c.value, currency: c.currency ?? null, duration: c.duration, cycles: c.cycles ?? null,
      planKeys: c.plan_keys, maxRedemptions: c.max_redemptions ?? null, redeemed: c.redeemed_count, validUntil: c.valid_until ?? null, active: c.active, partner: c.partner ?? null, createdAt: c.created_at,
    })));
  }

  async createCoupon(input: CouponCreate) {
    return this.db.platform(async (tx) => {
      if (await tx.collection('coupons').exists({ code: input.code })) throw Errors.conflict('coupon_exists', `The code ${input.code} is already used`);
      const row = await tx.collection('coupons').insert({
        code: input.code, name: input.name, kind: input.kind, value: input.value, currency: input.kind === 'amount' ? input.currency : null, duration: input.duration,
        cycles: input.duration === 'repeating' ? input.cycles : null, plan_keys: input.planKeys, max_redemptions: input.maxRedemptions ?? null, valid_until: input.validUntil ?? null,
        partner: input.partner || null, created_by_admin_id: requestContext.platformActor().adminId,
      });
      await this.audit.record(tx, { tenantId: null, action: 'platform.coupon_created', resourceType: 'coupon', resourceId: row.id, changes: { after: input } });
      return { id: row.id as string, code: input.code };
    });
  }

  async setCouponActive(id: string, active: boolean) {
    return this.db.platform(async (tx) => {
      if (!(await tx.collection('coupons').updateOne({ id }, { $set: { active } }))) throw Errors.notFound('Coupon');
      await this.audit.record(tx, { tenantId: null, action: active ? 'platform.coupon_enabled' : 'platform.coupon_disabled', resourceType: 'coupon', resourceId: id });
      return { ok: true };
    });
  }
}

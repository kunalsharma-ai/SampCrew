import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  billingMath as bm,
  billingSettingsInput,
  DEFAULT_BILLING_SETTINGS,
  FEATURES,
  UNLIMITED,
  type BillingCycle,
  type BillingProfileInput,
  type BillingSettingsInput,
  type CheckoutRequest,
  type PaymentGateway,
  type TaxResult,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { PlatformIntegrationsService } from '../../platform/integrations/platform-integrations.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { chargeSavedCard, createCheckout, GatewayError, stripePaymentMethod, verifyWebhook, type GatewayEvent, type GatewayKeys } from './gateways';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface ChargeLine {
  kind: 'plan' | 'addon' | 'overage' | 'credit' | 'discount' | 'manual';
  description: string;
  quantity: string;
  unitAmount: string;
  amount: string;
}

export interface Quote {
  /** now: applies when paid (or at once with nothing to pay); scheduled: at the period end; none: nothing changes. */
  mode: 'now' | 'scheduled' | 'none';
  plan: { key: string; name: string };
  seats: number;
  billingCycle: BillingCycle;
  currency: string;
  unitPrice: string;
  /** Price of one full period after the change, before tax. */
  periodAmount: string;
  effectiveOn: string;
  periodStart: string;
  periodEnd: string;
  lines: ChargeLine[];
  subtotal: string;
  tax: TaxResult;
  total: string;
  coupon: { code: string; name: string } | null;
  /** The gateway the payment would go to, or null when online payment is not set up for this currency. */
  gateway: PaymentGateway | null;
  trialConversion: boolean;
}

export type ChangeResult =
  | { mode: 'checkout'; orderId: string; url: string; provider: PaymentGateway; total: string; currency: string }
  | { mode: 'applied'; invoice: { id: string; number: string; total: string; status: string } | null; plan: string }
  | { mode: 'scheduled'; effectiveOn: string; plan: string }
  | { mode: 'none'; plan: string };

interface Ctx {
  tenant: Row;
  sub: Row;
  plan: Row;
  addons: { row: Row; def: Row }[];
  profile: Row | undefined;
  settings: BillingSettingsInput;
}

const LIVE = ['trialing', 'active', 'past_due'];
const SETTINGS_KEY = 'default';
const CACHE_MS = 5000;

export const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const limitName = (key: string) => (FEATURES as readonly { key: string; name: string; unit?: string }[]).find((f) => f.key === key);

/** The deal agreed with a workspace, when it is still running. */
export function activeDeal(sub: Row, on = today()): Row | null {
  const d = sub.deal as Row | null | undefined;
  if (!d) return null;
  if (d.endsOn && d.endsOn < on) return null;
  return d;
}

/**
 * Subscription money: what a change costs, invoices with GST, payments through Razorpay or Stripe, add-ons, coupons,
 * trials and contract prices. Workspace requests, Console actions, webhooks and the billing jobs all go through here.
 *
 * Work with the database runs in platform transactions with an explicit tenant id (invoices and orders are written
 * only by SampCrew, never directly by a workspace). Calls to a payment gateway are made outside transactions, since
 * a transaction may run again.
 */
@Injectable()
export class BillingEngine {
  private readonly logger = new Logger('Billing');
  private cached: { at: number; value: BillingSettingsInput } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly integrations: PlatformIntegrationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------------------------------------------

  async settings(tx?: PlatformTx): Promise<BillingSettingsInput> {
    if (!tx && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.value;
    const read = async (t: PlatformTx) => (await t.collection('billing_settings').findOne({ key: SETTINGS_KEY }))?.settings as Partial<BillingSettingsInput> | undefined;
    const saved = tx ? await read(tx) : await this.db.platform(read);
    const merged = { ...DEFAULT_BILLING_SETTINGS, ...(saved ?? {}), seller: { ...DEFAULT_BILLING_SETTINGS.seller, ...(saved?.seller ?? {}) }, gateways: { ...DEFAULT_BILLING_SETTINGS.gateways, ...(saved?.gateways ?? {}) } };
    if (!tx) this.cached = { at: Date.now(), value: merged };
    return merged;
  }

  async saveSettings(raw: unknown): Promise<BillingSettingsInput> {
    const parsed = billingSettingsInput.safeParse(raw);
    if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const s = parsed.data;
    if (s.seller.gstin && s.seller.stateCode && s.seller.gstin.slice(0, 2) !== s.seller.stateCode) throw Errors.validation([{ path: 'seller.gstin', message: 'The GSTIN belongs to a different state than the one chosen' }]);
    const admin = requestContext.platformActor();
    await this.db.platform(async (tx) => {
      const before = await tx.collection('billing_settings').findOne({ key: SETTINGS_KEY });
      await tx.collection('billing_settings').upsert({ key: SETTINGS_KEY }, { key: SETTINGS_KEY, settings: s, updated_by_admin_id: admin.adminId }, { $set: { settings: s, updated_by_admin_id: admin.adminId, updated_at: new Date() } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.billing_settings_saved', resourceType: 'billing_settings', resourceId: SETTINGS_KEY, changes: { before: before?.settings ?? null, after: s } });
    });
    this.cached = null;
    return this.settings();
  }

  /** The gateway that collects payments in a currency, when it is set up and switched on. */
  async gatewayFor(currency: string): Promise<GatewayKeys | null> {
    const choice = (await this.settings()).gateways[currency as 'INR' | 'USD'] ?? 'none';
    if (choice === 'none') return null;
    return this.integrations.gateway(choice);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Reading a workspace's billing state
  // ---------------------------------------------------------------------------------------------------------------

  async load(tx: PlatformTx, tenantId: string): Promise<Ctx> {
    const tenant = await tx.collection('tenants').findOne({ id: tenantId });
    const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
    if (!tenant || !sub) throw Errors.notFound('Subscription');
    const plan = (await tx.collection('plans').findOne({ id: sub.plan_id }))!;
    const rows = await tx.collection('subscription_addons').find({ tenant_id: tenantId, status: 'active' });
    const defs = new Map((await tx.collection('addons').find({ id: { $in: rows.map((r) => r.addon_id) } })).map((a) => [a.id as string, a]));
    const profile = await tx.collection('billing_profiles').findOne({ tenant_id: tenantId });
    return { tenant, sub, plan, addons: rows.filter((r) => defs.has(r.addon_id)).map((row) => ({ row, def: defs.get(row.addon_id)! })), profile, settings: await this.settings(tx) };
  }

  /** People who can manage billing in a workspace (active members whose role has billing:manage). */
  async billingAdmins(tx: PlatformTx, tenantId: string): Promise<string[]> {
    const roleIds = await tx.collection('role_permissions').distinct<string>('role_id', { tenant_id: tenantId, permission: 'billing:manage' });
    const members = await tx.collection('role_assignments').distinct<string>('membership_id', { tenant_id: tenantId, role_id: { $in: roleIds } });
    return (await tx.collection('memberships').find({ tenant_id: tenantId, id: { $in: members }, status: 'active' }, { projection: { _id: 1 } })).map((m) => m.id as string);
  }

  async notifyAdmins(tx: PlatformTx, tenantId: string, kind: string, title: string, body: string, email = true) {
    await this.notifications.notify(tx, { membershipIds: await this.billingAdmins(tx, tenantId), kind, title, body, link: '/settings/billing', email });
  }

  /** Records a reminder once; false when it was already sent. */
  async noticeOnce(tx: PlatformTx, tenantId: string, kind: string, key: string): Promise<boolean> {
    if (await tx.collection('billing_notices').exists({ tenant_id: tenantId, key })) return false;
    await tx.collection('billing_notices').insert({ tenant_id: tenantId, kind, key });
    return true;
  }

  async event(tx: PlatformTx, tenantId: string, e: { kind: string; planKey?: string | null; fromPlanKey?: string | null; currency?: string | null; mrrDelta?: string; detail?: Row; at?: Date }) {
    await tx.collection('billing_events').insert({
      tenant_id: tenantId, kind: e.kind, plan_key: e.planKey ?? null, from_plan_key: e.fromPlanKey ?? null, currency: e.currency ?? null,
      mrr_delta: e.mrrDelta ?? '0', detail: e.detail ?? {}, ...(e.at ? { occurred_at: e.at } : {}),
    });
  }

  /** Monthly recurring revenue of a subscription: plan and add-ons, after a running contract discount. Nothing while trialing or stopped. */
  mrr(ctx: Pick<Ctx, 'sub' | 'addons'>, on = today()): string {
    const s = ctx.sub;
    if (s.status !== 'active' && s.status !== 'past_due') return '0.00';
    const deal = activeDeal(s, on);
    const unit = deal?.unitPrice && deal.planId === s.plan_id ? deal.unitPrice : s.unit_price;
    let total = bm.times(unit, s.seats);
    for (const a of ctx.addons) total = bm.sum([total, bm.times(a.row.unit_price, a.row.quantity)]);
    if (deal?.discountPercent) total = bm.minus(total, bm.percentOf(total, deal.discountPercent));
    return total;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Prices and quotes
  // ---------------------------------------------------------------------------------------------------------------

  private async priceOf(tx: PlatformTx, plan: Row, currency: string, cycle: BillingCycle, sub: Row): Promise<string> {
    const deal = activeDeal(sub);
    if (deal?.unitPrice && deal.planId === plan.id && sub.currency === currency) return deal.unitPrice;
    const price = await tx.collection('plan_prices').findOne({ plan_id: plan.id, currency });
    if (!price) throw Errors.badRequest('currency_unavailable', `${plan.name} is not priced in ${currency}`);
    return cycle === 'annual' ? price.annual_per_seat_month : price.monthly_per_seat;
  }

  private addonAmount(addons: Ctx['addons'], cycle: BillingCycle): string {
    return bm.sum(addons.map((a) => bm.periodAmount(a.row.unit_price, a.row.quantity, cycle)));
  }

  /** Coupon checks: active, not expired, not used up, for this plan and currency, and not used before by this workspace. */
  async validCoupon(tx: PlatformTx, tenantId: string, code: string, planKey: string, currency: string): Promise<Row> {
    const c = await tx.collection('coupons').findOne({ code });
    const bad = (m: string) => Errors.badRequest('coupon_invalid', m);
    if (!c || !c.active) throw bad('This coupon code is not valid.');
    if (c.valid_until && c.valid_until < today()) throw bad('This coupon has expired.');
    if (c.max_redemptions && c.redeemed_count >= c.max_redemptions) throw bad('This coupon has been used the maximum number of times.');
    if ((c.plan_keys as string[]).length && !(c.plan_keys as string[]).includes(planKey)) throw bad('This coupon is not for this plan.');
    if (c.kind === 'amount' && c.currency !== currency) throw bad(`This coupon is in ${c.currency}; your workspace is billed in ${currency}.`);
    if (await tx.collection('coupon_redemptions').exists({ coupon_id: c.id, tenant_id: tenantId })) throw bad('Your workspace has already used this coupon.');
    return c;
  }

  /** Discount lines for one invoice: the running contract discount, then a coupon. `base` is the plan and add-on amount. */
  discounts(base: string, sub: Row, coupon: Row | null, on: string): ChargeLine[] {
    const out: ChargeLine[] = [];
    let left = base;
    const deal = activeDeal(sub, on);
    if (deal?.discountPercent && bm.isPositive(left)) {
      const off = bm.percentOf(left, deal.discountPercent);
      if (bm.isPositive(off)) {
        out.push({ kind: 'discount', description: `Contract discount (${deal.discountPercent}%)${deal.partner ? `, ${deal.partner}` : ''}`, quantity: '1', unitAmount: `-${off}`, amount: `-${off}` });
        left = bm.minus(left, off);
      }
    }
    if (coupon && bm.isPositive(left)) {
      let off = coupon.kind === 'percent' ? bm.percentOf(left, coupon.value) : coupon.value;
      if (bm.isPositive(bm.minus(off, left))) off = left;
      if (bm.isPositive(off)) out.push({ kind: 'discount', description: `Coupon ${String(coupon.code).toUpperCase()}${coupon.kind === 'percent' ? ` (${Number(coupon.value)}% off)` : ''}`, quantity: '1', unitAmount: `-${off}`, amount: `-${off}` });
    }
    return out;
  }

  /** The coupon still applying to the subscription's next invoice, if any. */
  private async runningCoupon(tx: PlatformTx, sub: Row): Promise<Row | null> {
    if (!sub.coupon_id || sub.coupon_cycles_left === 0) return null;
    return (await tx.collection('coupons').findOne({ id: sub.coupon_id })) ?? null;
  }

  private tax(ctx: Ctx, subtotal: string): TaxResult {
    const s = ctx.settings;
    const seller = { countryCode: s.seller.countryCode, stateCode: s.seller.stateCode || null, gstin: s.seller.gstin || null };
    const p = ctx.profile;
    const buyer = { countryCode: p?.country_code ?? ctx.tenant.country_code ?? 'IN', stateCode: p?.state_code ?? null, gstin: p?.gstin ?? null };
    const base = bm.isPositive(subtotal) ? subtotal : '0.00';
    return bm.taxFor(base, seller, buyer, { gstRate: s.gstRate, exportZeroRated: s.exportZeroRated, otherTaxRate: s.otherTaxRate, otherTaxLabel: s.otherTaxLabel });
  }

  private validatePlan(tx: PlatformTx, input: { planKey: string; seats: number }, plan: Row | undefined, current: Row) {
    if (!plan) throw Errors.notFound('Plan');
    if (plan.quote_only) throw Errors.badRequest('quote_only', `${plan.name} is sold by quotation. Send SAMPLEDGE a request from Plan & billing.`);
    if (input.seats < plan.minimum_seats) throw Errors.badRequest('seats_below_minimum', `${plan.name} needs at least ${plan.minimum_seats} seats`);
    if (plan.id !== current.plan_id && (!plan.is_public || plan.archived_at)) throw Errors.badRequest('plan_not_offered', `${plan.name} is not offered. Choose another plan.`);
  }

  /** What the plan would leave out that the workspace uses now. Empty when it fits. */
  async blockers(tx: PlatformTx, tenantId: string, plan: Row, seats: number): Promise<string[]> {
    const pf = await tx.collection('plan_features').find({ plan_id: plan.id });
    const has = new Set(pf.filter((r) => r.limit_value === null || r.limit_value === undefined).map((r) => r.feature_key as string));
    const limit = (k: string) => { const r = pf.find((x) => x.feature_key === k); return r ? (r.limit_value ?? UNLIMITED) : UNLIMITED; };
    const customRoleIds = (await tx.collection('roles').find({ tenant_id: tenantId, is_system: false }, { projection: { _id: 1 } })).map((r) => r.id);
    const usage = {
      members: await tx.collection('memberships').count({ tenant_id: tenantId, status: { $ne: 'suspended' } }),
      entities: await tx.collection('legal_entities').count({ tenant_id: tenantId, archived_at: null }),
      custom_roles: (await tx.collection('role_assignments').distinct('role_id', { tenant_id: tenantId, role_id: { $in: customRoleIds } })).length,
    };
    const out: string[] = [];
    const maxEmployees = limit('max_employees');
    const maxEntities = limit('max_legal_entities');
    if (maxEmployees !== UNLIMITED && usage.members > maxEmployees) out.push(`You have ${usage.members} members; ${plan.name} allows ${maxEmployees}.`);
    if (maxEntities !== UNLIMITED && usage.entities > maxEntities) out.push(`You have ${usage.entities} legal entities; ${plan.name} allows ${maxEntities}.`);
    if (usage.custom_roles > 0 && !has.has('custom_roles')) out.push('Custom roles are in use and are not included in this plan.');
    if (usage.entities > 1 && !has.has('multi_entity')) out.push(`You have ${usage.entities} legal entities and ${plan.name} does not include multiple legal entities.`);
    if (seats < usage.members) out.push(`Seats (${seats}) cannot be fewer than active members (${usage.members}).`);
    return out;
  }

  async quote(tx: PlatformTx, tenantId: string, input: CheckoutRequest, on = today()): Promise<Quote> {
    const ctx = await this.load(tx, tenantId);
    const { sub } = ctx;
    if (sub.status === 'suspended' || sub.status === 'cancelled') throw Errors.badRequest('subscription_inactive', 'Contact SAMPLEDGE support to reactivate this subscription');
    const plan = await tx.collection('plans').findOne({ key: input.planKey });
    if (!plan && (await tx.collection('plans').exists({ key: input.planKey }))) throw Errors.badRequest('plan_not_offered', 'This plan is not offered. Choose another plan.');
    this.validatePlan(tx, input, plan, sub);
    const currency = input.currency ?? sub.currency;
    const unit = await this.priceOf(tx, plan!, currency, input.billingCycle, sub);
    const blockers = await this.blockers(tx, tenantId, plan!, input.seats);
    if (blockers.length) throw Errors.conflict('downgrade_blocked', blockers.join(' '));
    const coupon = input.couponCode ? await this.validCoupon(tx, tenantId, input.couponCode, plan!.key, currency) : await this.runningCoupon(tx, sub);
    const trialing = sub.status === 'trialing';
    // During a trial of another plan, the paid plan underneath is what any credit is worked out from.
    const ret = trialing ? (sub.trial_return as Row | null) : null;
    const cur = ret
      ? { unit: ret.unitPrice as string, seats: ret.seats as number, cycle: ret.billingCycle as BillingCycle, start: ret.periodStart as string, end: ret.periodEnd as string, paid: ret.periodPaid !== false }
      : { unit: sub.unit_price as string, seats: sub.seats as number, cycle: sub.billing_cycle as BillingCycle, start: sub.current_period_start as string, end: sub.current_period_end as string, paid: !trialing && sub.period_paid !== false };
    const unpaid = !cur.paid;
    if (!trialing && sub.period_paid === false && (await tx.collection('invoices').exists({ tenant_id: tenantId, status: 'open', period_start: sub.current_period_start, kind: { $in: ['renewal', 'subscription'] } }))) {
      throw Errors.conflict('invoice_open', 'Pay the open invoice for this period first (Plan & billing > Invoices), then change the plan.');
    }
    const planNew = bm.periodAmount(unit, input.seats, input.billingCycle);
    const planOld = bm.periodAmount(cur.unit, cur.seats, cur.cycle);
    const addonsOld = this.addonAmount(ctx.addons, cur.cycle);
    const addonsNew = this.addonAmount(ctx.addons, input.billingCycle);
    const gatewayKeys = await this.gatewayFor(currency);
    const base = {
      plan: { key: plan!.key as string, name: plan!.name as string }, seats: input.seats, billingCycle: input.billingCycle, currency, unitPrice: unit,
      periodAmount: planNew, coupon: coupon ? { code: String(coupon.code).toUpperCase(), name: coupon.name as string } : null, gateway: gatewayKeys?.provider ?? null, trialConversion: trialing,
    };
    const same = plan!.id === sub.plan_id && input.seats === sub.seats && input.billingCycle === sub.billing_cycle && currency === sub.currency;
    if (same && !trialing) {
      return { ...base, mode: 'none', effectiveOn: on, periodStart: sub.current_period_start, periodEnd: sub.current_period_end, lines: [], subtotal: '0.00', tax: this.tax(ctx, '0.00'), total: '0.00' };
    }
    if (currency !== sub.currency && ctx.addons.length) throw Errors.badRequest('currency_addons', 'Remove your add-ons before changing the billing currency.');
    // Paying less per month, or moving from annual to monthly billing, waits for the end of the paid period.
    const cheaper = bm.isPositive(bm.minus(bm.monthlyValue(planOld, cur.cycle), bm.monthlyValue(planNew, input.billingCycle)));
    // Moving to annual billing is a longer commitment and applies at once, even at a lower monthly rate.
    const toAnnual = cur.cycle === 'monthly' && input.billingCycle === 'annual';
    if (!unpaid && !trialing && !toAnnual && (cheaper || (cur.cycle === 'annual' && input.billingCycle === 'monthly'))) {
      return { ...base, mode: 'scheduled', effectiveOn: sub.current_period_end, periodStart: sub.current_period_end, periodEnd: bm.addPeriod(sub.current_period_end, input.billingCycle), lines: [], subtotal: '0.00', tax: this.tax(ctx, '0.00'), total: '0.00' };
    }
    const q = bm.upgradeQuote({ currentAmount: planOld, newAmount: planNew, periodStart: cur.start, periodEnd: cur.end, today: on, currentCycle: cur.cycle, newCycle: input.billingCycle, noCredit: unpaid });
    const lines: ChargeLine[] = [{ kind: 'plan', description: `${plan!.name} plan, ${input.seats} seats, ${fmt(q.periodStart > on ? q.periodStart : on)} to ${fmt(q.periodEnd)}`, quantity: '1', unitAmount: q.charge, amount: q.charge }];
    let credit = q.credit;
    // A new period (cycle change or paying after a trial) also bills the add-ons for it.
    if ((q.periodStart === on && cur.start !== on) && ctx.addons.length) {
      const aq = bm.upgradeQuote({ currentAmount: addonsOld, newAmount: addonsNew, periodStart: cur.start, periodEnd: cur.end, today: on, currentCycle: cur.cycle, newCycle: input.billingCycle, noCredit: unpaid });
      lines.push({ kind: 'addon', description: `Add-ons (${ctx.addons.map((a) => a.def.name).join(', ')}), ${fmt(on)} to ${fmt(aq.periodEnd)}`, quantity: '1', unitAmount: aq.charge, amount: aq.charge });
      credit = bm.sum([credit, aq.credit]);
    }
    const chargeTotal = bm.sum(lines.map((l) => l.amount));
    lines.push(...this.discounts(chargeTotal, sub, coupon, on));
    if (bm.isPositive(credit)) lines.push({ kind: 'credit', description: `Unused time on your current plan until ${fmt(cur.end)}`, quantity: '1', unitAmount: `-${credit}`, amount: `-${credit}` });
    let subtotal = bm.sum(lines.map((l) => l.amount));
    if (!bm.isPositive(subtotal)) subtotal = '0.00';
    const tax = this.tax(ctx, subtotal);
    return { ...base, mode: 'now', effectiveOn: on, periodStart: q.periodStart, periodEnd: q.periodEnd, lines, subtotal, tax, total: bm.sum([subtotal, tax.total]) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Changing the plan
  // ---------------------------------------------------------------------------------------------------------------

  /** A plan change asked for on Plan & billing: scheduled, applied, or sent to the payment gateway. */
  async change(tenantId: string, input: CheckoutRequest, membershipId: string | null): Promise<ChangeResult> {
    const quote = await this.db.platform((tx) => this.quote(tx, tenantId, input));
    if (quote.mode === 'none') return { mode: 'none', plan: quote.plan.key };
    if (quote.mode === 'scheduled') {
      await this.db.platform(async (tx) => {
        const scheduled = { planKey: quote.plan.key, seats: quote.seats, billingCycle: quote.billingCycle, currency: quote.currency, unitPrice: quote.unitPrice, requestedAt: new Date().toISOString() };
        await tx.collection('subscriptions').updateOne({ tenant_id: tenantId }, { $set: { scheduled_change: scheduled } });
        await this.audit.record(tx, { tenantId, action: 'subscription.change_scheduled', resourceType: 'subscription', resourceId: tenantId, changes: { to: scheduled, effectiveOn: quote.effectiveOn } });
      });
      return { mode: 'scheduled', effectiveOn: quote.effectiveOn, plan: quote.plan.key };
    }
    const payload = { kind: 'plan_change', quote: { ...quote, tax: quote.tax } };
    if (bm.isPositive(quote.total) && quote.gateway) {
      const order = await this.startCheckout(tenantId, { purpose: 'plan_change', amount: quote.total, currency: quote.currency, description: `${quote.plan.name} plan, ${quote.seats} seats (${quote.billingCycle})`, payload, membershipId });
      return { mode: 'checkout', ...order };
    }
    // No online payment for this currency (or nothing to pay): the change applies now and the invoice is sent for payment by transfer.
    const invoice = await this.db.platform((tx) => this.applyPlanChange(tx, tenantId, quote, { paid: !bm.isPositive(quote.total) ? 'free' : null }));
    return { mode: 'applied', invoice, plan: quote.plan.key };
  }

  /** Applies a quoted change and issues its invoice (paid when paid through a gateway, open otherwise). */
  async applyPlanChange(tx: PlatformTx, tenantId: string, quote: Quote, pay: { paid: { provider: PaymentGateway; reference: string; orderId: string } | 'free' | null }) {
    const ctx = await this.load(tx, tenantId);
    const { sub } = ctx;
    const before = { plan: ctx.plan.key, cycle: sub.billing_cycle, seats: sub.seats, currency: sub.currency, status: sub.status };
    const plan = (await tx.collection('plans').findOne({ key: quote.plan.key }))!;
    const oldMrr = this.mrr(ctx);
    const set: Row = {
      plan_id: plan.id, billing_cycle: quote.billingCycle, seats: quote.seats, currency: quote.currency, unit_price: quote.unitPrice,
      current_period_start: quote.periodStart, current_period_end: quote.periodEnd,
      status: 'active', scheduled_change: null, trial_return: null, period_paid: pay.paid !== null,
    };
    if (sub.status === 'trialing') set.trial_ends_on = null;
    if (quote.coupon) {
      const coupon = await tx.collection('coupons').findOne({ code: quote.coupon.code });
      if (coupon && coupon.id !== sub.coupon_id) {
        await tx.collection('coupon_redemptions').insert({ tenant_id: tenantId, coupon_id: coupon.id });
        await tx.collection('coupons').updateOne({ id: coupon.id }, { $inc: { redeemed_count: 1 } });
        set.coupon_id = coupon.id;
        set.coupon_cycles_left = coupon.duration === 'once' ? 0 : coupon.duration === 'repeating' ? Math.max(0, (coupon.cycles ?? 1) - 1) : null;
      } else if (coupon && sub.coupon_cycles_left !== null && sub.coupon_cycles_left > 0 && bm.isPositive(quote.total)) {
        set.coupon_cycles_left = sub.coupon_cycles_left - 1;
      }
    }
    await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: set });
    const after = await this.load(tx, tenantId);
    const newMrr = this.mrr(after);
    const kind = sub.status === 'trialing' ? 'trial_converted' : bm.isPositive(bm.minus(oldMrr, newMrr)) ? 'downgrade' : 'upgrade';
    await this.event(tx, tenantId, { kind, planKey: plan.key, fromPlanKey: before.plan, currency: quote.currency, mrrDelta: bm.minus(newMrr, oldMrr), detail: { seats: quote.seats, cycle: quote.billingCycle } });
    let invoice: Row | null = null;
    if (bm.isPositive(quote.total)) {
      invoice = await this.issueInvoice(tx, after, {
        kind: sub.status === 'trialing' ? 'subscription' : 'upgrade', lines: quote.lines, currency: quote.currency, periodStart: quote.effectiveOn, periodEnd: quote.periodEnd,
        paid: pay.paid && pay.paid !== 'free' ? pay.paid : null,
      });
    }
    await this.clearDunning(tx, tenantId);
    await this.audit.record(tx, { tenantId, action: 'subscription.changed', resourceType: 'subscription', resourceId: tenantId, changes: { from: before, to: { plan: plan.key, cycle: quote.billingCycle, seats: quote.seats, currency: quote.currency }, total: quote.total, invoice: invoice?.number ?? null } });
    return invoice ? { id: invoice.id as string, number: invoice.number as string, total: invoice.total as string, status: invoice.status as string } : null;
  }

  async cancelScheduled(tenantId: string) {
    return this.db.platform(async (tx) => {
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
      if (!sub?.scheduled_change) throw Errors.notFound('Scheduled change');
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { scheduled_change: null } });
      await this.audit.record(tx, { tenantId, action: 'subscription.change_unscheduled', resourceType: 'subscription', resourceId: tenantId, changes: { cancelled: sub.scheduled_change } });
      return { ok: true };
    });
  }

  async setAutoRenew(tenantId: string, autoRenew: boolean) {
    return this.db.platform(async (tx) => {
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
      if (!sub || !LIVE.includes(sub.status)) throw Errors.badRequest('subscription_inactive', 'Contact SAMPLEDGE support to reactivate this subscription');
      if (sub.status === 'trialing' && !autoRenew) throw Errors.badRequest('trialing', 'A trial ends by itself; there is nothing to renew yet.');
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { cancel_at_period_end: !autoRenew } });
      await this.audit.record(tx, { tenantId, action: autoRenew ? 'subscription.renewal_resumed' : 'subscription.renewal_stopped', resourceType: 'subscription', resourceId: tenantId, metadata: { periodEnd: sub.current_period_end } });
      return { autoRenew, endsOn: autoRenew ? null : sub.current_period_end };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------------------------------------------------

  async issueInvoice(tx: PlatformTx, ctx: Ctx, input: { kind: string; lines: ChargeLine[]; currency: string; periodStart: string; periodEnd: string; paid: { provider: PaymentGateway | 'manual'; reference: string; orderId?: string } | null; note?: string }): Promise<Row> {
    let subtotal = bm.sum(input.lines.map((l) => l.amount));
    if (!bm.isPositive(subtotal)) subtotal = '0.00';
    const tax = this.tax(ctx, subtotal);
    const s = ctx.settings;
    const now = new Date();
    const issued = now.toISOString().slice(0, 10);
    const draftNumber = `PENDING-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
    const p = ctx.profile;
    const row = await tx.collection('invoices').insert({
      tenant_id: ctx.tenant.id, number: draftNumber, status: input.paid ? 'paid' : 'open', kind: input.kind, currency: input.currency,
      subtotal, tax: tax.total, total: bm.sum([subtotal, tax.total]), tax_lines: tax.lines, place_of_supply: tax.placeOfSupply,
      period_start: input.periodStart, period_end: input.periodEnd < input.periodStart ? input.periodStart : input.periodEnd,
      issued_at: now, due_at: new Date(now.getTime() + s.paymentTermsDays * 86_400_000), paid_at: input.paid ? now : null,
      provider: input.paid?.provider ?? 'manual', paid_reference: input.paid?.reference ?? null, payment_order_id: input.paid?.orderId ?? null,
      note: [tax.note, input.note].filter(Boolean).join(' ') || null,
      seller: s.seller,
      buyer: {
        legalName: p?.legal_name ?? ctx.tenant.name, gstin: p?.gstin ?? null, addressLine1: p?.address_line1 ?? null, addressLine2: p?.address_line2 ?? null,
        city: p?.city ?? null, stateCode: p?.state_code ?? null, postalCode: p?.postal_code ?? null, countryCode: p?.country_code ?? ctx.tenant.country_code ?? null, email: p?.email ?? ctx.tenant.contact_email ?? null,
      },
    });
    // Numbers are sequential across SampCrew and carry the financial year: SC2627-000123 (at most 16 characters for GST).
    const seq = await this.nextInvoiceSeq(tx);
    const fy = bm.financialYear(issued);
    const number = `${s.invoicePrefix}${fy.slice(2, 4)}${fy.slice(5, 7)}-${String(seq).padStart(6, '0')}`;
    await tx.collection('invoices').updateOne({ id: row.id }, { $set: { number } });
    if (input.lines.length) {
      await tx.collection('invoice_lines').insertMany(input.lines.map((l) => ({ tenant_id: ctx.tenant.id, invoice_id: row.id, kind: l.kind, description: l.description, quantity: l.quantity, unit_amount: l.unitAmount, amount: l.amount })));
    }
    await this.audit.record(tx, { tenantId: ctx.tenant.id, action: input.paid ? 'billing.invoice_paid' : 'billing.invoice_issued', resourceType: 'invoice', resourceId: row.id, metadata: { number, total: bm.sum([subtotal, tax.total]), currency: input.currency, kind: input.kind } });
    if (!input.paid) {
      await this.notifyAdmins(tx, ctx.tenant.id, 'billing.invoice_issued', `Invoice ${number} for ${input.currency} ${bm.sum([subtotal, tax.total])}`, `Due by ${fmt(new Date(now.getTime() + s.paymentTermsDays * 86_400_000).toISOString().slice(0, 10))}. Open Plan & billing to pay it or download the PDF.`);
    }
    return { ...row, number };
  }

  private async nextInvoiceSeq(tx: PlatformTx): Promise<number> {
    const db = await this.db.database();
    const r = await db.collection<{ _id: string; value: number }>('_sequences').findOneAndUpdate({ _id: 'invoice_number' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session: tx.session });
    return r!.value;
  }

  /** Marks an invoice paid (gateway or bank transfer) and lifts past-due and the read-only lock when nothing else is overdue. */
  async markInvoicePaid(tx: PlatformTx, invoice: Row, paid: { provider: PaymentGateway | 'manual'; reference: string; orderId?: string; on?: string }) {
    if (invoice.status === 'paid') return;
    if (invoice.status !== 'open') throw Errors.conflict('invoice_not_open', `Invoice ${invoice.number} is ${invoice.status}`);
    const at = paid.on ? new Date(`${paid.on}T12:00:00Z`) : new Date();
    await tx.collection('invoices').updateOne({ id: invoice.id }, { $set: { status: 'paid', paid_at: at, provider: paid.provider, paid_reference: paid.reference, payment_order_id: paid.orderId ?? invoice.payment_order_id ?? null } });
    const sub = await tx.collection('subscriptions').findOne({ tenant_id: invoice.tenant_id });
    if (sub && (invoice.kind === 'renewal' || invoice.kind === 'subscription') && invoice.period_start === sub.current_period_start) {
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { period_paid: true } });
    }
    await this.event(tx, invoice.tenant_id, { kind: 'payment_received', currency: invoice.currency, detail: { invoice: invoice.number, total: invoice.total, provider: paid.provider } });
    if (sub && invoice.kind === 'subscription' && sub.status === 'past_due') {
      const plan = await tx.collection('plans').findOne({ id: sub.plan_id });
      await this.event(tx, invoice.tenant_id, { kind: 'trial_converted', planKey: plan?.key, currency: invoice.currency, mrrDelta: this.mrr({ sub: { ...sub, status: 'active' }, addons: [] }) });
    }
    await this.audit.record(tx, { tenantId: invoice.tenant_id, action: 'billing.invoice_paid', resourceType: 'invoice', resourceId: invoice.id, metadata: { number: invoice.number, provider: paid.provider, reference: paid.reference } });
    await this.clearDunning(tx, invoice.tenant_id);
  }

  /** Back to active once no invoice is overdue; the read-only lock is lifted. */
  async clearDunning(tx: PlatformTx, tenantId: string) {
    const overdue = await tx.collection('invoices').exists({ tenant_id: tenantId, status: 'open', due_at: { $lt: new Date() } });
    if (overdue) return;
    const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
    if (!sub) return;
    const set: Row = {};
    if (sub.past_due_since) set.past_due_since = null;
    if (sub.status === 'past_due') set.status = 'active';
    if (sub.locked_at) set.locked_at = null;
    if (sub.lock_paused_until) set.lock_paused_until = null;
    if (!Object.keys(set).length) return;
    await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: set });
    if (sub.locked_at) {
      await this.event(tx, tenantId, { kind: 'unlocked' });
      await this.audit.record(tx, { tenantId, action: 'subscription.unlocked', resourceType: 'subscription', resourceId: tenantId });
      await this.notifyAdmins(tx, tenantId, 'billing.unlocked', 'Payment received: your workspace is fully open again', 'Everyone can add and change records again.');
    }
  }

  async voidInvoice(tx: PlatformTx, invoice: Row, reason: string) {
    if (invoice.status !== 'open' && invoice.status !== 'draft') throw Errors.conflict('invoice_not_open', `Invoice ${invoice.number} is ${invoice.status}; only open invoices can be voided`);
    await tx.collection('invoices').updateOne({ id: invoice.id }, { $set: { status: 'void', void_reason: reason } });
    await tx.collection('payment_orders').update({ invoice_id: invoice.id, status: 'created' }, { $set: { status: 'cancelled' } });
    await this.audit.record(tx, { tenantId: invoice.tenant_id, action: 'billing.invoice_voided', resourceType: 'invoice', resourceId: invoice.id, metadata: { number: invoice.number, reason } });
    await this.clearDunning(tx, invoice.tenant_id);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Payment gateway orders and webhooks
  // ---------------------------------------------------------------------------------------------------------------

  /** Creates an order, asks the gateway for a checkout page, and returns where to send the browser. */
  async startCheckout(tenantId: string, input: { purpose: 'plan_change' | 'addon' | 'invoice'; amount: string; currency: string; description: string; payload: Row; membershipId: string | null; invoiceId?: string }): Promise<{ orderId: string; url: string; provider: PaymentGateway; total: string; currency: string }> {
    const keys = await this.gatewayFor(input.currency);
    if (!keys) throw Errors.badRequest('no_gateway', 'Online payment is not set up for this currency. SAMPLEDGE finance will send you an invoice.');
    const { order, who } = await this.db.platform(async (tx) => {
      const tenant = (await tx.collection('tenants').findOne({ id: tenantId }))!;
      const profile = await tx.collection('billing_profiles').findOne({ tenant_id: tenantId });
      const sub = (await tx.collection('subscriptions').findOne({ tenant_id: tenantId }))!;
      const o = await tx.collection('payment_orders').insert({
        tenant_id: tenantId, provider: keys.provider, purpose: input.purpose, amount: input.amount, currency: input.currency, description: input.description,
        payload: input.payload, invoice_id: input.invoiceId ?? null, created_by_membership_id: input.membershipId,
      });
      let email = (profile?.email as string | undefined) ?? (tenant.contact_email as string | undefined);
      if (!email && input.membershipId) {
        const m = await tx.collection('memberships').findOne({ id: input.membershipId });
        email = m ? ((await tx.collection('users').findOne({ id: m.user_id }))?.email as string | undefined) : undefined;
      }
      await this.audit.record(tx, { tenantId, action: 'billing.checkout_started', resourceType: 'payment_order', resourceId: o.id, metadata: { provider: keys.provider, amount: input.amount, currency: input.currency, purpose: input.purpose } });
      return { order: o, who: { name: (profile?.legal_name as string | undefined) ?? (tenant.name as string), email: email ?? 'billing@example.invalid', stripeCustomer: sub.provider_customer_ref as string | null } };
    });
    try {
      const res = await createCheckout(keys, {
        orderId: order.id, amount: input.amount, amountMinor: bm.minorUnits(input.amount), currency: input.currency, description: input.description,
        customer: who, returnUrl: `${this.config.WEB_PUBLIC_URL.replace(/\/$/, '')}/settings/billing?order=${order.id}`, tenantId,
      });
      await this.db.platform(async (tx) => {
        await tx.collection('payment_orders').updateOne({ id: order.id }, { $set: { provider_order_id: res.providerOrderId, checkout_url: res.url } });
        if (res.stripeCustomer) await tx.collection('subscriptions').updateOne({ tenant_id: tenantId }, { $set: { provider_customer_ref: res.stripeCustomer } });
      });
      return { orderId: order.id, url: res.url, provider: keys.provider, total: input.amount, currency: input.currency };
    } catch (e) {
      const reason = (e as Error).message.slice(0, 500);
      await this.db.platform((tx) => tx.collection('payment_orders').updateOne({ id: order.id }, { $set: { status: 'failed', failure_reason: reason } }));
      this.logger.warn(`Checkout with ${keys.provider} failed for order ${order.id}: ${reason}`);
      throw Errors.unavailable('payment_gateway_error', `The payment page could not be opened (${reason}). Try again in a moment.`);
    }
  }

  /** A webhook from Razorpay or Stripe: checked against the webhook secret, recorded once, then acted on. */
  async webhook(provider: PaymentGateway, raw: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ status: string; detail?: string }> {
    const secret = await this.integrations.gatewayWebhookSecret(provider);
    if (!secret) throw Errors.badRequest('gateway_not_configured', `${provider === 'razorpay' ? 'Razorpay' : 'Stripe'} is not set up in Console > Integrations`);
    let event: GatewayEvent;
    try {
      event = verifyWebhook(provider, secret, raw, headers);
    } catch (e) {
      await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.payment_webhook_rejected', resourceType: 'payment_event', resourceId: provider, metadata: { reason: (e as Error).message } }));
      throw Errors.badRequest('bad_signature', (e as Error).message);
    }
    if (await this.db.platform((tx) => tx.collection('payment_events').exists({ provider, event_id: event.eventId }))) return { status: 'duplicate' };
    // Stripe: find the card the checkout saved, for automatic renewals (outside the transaction).
    let method: string | null = null;
    if (provider === 'stripe' && event.outcome === 'paid' && event.paymentIntent) {
      const keys = await this.integrations.gateway('stripe');
      if (keys) method = await stripePaymentMethod(keys, event.paymentIntent).catch(() => null);
    }
    try {
      return await this.db.platform(async (tx) => {
        const order = event.orderId ? await tx.collection('payment_orders').findOne({ id: event.orderId, provider }) : event.providerOrderId ? await tx.collection('payment_orders').findOne({ provider, provider_order_id: event.providerOrderId }) : undefined;
        const record = async (status: 'processed' | 'ignored' | 'failed', detail: string) => {
          await tx.collection('payment_events').insert({ provider, event_id: event.eventId, type: event.type, status, detail, order_id: order?.id ?? null });
          return { status, detail };
        };
        if (event.outcome === 'other') return record('ignored', `Event ${event.type} needs no action`);
        if (!order) return record('ignored', 'No SampCrew order matches this payment');
        if (order.provider_order_id && event.providerOrderId && order.provider_order_id !== event.providerOrderId) return record('failed', 'The payment does not belong to this order');
        if (event.outcome === 'closed') {
          if (order.status === 'created') {
            await tx.collection('payment_orders').updateOne({ id: order.id }, { $set: { status: event.type.includes('cancel') ? 'cancelled' : 'expired' } });
          }
          return record('processed', `Checkout ${event.type.includes('cancel') ? 'cancelled' : 'expired'}`);
        }
        if (event.amountMinor !== null && event.amountMinor !== bm.minorUnits(order.amount)) return record('failed', `Paid ${event.amountMinor} but the order is for ${bm.minorUnits(order.amount)} (minor units)`);
        if (event.currency && event.currency.toUpperCase() !== order.currency) return record('failed', `Paid in ${event.currency} but the order is in ${order.currency}`);
        if (order.status === 'paid') return record('ignored', 'Order already paid');
        await this.fulfil(tx, order, { paymentId: event.paymentId ?? event.eventId, method, customer: event.customer ?? null });
        return record('processed', `Order ${order.id} paid`);
      });
    } catch (e) {
      // Two deliveries of the same event at once: the second one sees the unique key.
      if (/duplicate|E11000|unique/i.test((e as Error).message)) return { status: 'duplicate' };
      throw e;
    }
  }

  /** What a paid order buys: the plan change, the add-on, or the invoice it was for. */
  private async fulfil(tx: PlatformTx, order: Row, pay: { paymentId: string; method: string | null; customer: string | null }) {
    await tx.collection('payment_orders').updateOne({ id: order.id }, { $set: { status: 'paid', paid_at: new Date(), provider_payment_id: pay.paymentId } });
    const paid = { provider: order.provider as PaymentGateway, reference: pay.paymentId, orderId: order.id as string };
    if (order.provider === 'stripe' && pay.method) {
      await tx.collection('subscriptions').updateOne({ tenant_id: order.tenant_id }, { $set: { provider: 'stripe', provider_method_ref: pay.method, ...(pay.customer ? { provider_customer_ref: pay.customer } : {}) } });
    } else if (order.provider === 'razorpay') {
      await tx.collection('subscriptions').updateOne({ tenant_id: order.tenant_id }, { $set: { provider: 'razorpay' } });
    }
    if (order.purpose === 'plan_change') {
      await this.applyPlanChange(tx, order.tenant_id, order.payload.quote as Quote, { paid });
    } else if (order.purpose === 'addon') {
      await this.activateAddon(tx, order.tenant_id, order.payload as Row, paid);
    } else {
      const invoice = await tx.collection('invoices').findOne({ id: order.invoice_id });
      if (invoice) await this.markInvoicePaid(tx, invoice, paid);
    }
    await this.notifyAdmins(tx, order.tenant_id, 'billing.payment_received', `Payment received: ${order.currency} ${order.amount}`, `${order.description}. Thank you. The receipt is on Plan & billing.`, false);
  }

  /** Pays an open invoice online: reuses an unpaid checkout for it, or opens a new one. */
  async payInvoice(tenantId: string, invoiceId: string, membershipId: string | null) {
    const invoice = await this.db.platform((tx) => tx.collection('invoices').findOne({ id: invoiceId, tenant_id: tenantId }));
    if (!invoice) throw Errors.notFound('Invoice');
    if (invoice.status !== 'open') throw Errors.conflict('invoice_not_open', `Invoice ${invoice.number} is ${invoice.status}`);
    const recent = await this.db.platform((tx) => tx.collection('payment_orders').findOne({ invoice_id: invoiceId, status: 'created', checkout_url: { $ne: null }, created_at: { $gt: new Date(Date.now() - 20 * 3600_000) } }, { sort: { created_at: -1 } }));
    if (recent) return { mode: 'checkout' as const, orderId: recent.id as string, url: recent.checkout_url as string, provider: recent.provider as PaymentGateway, total: recent.amount as string, currency: recent.currency as string };
    return { mode: 'checkout' as const, ...(await this.startCheckout(tenantId, { purpose: 'invoice', amount: invoice.total, currency: invoice.currency, description: `Invoice ${invoice.number}`, payload: { kind: 'invoice', invoiceId }, membershipId, invoiceId })) };
  }

  /** Renewal with a saved Stripe card. True when the bank accepted it. */
  async chargeSaved(invoice: Row): Promise<boolean> {
    const sub = await this.db.platform((tx) => tx.collection('subscriptions').findOne({ tenant_id: invoice.tenant_id }));
    if (!sub?.provider_customer_ref || !sub.provider_method_ref) return false;
    const keys = await this.gatewayFor(invoice.currency);
    if (keys?.provider !== 'stripe') return false;
    try {
      const pi = await chargeSavedCard(keys, { customer: sub.provider_customer_ref, paymentMethod: sub.provider_method_ref, amountMinor: bm.minorUnits(invoice.total), currency: invoice.currency, description: `SampCrew invoice ${invoice.number}`, invoiceId: invoice.id, tenantId: invoice.tenant_id });
      await this.db.platform(async (tx) => this.markInvoicePaid(tx, (await tx.collection('invoices').findOne({ id: invoice.id }))!, { provider: 'stripe', reference: pi }));
      return true;
    } catch (e) {
      const reason = e instanceof GatewayError ? e.message : (e as Error).message;
      await this.db.platform(async (tx) => {
        await this.event(tx, invoice.tenant_id, { kind: 'payment_failed', currency: invoice.currency, detail: { invoice: invoice.number, reason } });
        if (await this.noticeOnce(tx, invoice.tenant_id, 'payment_failed', `charge:${invoice.id}`)) {
          await this.notifyAdmins(tx, invoice.tenant_id, 'billing.payment_failed', `Automatic payment for invoice ${invoice.number} failed`, `Your bank did not accept the saved card (${reason}). Open Plan & billing and pay the invoice to keep your workspace fully open.`);
        }
      });
      return false;
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Add-ons
  // ---------------------------------------------------------------------------------------------------------------

  async addonOffer(tx: PlatformTx, tenantId: string) {
    const ctx = await this.load(tx, tenantId);
    const inPlan = new Set(await tx.collection('plan_features').distinct<string>('feature_key', { plan_id: ctx.sub.plan_id, limit_value: null }));
    const all = await tx.collection('addons').find({ archived_at: null }, { sort: { name: 1 } });
    const active = new Map(ctx.addons.map((a) => [a.def.id as string, a.row]));
    return all
      .filter((a) => active.has(a.id) || (a.is_public && (!(a.plan_keys as string[]).length || (a.plan_keys as string[]).includes(ctx.plan.key))))
      .map((a) => {
        const price = (a.prices as { currency: string; monthly: string; annualPerMonth: string }[]).find((p) => p.currency === ctx.sub.currency);
        const row = active.get(a.id);
        return {
          key: a.key as string, name: a.name as string, description: (a.description as string | null) ?? '', kind: a.kind as string, featureKey: a.feature_key as string, unitQuantity: a.unit_quantity as number,
          price: price ? (ctx.sub.billing_cycle === 'annual' ? price.annualPerMonth : price.monthly) : null, currency: ctx.sub.currency as string,
          includedInPlan: a.kind === 'module' && inPlan.has(a.feature_key),
          active: row ? { quantity: row.quantity as number, unitPrice: row.unit_price as string, endsAtPeriodEnd: row.cancel_at_period_end as boolean, since: row.started_at } : null,
        };
      });
  }

  /** Buys an add-on (or more of it). The rest of the period is charged now; renewals include it. */
  async buyAddon(tenantId: string, input: { addonKey: string; quantity: number }, membershipId: string | null): Promise<ChangeResult> {
    const plan = await this.db.platform(async (tx) => {
      const ctx = await this.load(tx, tenantId);
      if (!LIVE.includes(ctx.sub.status)) throw Errors.badRequest('subscription_inactive', 'Contact SAMPLEDGE support to reactivate this subscription');
      if (ctx.sub.status === 'trialing') throw Errors.badRequest('trialing', 'Add-ons can be bought once the trial has become a paid plan.');
      const a = await tx.collection('addons').findOne({ key: input.addonKey, archived_at: null });
      if (!a) throw Errors.notFound('Add-on');
      const existing = ctx.addons.find((x) => x.def.id === a.id);
      if (!existing && (!a.is_public || ((a.plan_keys as string[]).length && !(a.plan_keys as string[]).includes(ctx.plan.key)))) throw Errors.badRequest('addon_not_offered', `${a.name} is not offered on your plan.`);
      if (a.kind === 'module' && (await tx.collection('plan_features').exists({ plan_id: ctx.sub.plan_id, feature_key: a.feature_key }))) throw Errors.badRequest('already_included', `Your plan already includes ${a.name}.`);
      if (a.kind === 'module' && input.quantity !== 1) throw Errors.badRequest('quantity', 'A module is bought once.');
      const price = (a.prices as { currency: string; monthly: string; annualPerMonth: string }[]).find((p) => p.currency === ctx.sub.currency);
      if (!price) throw Errors.badRequest('currency_unavailable', `${a.name} is not priced in ${ctx.sub.currency}`);
      const unit = ctx.sub.billing_cycle === 'annual' ? price.annualPerMonth : price.monthly;
      const delta = existing ? input.quantity - (existing.row.quantity as number) : input.quantity;
      if (existing && delta < 0) throw Errors.badRequest('quantity', 'To buy fewer, remove the add-on (it ends with the period) and buy the new quantity.');
      if (existing && delta === 0 && !existing.row.cancel_at_period_end) throw Errors.badRequest('no_change', `You already have ${input.quantity} of ${a.name}.`);
      const full = bm.periodAmount(unit, Math.max(delta, 0), ctx.sub.billing_cycle);
      const charge = bm.prorate(full, ctx.sub.current_period_start, ctx.sub.current_period_end, today());
      const lines: ChargeLine[] = bm.isPositive(charge) ? [{ kind: 'addon', description: `${a.name}${a.kind === 'limit' ? ` x ${delta}` : ''}, ${fmt(today())} to ${fmt(ctx.sub.current_period_end)}`, quantity: String(Math.max(delta, 1)), unitAmount: bm.isPositive(charge) ? charge : '0', amount: charge }] : [];
      lines.push(...this.discounts(charge, ctx.sub, null, today()));
      const subtotal = bm.sum(lines.map((l) => l.amount));
      const tax = this.tax(ctx, subtotal);
      return { addonId: a.id as string, name: a.name as string, quantity: input.quantity, unitPrice: unit, lines, total: bm.sum([subtotal, tax.total]), currency: ctx.sub.currency as string, periodStart: today(), periodEnd: ctx.sub.current_period_end as string };
    });
    const payload = { kind: 'addon', ...plan };
    if (bm.isPositive(plan.total)) {
      const keys = await this.gatewayFor(plan.currency);
      if (keys) return { mode: 'checkout', ...(await this.startCheckout(tenantId, { purpose: 'addon', amount: plan.total, currency: plan.currency, description: `${plan.name} add-on`, payload, membershipId })) };
    }
    const invoice = await this.db.platform((tx) => this.activateAddon(tx, tenantId, payload, null));
    return { mode: 'applied', invoice, plan: input.addonKey };
  }

  async activateAddon(tx: PlatformTx, tenantId: string, p: Row, paid: { provider: PaymentGateway; reference: string; orderId: string } | null) {
    const ctx = await this.load(tx, tenantId);
    const oldMrr = this.mrr(ctx);
    const current = await tx.collection('subscription_addons').findOne({ tenant_id: tenantId, addon_id: p.addonId, status: 'active' });
    if (current) await tx.collection('subscription_addons').updateOne({ id: current.id }, { $set: { quantity: p.quantity, cancel_at_period_end: false } });
    else await tx.collection('subscription_addons').insert({ tenant_id: tenantId, addon_id: p.addonId, quantity: p.quantity, unit_price: p.unitPrice, currency: p.currency });
    const after = await this.load(tx, tenantId);
    await this.event(tx, tenantId, { kind: 'addon_added', planKey: ctx.plan.key, currency: p.currency, mrrDelta: bm.minus(this.mrr(after), oldMrr), detail: { addon: p.name, quantity: p.quantity } });
    await this.audit.record(tx, { tenantId, action: 'subscription.addon_added', resourceType: 'subscription_addon', resourceId: p.addonId, changes: { addon: p.name, quantity: p.quantity, unitPrice: p.unitPrice } });
    let invoice: Row | null = null;
    if (bm.isPositive(p.total)) invoice = await this.issueInvoice(tx, after, { kind: 'addon', lines: p.lines, currency: p.currency, periodStart: p.periodStart, periodEnd: p.periodEnd, paid });
    return invoice ? { id: invoice.id as string, number: invoice.number as string, total: invoice.total as string, status: invoice.status as string } : null;
  }

  /** Removes an add-on at the end of the paid period (it keeps working until then). */
  async removeAddon(tenantId: string, addonKey: string, undo = false) {
    return this.db.platform(async (tx) => {
      const a = await tx.collection('addons').findOne({ key: addonKey });
      const row = a && (await tx.collection('subscription_addons').findOne({ tenant_id: tenantId, addon_id: a.id, status: 'active' }));
      if (!a || !row) throw Errors.notFound('Add-on');
      await tx.collection('subscription_addons').updateOne({ id: row.id }, { $set: { cancel_at_period_end: !undo } });
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
      await this.audit.record(tx, { tenantId, action: undo ? 'subscription.addon_kept' : 'subscription.addon_removal_scheduled', resourceType: 'subscription_addon', resourceId: a.id, metadata: { addon: a.name, endsOn: sub?.current_period_end } });
      return { endsOn: undo ? null : (sub?.current_period_end as string) };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Trials
  // ---------------------------------------------------------------------------------------------------------------

  /** Tries a plan for its trial days. At the end the workspace buys it or goes back to its plan. Once per workspace. */
  async startTrial(tenantId: string, planKey: string) {
    return this.db.platform(async (tx) => {
      const ctx = await this.load(tx, tenantId);
      const plan = await tx.collection('plans').findOne({ key: planKey, is_public: true, archived_at: null });
      if (!plan) throw Errors.notFound('Plan');
      if (!plan.trial_days) throw Errors.badRequest('no_trial', `${plan.name} has no free trial.`);
      if (plan.quote_only) throw Errors.badRequest('quote_only', `${plan.name} is sold by quotation.`);
      if (ctx.sub.status === 'trialing') throw Errors.conflict('already_trialing', 'Your workspace is already on a trial.');
      if (ctx.sub.status !== 'active') throw Errors.badRequest('subscription_inactive', 'Pay any open invoices before starting a trial.');
      if (ctx.sub.trial_used_at) throw Errors.conflict('trial_used', 'Your workspace has already used its free trial.');
      if (plan.id === ctx.sub.plan_id) throw Errors.badRequest('same_plan', `You are already on ${plan.name}.`);
      const price = await tx.collection('plan_prices').findOne({ plan_id: plan.id, currency: ctx.sub.currency });
      if (!price) throw Errors.badRequest('currency_unavailable', `${plan.name} is not priced in ${ctx.sub.currency}`);
      const s = ctx.sub;
      const ends = bm.addDays(today(), plan.trial_days);
      await tx.collection('subscriptions').updateOne({ id: s.id }, {
        $set: {
          trial_return: { planId: s.plan_id, planKey: ctx.plan.key, seats: s.seats, billingCycle: s.billing_cycle, currency: s.currency, unitPrice: s.unit_price, status: s.status, periodStart: s.current_period_start, periodEnd: s.current_period_end, periodPaid: s.period_paid !== false },
          plan_id: plan.id, status: 'trialing', trial_ends_on: ends, trial_used_at: new Date(), unit_price: s.billing_cycle === 'annual' ? price.annual_per_seat_month : price.monthly_per_seat,
        },
      });
      await this.event(tx, tenantId, { kind: 'trial_started', planKey: plan.key, fromPlanKey: ctx.plan.key, currency: s.currency, mrrDelta: bm.minus('0', this.mrr(ctx)), detail: { endsOn: ends } });
      await this.audit.record(tx, { tenantId, action: 'subscription.trial_started', resourceType: 'subscription', resourceId: tenantId, changes: { plan: plan.key, from: ctx.plan.key, endsOn: ends } });
      return { plan: plan.key as string, endsOn: ends };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Usage
  // ---------------------------------------------------------------------------------------------------------------

  /** Usage against each limit this month (employees, AI credits, storage), with the plan's policy beyond it. */
  async usage(tenantId: string) {
    return this.db.tenant(async (tx) => {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const [credits] = await tx.collection('ai_interactions').aggregate<{ used: number }>([{ $match: { created_at: { $gte: monthStart } } }, { $group: { _id: null, used: { $sum: '$credits' } } }]);
      let bytes = 0;
      for (const t of ['employee_documents', 'candidate_files']) {
        const [r] = await tx.collection(t).aggregate<{ b: number }>([{ $group: { _id: null, b: { $sum: '$size_bytes' } } }]);
        bytes += r?.b ?? 0;
      }
      const e = await loadEntitlements(tx);
      const sub = await tx.collection('subscriptions').findOne({});
      const plan = sub && (await tx.collection('plans').findOne({ id: sub.plan_id }));
      const overage = (plan?.overage ?? {}) as Record<string, { policy: string; prices: Record<string, string> }>;
      const metric = (key: string, used: number) => {
        const limit = e.limits[key];
        const def = limitName(key);
        return {
          key, name: def?.name ?? key, unit: def?.unit ?? '', used, limit: limit ?? null, percent: bm.usagePercent(used, limit),
          policy: (overage[key]?.policy ?? 'block') as 'block' | 'overage', overagePrice: overage[key]?.prices?.[sub?.currency ?? 'INR'] ?? null,
        };
      };
      return [
        metric('max_employees', await tx.collection('memberships').count({ status: { $ne: 'suspended' } })),
        metric('ai_credits_monthly', credits?.used ?? 0),
        metric('storage_gb', Math.round((bytes / 1024 ** 3) * 100) / 100),
      ];
    }, { tenantId });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Billing details
  // ---------------------------------------------------------------------------------------------------------------

  async profile(tenantId: string) {
    const p = await this.db.platform((tx) => tx.collection('billing_profiles').findOne({ tenant_id: tenantId }));
    return p ? { legalName: p.legal_name, gstin: p.gstin ?? '', addressLine1: p.address_line1, addressLine2: p.address_line2 ?? '', city: p.city, stateCode: p.state_code ?? '', postalCode: p.postal_code, countryCode: p.country_code, email: p.email } : null;
  }

  async saveProfile(tenantId: string, input: BillingProfileInput) {
    await this.db.platform(async (tx) => {
      const row = { legal_name: input.legalName, gstin: input.gstin || null, address_line1: input.addressLine1, address_line2: input.addressLine2 || null, city: input.city, state_code: input.stateCode || null, postal_code: input.postalCode, country_code: input.countryCode, email: input.email };
      await tx.collection('billing_profiles').upsert({ tenant_id: tenantId }, { tenant_id: tenantId, ...row }, { $set: row });
      await this.audit.record(tx, { tenantId, action: 'billing.profile_saved', resourceType: 'billing_profile', resourceId: tenantId, changes: { legalName: input.legalName, gstinSet: Boolean(input.gstin), stateCode: input.stateCode ?? null, countryCode: input.countryCode } });
    });
    return this.profile(tenantId);
  }
}

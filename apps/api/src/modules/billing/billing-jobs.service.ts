import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { billingMath as bm, UNLIMITED, type BillingCycle } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { activeDeal, BillingEngine, type ChargeLine } from './billing-engine.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface BillingRunResult {
  tenantId: string;
  renewed: number;
  invoiced: string[];
  autoCharged: number;
  trialsEnded: number;
  remindersSent: number;
  lockedNow: boolean;
  usageNotices: number;
  cancelled: boolean;
}

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DAY = 86_400_000;

/**
 * The billing clock, hourly on one API server: trial reminders and trial ends, renewals (with scheduled downgrades,
 * add-ons, overage, coupons and contract prices), automatic card payments, reminders for unpaid invoices, the
 * read-only lock after the grace period, and usage warnings at 80% and 100%. Every step is safe to run again.
 */
@Injectable()
export class BillingJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('BillingJobs');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly engine: BillingEngine,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    const tick = () => void this.runAll().catch((err: Error) => this.logger.error(`Billing job failed: ${err.message}`));
    setTimeout(tick, 15_000).unref();
    this.timer = setInterval(tick, 60 * 60 * 1000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async runAll(opts: { asOf?: string; tenantId?: string } = {}): Promise<BillingRunResult[]> {
    if (this.running) return [];
    this.running = true;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.db.tryLease('billing_jobs', 60 * 60 * 1000);
      if (!release) return [];
      const subs = await this.db.platform((tx) => tx.collection('subscriptions').find(opts.tenantId ? { tenant_id: opts.tenantId } : { status: { $in: ['trialing', 'active', 'past_due'] } }, { projection: { tenant_id: 1 } }));
      const out: BillingRunResult[] = [];
      for (const s of subs) {
        try {
          out.push(await this.runTenant(s.tenant_id as string, opts.asOf));
        } catch (e) {
          this.logger.error(`Billing for workspace ${s.tenant_id} failed: ${(e as Error).message}`);
        }
      }
      return out;
    } finally {
      this.running = false;
      await release?.();
    }
  }

  async runTenant(tenantId: string, asOf = new Date().toISOString().slice(0, 10)): Promise<BillingRunResult> {
    const r: BillingRunResult = { tenantId, renewed: 0, invoiced: [], autoCharged: 0, trialsEnded: 0, remindersSent: 0, lockedNow: false, usageNotices: 0, cancelled: false };
    const tenant = await this.db.platform((tx) => tx.collection('tenants').findOne({ id: tenantId }));
    if (!tenant || tenant.status !== 'active') return r;
    await this.trials(tenantId, asOf, r);
    // Renew period by period (a server that was down catches up), at most two years at a time.
    for (let i = 0; i < 24; i++) {
      const invoice = await this.db.platform((tx) => this.renewOnce(tx, tenantId, asOf, r));
      if (invoice === undefined) break;
      if (invoice && invoice.status === 'open' && (await this.engine.chargeSaved(invoice))) r.autoCharged += 1;
    }
    await this.db.platform((tx) => this.dunning(tx, tenantId, asOf, r));
    await this.usageNotices(tenantId, r);
    return r;
  }

  // -------------------------------------------------------------------------------------------------------------

  private async trials(tenantId: string, asOf: string, r: BillingRunResult) {
    await this.db.platform(async (tx) => {
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId, status: 'trialing' });
      if (!sub?.trial_ends_on) return;
      const plan = (await tx.collection('plans').findOne({ id: sub.plan_id }))!;
      const settings = await this.engine.settings(tx);
      const left = bm.daysBetween(asOf, sub.trial_ends_on);
      if (left > 0) {
        // One reminder for the nearest step reached (a late run does not send several at once).
        const due = [...settings.trialReminderDays].sort((a, b) => a - b).find((d) => left <= d);
        if (due !== undefined && (await this.engine.noticeOnce(tx, tenantId, 'trial_reminder', `trial:${sub.trial_ends_on}:${due}`))) {
          for (const d of settings.trialReminderDays.filter((x) => x > due)) await this.engine.noticeOnce(tx, tenantId, 'trial_reminder', `trial:${sub.trial_ends_on}:${d}`);
          await this.engine.notifyAdmins(tx, tenantId, 'billing.trial_ending', `Your ${plan.name} trial ends in ${left} day${left === 1 ? '' : 's'}`, `It ends on ${fmt(sub.trial_ends_on)}. Buy ${plan.name} on Plan & billing to keep every module${sub.trial_return ? `, or do nothing to go back to ${sub.trial_return.planKey}` : ''}.`);
          r.remindersSent += 1;
        }
        return;
      }
      r.trialsEnded += 1;
      if (sub.trial_return) {
        const back = sub.trial_return as Row;
        await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: {
          plan_id: back.planId, seats: back.seats, billing_cycle: back.billingCycle, currency: back.currency, unit_price: back.unitPrice, status: back.status === 'past_due' ? 'past_due' : 'active',
          current_period_start: back.periodStart, current_period_end: back.periodEnd, period_paid: back.periodPaid !== false, trial_return: null, trial_ends_on: null,
        } });
        const after = await this.engine.load(tx, tenantId);
        await this.engine.event(tx, tenantId, { kind: 'trial_expired', planKey: plan.key, currency: sub.currency, mrrDelta: this.engine.mrr(after, asOf), detail: { backTo: back.planKey } });
        await this.audit.record(tx, { tenantId, action: 'subscription.trial_ended', resourceType: 'subscription', resourceId: tenantId, changes: { trialPlan: plan.key, backTo: back.planKey } });
        await this.engine.noticeOnce(tx, tenantId, 'trial_ended', `trial_end:${sub.trial_ends_on}`);
        await this.engine.notifyAdmins(tx, tenantId, 'billing.trial_ended', `Your ${plan.name} trial has ended`, `Your workspace is back on ${back.planKey}. You can buy ${plan.name} any time on Plan & billing.`);
        return;
      }
      // A trial from sign-up: the first period is invoiced. Unpaid, it follows the usual reminders and lock.
      const cycle = sub.billing_cycle as BillingCycle;
      const end = bm.addPeriod(asOf, cycle);
      const lines: ChargeLine[] = [{ kind: 'plan', description: `${plan.name} plan, ${sub.seats} seats, ${fmt(asOf)} to ${fmt(end)}`, quantity: String(sub.seats), unitAmount: bm.times(sub.unit_price, cycle === 'annual' ? 12 : 1), amount: bm.periodAmount(sub.unit_price, sub.seats, cycle) }];
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { status: 'active', trial_ends_on: null, current_period_start: asOf, current_period_end: end, period_paid: false } });
      await this.engine.event(tx, tenantId, { kind: 'trial_expired', planKey: plan.key, currency: sub.currency, detail: { invoiced: true } });
      await this.audit.record(tx, { tenantId, action: 'subscription.trial_ended', resourceType: 'subscription', resourceId: tenantId, changes: { plan: plan.key, invoiced: true } });
      if (bm.isPositive(lines[0]!.amount)) {
        const inv = await this.engine.issueInvoice(tx, await this.engine.load(tx, tenantId), { kind: 'subscription', lines, currency: sub.currency, periodStart: asOf, periodEnd: end, paid: null });
        r.invoiced.push(inv.number as string);
      } else {
        await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { period_paid: true } });
      }
    });
  }

  /**
   * Renews one period when it has ended: undefined when nothing was due, otherwise the renewal invoice (null when
   * nothing was charged). Cancels instead when renewal was switched off.
   */
  private async renewOnce(tx: PlatformTx, tenantId: string, asOf: string, r: BillingRunResult): Promise<Row | null | undefined> {
    const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId, status: { $in: ['active', 'past_due'] } });
    if (!sub || sub.current_period_end > asOf) return undefined;
    const ctx = await this.engine.load(tx, tenantId);
    const plan = ctx.plan;
    if (sub.cancel_at_period_end) {
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { status: 'cancelled', cancelled_at: new Date() } });
      await tx.collection('subscription_addons').update({ tenant_id: tenantId, status: 'active' }, { $set: { status: 'cancelled', cancelled_at: new Date() } });
      await this.engine.event(tx, tenantId, { kind: 'cancelled', planKey: plan.key, currency: sub.currency, mrrDelta: bm.minus('0', this.engine.mrr(ctx, asOf)) });
      await this.audit.record(tx, { tenantId, action: 'subscription.cancelled', resourceType: 'subscription', resourceId: tenantId, metadata: { periodEnd: sub.current_period_end } });
      await this.engine.notifyAdmins(tx, tenantId, 'billing.cancelled', 'Your SampCrew subscription has ended', 'Renewal was switched off, so the subscription ended with the paid period. Your records are kept read-only; choose a plan on Plan & billing to continue.');
      r.cancelled = true;
      return undefined;
    }
    const oldMrr = this.engine.mrr(ctx, asOf);
    const start = sub.current_period_end as string;
    // 1. Overage for the period that ended (limits the plan lets the workspace go beyond).
    const overageLines = await this.overage(tx, ctx, sub, start);
    // 2. A downgrade scheduled for this date, if the workspace's usage fits it.
    const set: Row = {};
    let planRow = plan;
    let cycle = sub.billing_cycle as BillingCycle;
    let seats = sub.seats as number;
    let unit = sub.unit_price as string;
    let currency = sub.currency as string;
    if (sub.scheduled_change) {
      const ch = sub.scheduled_change as Row;
      const target = await tx.collection('plans').findOne({ key: ch.planKey });
      const blockers = target ? await this.engine.blockers(tx, tenantId, target, ch.seats) : ['The plan no longer exists.'];
      if (target && !blockers.length) {
        planRow = target; cycle = ch.billingCycle; seats = ch.seats; unit = ch.unitPrice; currency = ch.currency;
        Object.assign(set, { plan_id: target.id, billing_cycle: cycle, seats, unit_price: unit, currency });
        await this.audit.record(tx, { tenantId, action: 'subscription.changed', resourceType: 'subscription', resourceId: tenantId, changes: { from: { plan: plan.key, seats: sub.seats, cycle: sub.billing_cycle }, to: { plan: target.key, seats, cycle }, scheduled: true } });
      } else {
        await this.engine.notifyAdmins(tx, tenantId, 'billing.change_not_applied', `Your move to ${ch.planKey} could not be made`, `${blockers.join(' ')} Your plan stays as it is; change it again on Plan & billing when your usage fits.`);
      }
      set.scheduled_change = null;
    }
    // 3. Add-ons removed at this date end now.
    const ending = ctx.addons.filter((a) => a.row.cancel_at_period_end);
    for (const a of ending) {
      await tx.collection('subscription_addons').updateOne({ id: a.row.id }, { $set: { status: 'cancelled', cancelled_at: new Date() } });
      await this.engine.event(tx, tenantId, { kind: 'addon_removed', planKey: planRow.key, currency, mrrDelta: bm.minus('0', bm.times(a.row.unit_price, a.row.quantity)), detail: { addon: a.def.name } });
    }
    const keep = ctx.addons.filter((a) => !a.row.cancel_at_period_end);
    // 4. The new period's invoice: plan (contract price while the contract runs), add-ons, discounts, overage.
    const end = bm.addPeriod(start, cycle);
    const deal = activeDeal({ ...sub, ...set }, start);
    if (deal?.unitPrice && deal.planId === (set.plan_id ?? sub.plan_id)) unit = deal.unitPrice;
    const months = cycle === 'annual' ? 12 : 1;
    const lines: ChargeLine[] = [{ kind: 'plan', description: `${planRow.name} plan, ${seats} seats, ${fmt(start)} to ${fmt(end)}`, quantity: String(seats), unitAmount: bm.times(unit, months), amount: bm.periodAmount(unit, seats, cycle) }];
    for (const a of keep) lines.push({ kind: 'addon', description: `${a.def.name}${a.def.kind === 'limit' ? ` x ${a.row.quantity}` : ''}, ${fmt(start)} to ${fmt(end)}`, quantity: String(a.row.quantity), unitAmount: bm.times(a.row.unit_price, months), amount: bm.periodAmount(a.row.unit_price, a.row.quantity, cycle) });
    const base = bm.sum(lines.map((l) => l.amount));
    const coupon = sub.coupon_id && sub.coupon_cycles_left !== 0 ? await tx.collection('coupons').findOne({ id: sub.coupon_id }) : null;
    const discounts = this.engine.discounts(base, { ...sub, ...set }, coupon ?? null, start);
    lines.push(...discounts, ...overageLines);
    if (coupon && discounts.some((d) => d.description.startsWith('Coupon')) && sub.coupon_cycles_left !== null) set.coupon_cycles_left = Math.max(0, (sub.coupon_cycles_left ?? 1) - 1);
    const total = bm.sum(lines.map((l) => l.amount));
    Object.assign(set, { current_period_start: start, current_period_end: end, period_paid: !bm.isPositive(total) });
    await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: set });
    const after = await this.engine.load(tx, tenantId);
    const newMrr = this.engine.mrr(after, start);
    const delta = bm.minus(newMrr, oldMrr);
    await this.engine.event(tx, tenantId, { kind: set.plan_id ? 'downgrade' : 'renewal', planKey: planRow.key, fromPlanKey: set.plan_id ? plan.key : null, currency, mrrDelta: delta, detail: { periodStart: start, periodEnd: end } });
    await this.audit.record(tx, { tenantId, action: 'subscription.renewed', resourceType: 'subscription', resourceId: tenantId, metadata: { periodStart: start, periodEnd: end, total } });
    r.renewed += 1;
    if (!bm.isPositive(total)) return null;
    const invoice = await this.engine.issueInvoice(tx, after, { kind: 'renewal', lines, currency, periodStart: start, periodEnd: end, paid: null });
    // Due from the start of the period at the latest by the payment terms.
    const due = new Date(Math.max(Date.parse(`${start}T00:00:00Z`), Date.parse(`${asOf}T00:00:00Z`)) + after.settings.paymentTermsDays * DAY);
    await tx.collection('invoices').updateOne({ id: invoice.id }, { $set: { due_at: due } });
    r.invoiced.push(invoice.number as string);
    return { ...invoice, due_at: due };
  }

  /** Overage lines for the period that ended: what was used beyond each limit the plan bills instead of blocking. */
  private async overage(tx: PlatformTx, ctx: Awaited<ReturnType<BillingEngine['load']>>, sub: Row, periodEnd: string): Promise<ChargeLine[]> {
    const policy = (ctx.plan.overage ?? {}) as Record<string, { policy: string; prices: Record<string, string> }>;
    const keys = Object.keys(policy).filter((k) => policy[k]?.policy === 'overage' && policy[k]?.prices?.[sub.currency]);
    if (!keys.length) return [];
    const pf = await tx.collection('plan_features').find({ plan_id: sub.plan_id, feature_key: { $in: keys } });
    const out: ChargeLine[] = [];
    const months = sub.billing_cycle === 'annual' ? 12 : 1;
    for (const key of keys) {
      let limit = (pf.find((x) => x.feature_key === key)?.limit_value ?? UNLIMITED) as number;
      if (limit === UNLIMITED) continue;
      for (const a of ctx.addons) if (a.def.kind === 'limit' && a.def.feature_key === key) limit += a.def.unit_quantity * a.row.quantity;
      if (typeof (sub.feature_overrides ?? {})[key] === 'number') limit = sub.feature_overrides[key];
      let used = 0;
      let unitLabel = '';
      if (key === 'max_employees') {
        used = await tx.collection('memberships').count({ tenant_id: ctx.tenant.id, status: { $ne: 'suspended' } });
        unitLabel = 'employees over the plan';
      } else if (key === 'ai_credits_monthly') {
        const [c] = await tx.collection('ai_interactions').aggregate<{ used: number }>([{ $match: { tenant_id: ctx.tenant.id, created_at: { $gte: new Date(`${sub.current_period_start}T00:00:00Z`), $lt: new Date(`${periodEnd}T00:00:00Z`) } } }, { $group: { _id: null, used: { $sum: '$credits' } } }]);
        used = c?.used ?? 0;
        limit *= months;
        unitLabel = 'AI credits over the allowance';
      } else if (key === 'storage_gb') {
        let bytes = 0;
        for (const t of ['employee_documents', 'candidate_files']) {
          const [b] = await tx.collection(t).aggregate<{ b: number }>([{ $match: { tenant_id: ctx.tenant.id } }, { $group: { _id: null, b: { $sum: '$size_bytes' } } }]);
          bytes += b?.b ?? 0;
        }
        used = Math.ceil(bytes / 1024 ** 3);
        unitLabel = 'GB of storage over the plan';
      }
      const extra = used - limit;
      if (extra <= 0) continue;
      const price = policy[key]!.prices[sub.currency]!;
      // Price per unit has up to 4 decimals; the line is rounded to the minor unit.
      const amount = (Math.round(Number(price) * extra * 100) / 100).toFixed(2);
      out.push({ kind: 'overage', description: `${extra} ${unitLabel} (${fmt(sub.current_period_start)} to ${fmt(periodEnd)})`, quantity: String(extra), unitAmount: price, amount });
    }
    return out;
  }

  /** Overdue invoices: past due, reminders on the configured days, and the read-only lock after the grace period. */
  private async dunning(tx: PlatformTx, tenantId: string, asOf: string, r: BillingRunResult) {
    const now = new Date(`${asOf}T23:59:59Z`);
    const overdue = await tx.collection('invoices').find({ tenant_id: tenantId, status: 'open', due_at: { $lt: now } }, { sort: { due_at: 1 } });
    const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
    if (!sub) return;
    if (!overdue.length) {
      await this.engine.clearDunning(tx, tenantId);
      return;
    }
    const settings = await this.engine.settings(tx);
    const oldest = overdue[0]!;
    if (sub.status === 'active' || !sub.past_due_since) {
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { status: sub.status === 'active' ? 'past_due' : sub.status, past_due_since: sub.past_due_since ?? oldest.due_at } });
    }
    for (const inv of overdue) {
      const late = Math.floor((now.getTime() - (inv.due_at as Date).getTime()) / DAY);
      const step = [...settings.reminderDays].sort((a, b) => b - a).find((d) => late >= d);
      if (step !== undefined && (await this.engine.noticeOnce(tx, tenantId, 'invoice_reminder', `invoice:${inv.id}:${step}`))) {
        for (const d of settings.reminderDays.filter((x) => x < step)) await this.engine.noticeOnce(tx, tenantId, 'invoice_reminder', `invoice:${inv.id}:${d}`);
        await tx.collection('invoices').updateOne({ id: inv.id }, { $set: { last_reminder_at: new Date(), reminders_sent: (inv.reminders_sent ?? 0) + 1 } });
        const lockIn = settings.graceDays - late;
        await this.engine.notifyAdmins(tx, tenantId, 'billing.invoice_overdue', `Invoice ${inv.number} is overdue`, `${inv.currency} ${inv.total} was due on ${fmt((inv.due_at as Date).toISOString().slice(0, 10))}. ${settings.lockAfterGrace && lockIn > 0 ? `Pay within ${lockIn} day${lockIn === 1 ? '' : 's'} to keep your workspace fully open.` : 'Pay it on Plan & billing.'}`);
        r.remindersSent += 1;
      }
    }
    const lateDays = Math.floor((now.getTime() - (oldest.due_at as Date).getTime()) / DAY);
    const paused = sub.lock_paused_until && new Date(sub.lock_paused_until) > now;
    if (settings.lockAfterGrace && lateDays >= settings.graceDays && !sub.locked_at && !paused) {
      await tx.collection('subscriptions').updateOne({ id: sub.id }, { $set: { locked_at: new Date() } });
      await this.engine.event(tx, tenantId, { kind: 'locked', currency: oldest.currency, detail: { invoice: oldest.number, daysLate: lateDays } });
      await this.audit.record(tx, { tenantId, action: 'subscription.locked', resourceType: 'subscription', resourceId: tenantId, metadata: { invoice: oldest.number, daysLate: lateDays } });
      await this.engine.noticeOnce(tx, tenantId, 'locked', `locked:${oldest.id}`);
      await this.engine.notifyAdmins(tx, tenantId, 'billing.locked', 'Your workspace is read-only until the invoice is paid', `Invoice ${oldest.number} is ${lateDays} days overdue. Everyone can still sign in and see their records, but nothing can be added or changed. Pay on Plan & billing to open it again at once.`);
      r.lockedNow = true;
    }
  }

  /** Warnings when a limit reaches 80% and 100% (once per limit per month, or per period for employees and storage). */
  private async usageNotices(tenantId: string, r: BillingRunResult) {
    const usage = await this.engine.usage(tenantId);
    const month = new Date().toISOString().slice(0, 7);
    await this.db.platform(async (tx) => {
      const sub = await tx.collection('subscriptions').findOne({ tenant_id: tenantId });
      if (!sub || !['trialing', 'active', 'past_due'].includes(sub.status)) return;
      for (const m of usage) {
        if (m.percent === null || m.limit === null || m.limit <= 0 || m.percent < 80) continue;
        const level = m.percent >= 100 ? 100 : 80;
        const period = m.key === 'ai_credits_monthly' ? month : sub.current_period_start;
        if (!(await this.engine.noticeOnce(tx, tenantId, level === 100 ? 'usage_100' : 'usage_80', `usage:${m.key}:${level}:${period}`))) continue;
        if (level === 100) await this.engine.noticeOnce(tx, tenantId, 'usage_80', `usage:${m.key}:80:${period}`);
        const beyond = m.policy === 'overage'
          ? `You can keep going: each extra ${m.unit.replace(/s$/, '')} is billed${m.overagePrice ? ` at ${sub.currency} ${m.overagePrice}` : ''} at the end of the period.`
          : level === 100 ? 'Nothing more can be added until you upgrade or buy an add-on.' : 'Upgrade or buy an add-on before you reach it.';
        await this.engine.notifyAdmins(tx, tenantId, 'billing.usage', `${m.name}: ${m.percent}% used`, `${m.used} of ${m.limit} ${m.unit}. ${beyond}`);
        r.usageNotices += 1;
      }
    });
  }
}

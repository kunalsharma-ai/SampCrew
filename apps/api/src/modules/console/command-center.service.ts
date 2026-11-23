import { Injectable } from '@nestjs/common';
import {
  billingMath as bm, CONSOLE_NOTIFICATION_CAP, CONSOLE_NOTIFICATION_CATEGORIES, type ActivityFeedItem, type CommandCenter, type CommandCenterQuery, type CommandRange, type ConsoleSeriesPoint,
} from '@crew/contracts';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { BillingEngine } from '../billing/billing-engine.service';
import { humanAction, actorName } from '../home/home.service';
import { PlatformService } from '../platform-admin/platform.service';
import { ConsoleSettingsService } from './console-settings.service';
import { loadPortfolio, type TenantStats } from './portfolio';

const DAY = 86_400_000;
type Bucket = CommandCenter['range']['bucket'];

/** The window and bucket size of a range. Custom ranges pick a bucket from their length. */
export function rangeWindow(q: { range: CommandRange; from?: string; to?: string }, now = new Date()): { from: Date; to: Date; bucket: Bucket } {
  const end = new Date(now);
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = (days: number) => new Date(startOfToday.getTime() - (days - 1) * DAY);
  switch (q.range) {
    case 'today': return { from: startOfToday, to: end, bucket: 'hour' };
    case '7d': return { from: back(7), to: end, bucket: 'day' };
    case '30d': return { from: back(30), to: end, bucket: 'day' };
    case '3m': return { from: back(91), to: end, bucket: 'week' };
    case '6m': return { from: back(182), to: end, bucket: 'week' };
    case '1y': return { from: new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1)), to: end, bucket: 'month' };
    case 'custom': {
      const from = new Date(`${q.from}T00:00:00Z`);
      const to = new Date(`${q.to}T23:59:59.999Z`);
      const days = (to.getTime() - from.getTime()) / DAY;
      return { from, to, bucket: days <= 2 ? 'hour' : days <= 62 ? 'day' : days <= 200 ? 'week' : 'month' };
    }
  }
}

/** Bucket starts from `from` to `to`. Weeks start on Monday (UTC). */
export function buckets(from: Date, to: Date, bucket: Bucket): Date[] {
  const out: Date[] = [];
  let d = new Date(from);
  if (bucket === 'week') { const wd = (d.getUTCDay() + 6) % 7; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd)); }
  if (bucket === 'month') d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  while (d <= to && out.length < 400) {
    out.push(d);
    d = bucket === 'hour' ? new Date(d.getTime() + 3_600_000) : bucket === 'day' ? new Date(d.getTime() + DAY) : bucket === 'week' ? new Date(d.getTime() + 7 * DAY)
      : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function bucketLabel(d: Date, bucket: Bucket) {
  if (bucket === 'hour') return `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  if (bucket === 'month') return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Puts each dated value in its bucket and returns one point per bucket with every key present. */
export function series(starts: Date[], bucket: Bucket, keys: string[], items: { at: Date; key: string; value: number }[]): ConsoleSeriesPoint[] {
  const points = starts.map((s) => ({ label: bucketLabel(s, bucket), start: s.toISOString(), values: Object.fromEntries(keys.map((k) => [k, 0])) as Record<string, number> }));
  for (const it of items) {
    let i = starts.length - 1;
    while (i >= 0 && starts[i]! > it.at) i--;
    if (i < 0) continue;
    points[i]!.values[it.key] = Math.round(((points[i]!.values[it.key] ?? 0) + it.value) * 100) / 100;
  }
  return points;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

/**
 * The Console command center: what is happening across SampCrew right now, for the chosen range. One endpoint, so
 * every tile, chart and list agrees. Money appears only for admins with billing:read, in one currency at a time
 * (the most used one unless picked). Demo workspaces are left out of every figure and counted on their own.
 */
@Injectable()
export class CommandCenterService {
  constructor(
    private readonly db: DatabaseService,
    private readonly engine: BillingEngine,
    private readonly settings: ConsoleSettingsService,
    private readonly platform: PlatformService,
  ) {}

  async get(q: CommandCenterQuery): Promise<CommandCenter> {
    const perms = requestContext.platformActor().permissions;
    const money = perms.includes('billing:read');
    const win = rangeWindow(q);
    const starts = buckets(win.from, win.to, win.bucket);
    const sysAlerts = perms.includes('health:read') || perms.includes('tenants:read') ? await this.platform.alerts().catch(() => null) : null;
    return this.db.platform(async (tx) => {
      const cfg = await this.settings.read(tx);
      const all = await loadPortfolio(tx, this.engine, cfg.notifications.inactiveAfterDays);
      const demo = all.filter((c) => c.company.is_demo);
      const real = all.filter((c) => !c.company.is_demo && !c.company.archived_at);
      const tenants = real.flatMap((c) => c.tenants);
      const tenantIds = tenants.map((t) => t.id);
      const companyOf = new Map(tenants.map((t) => [t.id, t.companyId]));
      const nameOf = new Map(tenants.map((t) => [t.id, t.name]));

      const currencies = [...new Set(tenants.map((t) => t.sub?.currency).filter((c): c is string => !!c))];
      const byCount = (c: string) => tenants.filter((t) => t.sub?.currency === c).length;
      const currency = q.currency && currencies.includes(q.currency) ? q.currency : currencies.sort((a, b) => byCount(b) - byCount(a))[0] ?? 'INR';
      const inCur = tenants.filter((t) => t.sub?.currency === currency);

      // ---- workspaces
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const hrSpaces = await tx.collection<{ tenant_id: string; created_at: Date }>('hr_workspaces').find({ tenant_id: { $in: tenantIds }, status: { $ne: 'archived' } }, { projection: { tenant_id: 1, created_at: 1 } });
      const newMembers = await tx.collection<{ tenant_id: string; created_at: Date }>('memberships').find({ tenant_id: { $in: tenantIds }, created_at: { $gte: win.from } }, { projection: { tenant_id: 1, created_at: 1 } });
      const workspaces: CommandCenter['workspaces'] = {
        companies: real.length, superWorkspaces: tenants.length, hrWorkspaces: hrSpaces.length, employeeWorkspaces: sumOf(tenants, 'employeeWorkspaces'),
        activeUsers: sumOf(tenants, 'activeUsers'), employees: sumOf(tenants, 'employees'), hrAdminUsers: sumOf(tenants, 'hrUsers'),
        newCompanies: real.filter((c) => c.company.created_at >= win.from).length,
        newWorkspaces: tenants.filter((t) => t.createdAt >= win.from).length + hrSpaces.filter((h) => h.created_at >= win.from).length,
        newCompaniesThisMonth: real.filter((c) => c.company.created_at >= monthStart).length,
        newWorkspacesThisMonth: tenants.filter((t) => t.createdAt >= monthStart).length + hrSpaces.filter((h) => h.created_at >= monthStart).length,
        active: real.filter((c) => ['active', 'trial', 'payment_due'].includes(c.status)).length, inactive: real.filter((c) => c.status === 'inactive').length,
        suspended: real.filter((c) => c.status === 'suspended').length, setupPending: real.filter((c) => c.status === 'setup_pending').length, demo: demo.length,
      };

      // ---- money
      const invoices = money ? await tx.collection<{ tenant_id: string; status: string; total: string; currency: string; paid_at: Date | null; created_at: Date; issued_at: Date | null; due_at: Date | null }>('invoices')
        .find({ tenant_id: { $in: tenantIds }, currency, status: { $in: ['paid', 'open'] } }, { projection: { tenant_id: 1, status: 1, total: 1, currency: 1, paid_at: 1, created_at: 1, issued_at: 1, due_at: 1 } }) : [];
      const refunds = money ? await tx.collection<{ amount: string; created_at: Date }>('credit_notes').find({ tenant_id: { $in: tenantIds }, currency, kind: 'refund', status: 'issued' }) : [];
      const orders = money ? await tx.collection<{ status: string; amount: string; created_at: Date; tenant_id: string }>('payment_orders').find({ tenant_id: { $in: tenantIds }, currency, created_at: { $gte: new Date(Math.min(win.from.getTime(), now.getTime() - 30 * DAY)) } }) : [];
      const events = await tx.collection<{ tenant_id: string; kind: string; occurred_at: Date; plan_key: string | null; from_plan_key: string | null; currency: string | null; detail: Record<string, unknown> }>('billing_events')
        .find({ tenant_id: { $in: tenantIds }, occurred_at: { $gte: new Date(Math.min(win.from.getTime(), now.getTime() - 90 * DAY)) } }, { sort: { occurred_at: -1 } });
      const paid = invoices.filter((i) => i.status === 'paid' && i.paid_at);
      const paidBetween = (a: Date, b: Date) => bm.sum(paid.filter((i) => i.paid_at! >= a && i.paid_at! < b).map((i) => String(i.total)));
      const refundedBetween = (a: Date, b: Date) => bm.sum(refunds.filter((r) => r.created_at >= a && r.created_at < b).map((r) => String(r.amount)));
      const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const far = new Date(8.64e15);
      const mrr = bm.sum(inCur.map((t) => t.mrr));
      const paying = inCur.filter((t) => t.sub && ['active', 'past_due'].includes(t.sub.status));
      const soon = new Date(now.getTime() + cfg.notifications.renewalNoticeDays * DAY).toISOString().slice(0, 10);
      const today = now.toISOString().slice(0, 10);
      const inWin = (d: Date) => d >= win.from && d <= win.to;
      const winEvents = events.filter((e) => inWin(e.occurred_at));
      const converted = winEvents.filter((e) => e.kind === 'trial_converted').length;
      const expired = winEvents.filter((e) => e.kind === 'trial_expired').length;
      const cancelledInWin = winEvents.filter((e) => e.kind === 'cancelled').length;
      const failedOrders = orders.filter((o) => o.status === 'failed' && inWin(o.created_at));
      const failedEvents = winEvents.filter((e) => e.kind === 'payment_failed' && (!e.currency || e.currency === currency));
      const revenue: CommandCenter['revenue'] = {
        total: money ? bm.minus(paidBetween(new Date(0), far), refundedBetween(new Date(0), far)) : '0',
        mrr: money ? mrr : '0', arr: money ? bm.times(mrr, 12) : '0',
        thisMonth: money ? paidBetween(monthStart, far) : '0', thisYear: money ? paidBetween(yearStart, far) : '0', previousMonth: money ? paidBetween(prevMonthStart, monthStart) : '0',
        inRange: money ? paidBetween(win.from, new Date(win.to.getTime() + 1)) : '0',
        outstanding: money ? bm.sum(invoices.filter((i) => i.status === 'open').map((i) => String(i.total))) : '0',
        pending: money ? bm.sum(orders.filter((o) => o.status === 'created').map((o) => String(o.amount))) : '0',
        failedPayments: money ? Math.max(failedOrders.length, failedEvents.length) : 0,
        failedAmount: money ? bm.sum(failedOrders.map((o) => String(o.amount))) : '0',
        refunded: money ? refundedBetween(win.from, new Date(win.to.getTime() + 1)) : '0',
        activeSubscriptions: tenants.filter((t) => t.sub && ['active', 'past_due'].includes(t.sub.status)).length,
        expiringSoon: tenants.filter((t) => t.sub && ((t.sub.status === 'trialing' && t.sub.trial_ends_on && t.sub.trial_ends_on <= soon) || (t.sub.cancel_at_period_end && t.sub.status !== 'cancelled' && t.sub.current_period_end <= soon))).length,
        renewalsDue: tenants.filter((t) => t.sub && ['active', 'past_due'].includes(t.sub.status) && !t.sub.cancel_at_period_end && t.sub.current_period_end >= today && t.sub.current_period_end <= soon).length,
        cancelled: tenants.filter((t) => t.sub?.status === 'cancelled').length,
        trials: tenants.filter((t) => t.sub?.status === 'trialing').length,
        conversionRate: converted + expired ? Math.round((converted / (converted + expired)) * 1000) / 10 : null,
        arpa: money && paying.length ? (Math.round((Number(mrr) / paying.length) * 100) / 100).toFixed(2) : '0',
        churnRate: paying.length + cancelledInWin ? Math.round((cancelledInWin / (paying.length + cancelledInWin)) * 1000) / 10 : null,
      };

      // ---- plans
      const planMap = new Map<string, CommandCenter['plans'][number]>();
      for (const t of tenants) {
        if (!t.plan || !t.sub || t.sub.status === 'cancelled') continue;
        const e = planMap.get(t.plan.key) ?? { key: t.plan.key, name: t.plan.name, companies: 0, paying: 0, trialing: 0, mrr: '0' };
        e.companies += 1;
        if (['active', 'past_due'].includes(t.sub.status)) e.paying += 1;
        if (t.sub.status === 'trialing') e.trialing += 1;
        if (money && t.sub.currency === currency) e.mrr = bm.sum([e.mrr, t.mrr]);
        planMap.set(t.plan.key, e);
      }
      const plans = [...planMap.values()].sort((a, b) => b.companies - a.companies);

      const ref = (t: TenantStats) => ({ clientId: t.companyId, tenantId: t.id, name: t.name });
      const change = (kind: string) => events.filter((e) => e.kind === kind).slice(0, 6).map((e) => ({ clientId: companyOf.get(e.tenant_id) ?? null, tenantId: e.tenant_id, name: nameOf.get(e.tenant_id) ?? '?', at: e.occurred_at.toISOString(), from: e.from_plan_key, to: e.plan_key }));
      const subscriptions: CommandCenter['subscriptions'] = {
        mostPopular: plans[0]?.name ?? null,
        free: tenants.filter((t) => t.sub && ['active', 'past_due'].includes(t.sub.status) && Number(t.sub.unit_price) === 0).length,
        paid: tenants.filter((t) => t.sub && ['active', 'past_due'].includes(t.sub.status) && Number(t.sub.unit_price) > 0).length,
        enterprise: tenants.filter((t) => t.plan?.enterprise && t.sub && t.sub.status !== 'cancelled').length,
        trial: revenue.trials,
        upcomingRenewals: tenants.filter((t) => t.sub && ['active', 'past_due'].includes(t.sub.status) && !t.sub.cancel_at_period_end && t.sub.current_period_end >= today && t.sub.current_period_end <= soon)
          .sort((a, b) => a.sub!.current_period_end.localeCompare(b.sub!.current_period_end)).slice(0, 8)
          .map((t) => ({ ...ref(t), on: t.sub!.current_period_end, plan: t.plan?.name ?? null, amount: money ? `${t.sub!.currency} ${t.sub!.billing_cycle === 'annual' ? bm.times(t.mrr, 12) : t.mrr}` : '' })),
        expiring: tenants.filter((t) => t.sub && ((t.sub.status === 'trialing' && t.sub.trial_ends_on && t.sub.trial_ends_on <= soon) || (t.sub.cancel_at_period_end && t.sub.status !== 'cancelled' && t.sub.current_period_end <= soon)))
          .map((t) => ({ ...ref(t), on: (t.sub!.status === 'trialing' ? t.sub!.trial_ends_on : t.sub!.current_period_end) ?? '', plan: t.plan?.name ?? null, reason: (t.sub!.status === 'trialing' ? 'trial' : 'cancelling') as 'trial' | 'cancelling' }))
          .sort((a, b) => a.on.localeCompare(b.on)).slice(0, 8),
        upgraded: change('upgrade'), downgraded: change('downgrade'),
        cancelled: events.filter((e) => e.kind === 'cancelled').slice(0, 6).map((e) => ({ clientId: companyOf.get(e.tenant_id) ?? null, tenantId: e.tenant_id, name: nameOf.get(e.tenant_id) ?? '?', at: e.occurred_at.toISOString(), plan: e.plan_key })),
      };

      // ---- series
      const usersNew = newMembers.filter((m) => m.created_at <= win.to);
      const growth = series(starts, win.bucket, ['companies', 'superWorkspaces', 'hrWorkspaces', 'users'], [
        ...real.filter((c) => inWin(c.company.created_at)).map((c) => ({ at: c.company.created_at, key: 'companies', value: 1 })),
        ...tenants.filter((t) => inWin(t.createdAt)).map((t) => ({ at: t.createdAt, key: 'superWorkspaces', value: 1 })),
        ...hrSpaces.filter((h) => inWin(h.created_at)).map((h) => ({ at: h.created_at, key: 'hrWorkspaces', value: 1 })),
        ...usersNew.map((m) => ({ at: m.created_at, key: 'users', value: 1 })),
      ]);
      const revenueSeries = money ? series(starts, win.bucket, ['revenue', 'refunds'], [
        ...paid.filter((i) => inWin(i.paid_at!)).map((i) => ({ at: i.paid_at!, key: 'revenue', value: num(i.total) })),
        ...refunds.filter((r) => inWin(r.created_at)).map((r) => ({ at: r.created_at, key: 'refunds', value: num(r.amount) })),
      ]) : [];
      const subsSeries = series(starts, win.bucket, ['new', 'cancelled', 'upgraded', 'downgraded'], winEvents.flatMap((e) => {
        const key = e.kind === 'new' || e.kind === 'trial_converted' ? 'new' : e.kind === 'cancelled' ? 'cancelled' : e.kind === 'upgrade' ? 'upgraded' : e.kind === 'downgrade' ? 'downgraded' : null;
        return key ? [{ at: e.occurred_at, key, value: 1 }] : [];
      }));
      const paymentsSeries = money ? series(starts, win.bucket, ['succeeded', 'failed'], winEvents.flatMap((e) => (e.kind === 'payment_received' ? [{ at: e.occurred_at, key: 'succeeded', value: 1 }] : e.kind === 'payment_failed' ? [{ at: e.occurred_at, key: 'failed', value: 1 }] : []))) : [];
      const outstandingSeries = money ? starts.map((s, i) => {
        const end = starts[i + 1] ?? new Date(win.to.getTime() + 1);
        const open = invoices.filter((inv) => (inv.issued_at ?? inv.created_at) < end && (inv.status === 'open' || (inv.paid_at && inv.paid_at >= end)));
        return { label: bucketLabel(s, win.bucket), start: s.toISOString(), values: { outstanding: Math.round(open.reduce((a, inv) => a + num(inv.total), 0) * 100) / 100 } };
      }) : [];

      // ---- growing companies: most new sign-in accounts in the range
      const added = new Map<string, number>();
      for (const m of usersNew) added.set(m.tenant_id, (added.get(m.tenant_id) ?? 0) + 1);
      const growing = [...added.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => {
        const t = tenants.find((x) => x.id === id)!;
        return { clientId: t.companyId, tenantId: id, name: t.name, added: n, total: t.users };
      });

      // ---- support
      const support = perms.includes('support:chat') || perms.includes('help:answer') ? {
        openConversations: await tx.collection('support_conversations').count({ status: 'open' }),
        unread: await tx.collection('support_conversations').count({ status: 'open', $or: [{ console_read_at: null }, { $expr: { $gt: ['$last_workspace_message_at', '$console_read_at'] } }] }),
        openTickets: await tx.collection('help_queries').count({ route: 'console', status: { $in: ['open', 'in_progress', 'awaiting_user'] } }),
        waitingTickets: await tx.collection('help_queries').count({ route: 'console', status: 'open', last_handler_message_at: null }),
      } : { openConversations: 0, unread: 0, openTickets: 0, waitingTickets: 0 };

      // ---- what needs action
      const attention: CommandCenter['attention'] = [];
      const overdue = real.filter((c) => c.status === 'payment_due');
      if (money && overdue.length) attention.push({ key: 'payment-due', level: 'critical', title: `${overdue.length} ${overdue.length === 1 ? 'company has' : 'companies have'} a payment due`, detail: overdue.slice(0, 3).map((c) => c.company.name).join(', '), href: '/clients?status=payment_due', count: overdue.length });
      if (money && revenue.failedPayments) attention.push({ key: 'failed-payments', level: 'warning', title: `${revenue.failedPayments} failed ${revenue.failedPayments === 1 ? 'payment' : 'payments'} in this range`, detail: null, href: '/billing?tab=payments', count: revenue.failedPayments });
      if (subscriptions.expiring.length) attention.push({ key: 'expiring', level: 'warning', title: `${subscriptions.expiring.length} subscriptions end within ${cfg.notifications.renewalNoticeDays} days`, detail: subscriptions.expiring.slice(0, 3).map((e) => e.name).join(', '), href: `/clients?renewalWithinDays=${cfg.notifications.renewalNoticeDays}`, count: subscriptions.expiring.length });
      if (workspaces.setupPending) attention.push({ key: 'setup', level: 'info', title: `${workspaces.setupPending} ${workspaces.setupPending === 1 ? 'company has' : 'companies have'} not finished setup`, detail: null, href: '/clients?status=setup_pending', count: workspaces.setupPending });
      if (workspaces.inactive) attention.push({ key: 'inactive', level: 'info', title: `${workspaces.inactive} inactive ${workspaces.inactive === 1 ? 'company' : 'companies'} (no sign-in for ${cfg.notifications.inactiveAfterDays} days)`, detail: null, href: '/clients?status=inactive', count: workspaces.inactive });
      if (support.unread) attention.push({ key: 'support', level: 'warning', title: `${support.unread} unread client ${support.unread === 1 ? 'conversation' : 'conversations'}`, detail: null, href: '/support', count: support.unread });
      if (support.waitingTickets) attention.push({ key: 'tickets', level: 'warning', title: `${support.waitingTickets} ${support.waitingTickets === 1 ? 'ticket waits' : 'tickets wait'} for a first answer`, detail: null, href: '/support?tab=tickets', count: support.waitingTickets });
      const issues: string[] = [];
      for (const a of sysAlerts?.items ?? []) {
        if (a.key === 'support' || a.key === 'new-workspaces') continue;
        const level = a.level === 'critical' ? 'critical' : a.level === 'warning' ? 'warning' : 'info';
        if (level !== 'info') issues.push(a.title);
        attention.push({ key: `sys-${a.key}`, level, title: a.title, detail: a.detail ?? null, href: a.href.replace(/^\/tenants/, '/clients'), count: a.count ?? null });
      }
      const rank = { critical: 0, warning: 1, info: 2 } as const;
      attention.sort((a, b) => rank[a.level] - rank[b.level]);
      const system = { status: (sysAlerts?.items ?? []).some((a) => a.level === 'critical') ? 'critical' as const : issues.length ? 'warning' as const : 'operational' as const, issues };

      return {
        range: { key: q.range, from: win.from.toISOString(), to: win.to.toISOString(), bucket: win.bucket },
        currency, currencies, workspaces, revenue, plans, subscriptions,
        series: { growth, revenue: revenueSeries, subscriptions: subsSeries, payments: paymentsSeries, outstanding: outstandingSeries },
        growing, attention, support, system,
        activity: await this.activity(tx, 25, perms),
      };
    });
  }

  /**
   * The activity feed: Console notifications the admin may see (companies, workspaces, subscriptions, payments,
   * support, security) plus workspace events worth knowing (HR Workspaces created, people invited), newest first.
   */
  async activity(tx: PlatformTx, limit: number, perms: readonly string[], before?: Date): Promise<ActivityFeedItem[]> {
    const cats = CONSOLE_NOTIFICATION_CATEGORIES.filter((c) => perms.includes(CONSOLE_NOTIFICATION_CAP[c]));
    const time = before ? { $lt: before } : { $exists: true };
    const notes = await tx.collection<{ id: string; kind: string; title: string; body: string | null; href: string | null; company_id: string | null; tenant_id: string | null; created_at: Date; priority: string; category: string }>('platform_notifications')
      .find({ category: { $in: cats }, created_at: time }, { sort: { created_at: -1 }, limit });
    const tenantEvents = perms.includes('tenants:read') ? await tx.collection<{ id: string; action: string; tenant_id: string; actor_label: string | null; created_at: Date; metadata: Record<string, unknown> }>('audit_events')
      .find({ action: { $in: ['hr_workspace.created', 'membership.invited', 'membership.provisioned', 'invitation.accepted', 'support_access.approved', 'support_access.rejected'] }, tenant_id: { $ne: null }, created_at: time }, { sort: { created_at: -1 }, limit }) : [];
    const tIds = [...new Set([...notes.map((n) => n.tenant_id), ...tenantEvents.map((e) => e.tenant_id)].filter(Boolean))] as string[];
    const tenants = new Map((await tx.collection<{ id: string; name: string; company_id: string | null }>('tenants').find({ id: { $in: tIds } }, { projection: { name: 1, company_id: 1 } })).map((t) => [t.id, t]));
    const tone = (p: string, kind: string): ActivityFeedItem['status'] => (kind.includes('failed') || p === 'urgent' ? 'danger' : p === 'high' ? 'warning' : kind.includes('received') || kind.includes('created') || kind.includes('converted') ? 'success' : 'info');
    const items: ActivityFeedItem[] = [
      ...notes.map((n) => {
        const t = n.tenant_id ? tenants.get(n.tenant_id) : undefined;
        return { id: `n:${n.id}`, at: n.created_at.toISOString(), kind: n.kind, title: n.title, company: t?.name ?? null, clientId: n.company_id ?? t?.company_id ?? null, tenantId: n.tenant_id, user: n.body, status: tone(n.priority, n.kind), href: n.href, action: n.href ? 'Open' : null };
      }),
      ...tenantEvents.map((e) => {
        const t = tenants.get(e.tenant_id);
        const title = e.action === 'hr_workspace.created' ? 'HR Workspace created' : e.action === 'membership.invited' ? 'User invited' : e.action === 'membership.provisioned' ? 'User created' : e.action === 'invitation.accepted' ? 'Invitation accepted' : humanAction(e.action);
        return { id: `a:${e.id}`, at: e.created_at.toISOString(), kind: e.action, title, company: t?.name ?? null, clientId: t?.company_id ?? null, tenantId: e.tenant_id, user: actorName(e.actor_label), status: 'info' as const, href: t?.company_id ? `/clients/${t.company_id}?tab=workspaces` : null, action: t?.company_id ? 'Open' : null };
      }),
    ];
    return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  async feed(limit: number, before?: string) {
    const perms = requestContext.platformActor().permissions;
    return this.db.platform((tx) => this.activity(tx, limit, perms, before ? new Date(before) : undefined));
  }
}

function sumOf(ts: TenantStats[], k: 'employeeWorkspaces' | 'activeUsers' | 'employees' | 'hrUsers') {
  return ts.reduce((a, t) => a + t[k], 0);
}

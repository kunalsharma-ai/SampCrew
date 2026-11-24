import { Injectable } from '@nestjs/common';
import { billingMath as bm, REPORT_LABEL, type ReportKind, type ReportQuery, type ReportResult } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { BillingEngine } from '../billing/billing-engine.service';
import { buckets, series } from './command-center.service';
import { ConsoleSettingsService } from './console-settings.service';
import { loadPortfolio } from './portfolio';
import { tableFile } from './table-file';

const DAY = 86_400_000;
const d10 = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString().slice(0, 10) : null);

/** Which reports need money permissions. */
const MONEY: ReportKind[] = ['business', 'subscriptions', 'payments'];

/**
 * Console reports: business (growth and revenue by month), workspaces (one row per Super Workspace), subscriptions
 * (one row per subscription) and payments (invoices, payments and refunds). Each can be filtered by dates, client,
 * plan and currency, viewed in the Console or downloaded as CSV, Excel or PDF. Every download is audited. Demo
 * workspaces are left out. Money reports need billing:read.
 */
@Injectable()
export class ConsoleReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly engine: BillingEngine,
    private readonly settings: ConsoleSettingsService,
    private readonly audit: AuditService,
  ) {}

  async run(kind: ReportKind, q: ReportQuery): Promise<ReportResult> {
    const perms = requestContext.platformActor().permissions;
    if (MONEY.includes(kind) && !perms.includes('billing:read')) throw Errors.forbidden('This report shows money; your role cannot see billing.');
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11, 1));
    if (from > to) throw Errors.badRequest('bad_range', 'The start date is after the end date');
    if (to.getTime() - from.getTime() > 3 * 366 * DAY) throw Errors.badRequest('bad_range', 'Pick at most three years');
    const span = (to.getTime() - from.getTime()) / DAY;
    const bucket = span <= 62 ? 'day' : span <= 200 ? 'week' : 'month';
    const starts = buckets(from, to, bucket);

    return this.db.platform(async (tx) => {
      const cfg = await this.settings.read(tx);
      const all = (await loadPortfolio(tx, this.engine, cfg.notifications.inactiveAfterDays, q.clientId ? { companyIds: [q.clientId] } : {})).filter((c) => !c.company.is_demo);
      const tenants = all.flatMap((c) => c.tenants.map((t) => ({ ...t, company: c.company.name })))
        .filter((t) => !q.plan || t.plan?.key === q.plan);
      const tenantIds = tenants.map((t) => t.id);
      const currencies = [...new Set(tenants.map((t) => t.sub?.currency).filter((c): c is string => !!c))];
      const currency = q.currency ?? currencies.sort((a, b) => tenants.filter((t) => t.sub?.currency === b).length - tenants.filter((t) => t.sub?.currency === a).length)[0] ?? 'INR';
      const base = { kind, title: `${REPORT_LABEL[kind]} report`, from: d10(from)!, to: d10(to)!, currency };
      const inWin = { $gte: from, $lte: to };

      if (kind === 'workspaces') {
        const hr = await tx.collection<{ tenant_id: string; created_at: Date }>('hr_workspaces').find({ tenant_id: { $in: tenantIds }, status: { $ne: 'archived' } }, { projection: { tenant_id: 1, created_at: 1 } });
        const members = await tx.collection<{ tenant_id: string; created_at: Date }>('memberships').find({ tenant_id: { $in: tenantIds }, created_at: inWin }, { projection: { tenant_id: 1, created_at: 1 } });
        const rows = tenants.sort((a, b) => b.users - a.users).map((t) => ({
          company: t.company, workspace: t.name, status: t.status, plan: t.plan?.name ?? null, users: t.users, activeUsers: t.activeUsers, hrWorkspaces: t.hrWorkspaces,
          employees: t.employees, newUsers: members.filter((m) => m.tenant_id === t.id).length, created: d10(t.createdAt), lastActivity: d10(t.lastActivityAt),
        }));
        return {
          ...base,
          summary: [
            { label: 'Super Workspaces', value: String(tenants.length) },
            { label: 'HR Workspaces', value: String(hr.length) },
            { label: 'Employee Workspaces', value: String(tenants.reduce((a, t) => a + t.employeeWorkspaces, 0)), hint: 'Accounts that can sign in' },
            { label: 'New users in range', value: String(members.length) },
          ],
          seriesKeys: [{ key: 'workspaces', label: 'New Super Workspaces' }, { key: 'hr', label: 'New HR Workspaces' }, { key: 'users', label: 'New users' }],
          series: series(starts, bucket, ['workspaces', 'hr', 'users'], [
            ...tenants.filter((t) => t.createdAt >= from && t.createdAt <= to).map((t) => ({ at: t.createdAt, key: 'workspaces', value: 1 })),
            ...hr.filter((h) => h.created_at >= from && h.created_at <= to).map((h) => ({ at: h.created_at, key: 'hr', value: 1 })),
            ...members.map((m) => ({ at: m.created_at, key: 'users', value: 1 })),
          ]),
          table: {
            columns: [
              { key: 'company', label: 'Company' }, { key: 'workspace', label: 'Super Workspace' }, { key: 'status', label: 'Status' }, { key: 'plan', label: 'Plan' },
              { key: 'users', label: 'Users', align: 'right' }, { key: 'activeUsers', label: 'Active', align: 'right' }, { key: 'hrWorkspaces', label: 'HR Workspaces', align: 'right' },
              { key: 'employees', label: 'Employees', align: 'right' }, { key: 'newUsers', label: 'New users', align: 'right' }, { key: 'created', label: 'Created' }, { key: 'lastActivity', label: 'Last activity' },
            ],
            rows,
          },
        };
      }

      const invoices = await tx.collection<{ id: string; number: string; tenant_id: string; status: string; total: string; tax: string; currency: string; paid_at: Date | null; issued_at: Date | null; created_at: Date; due_at: Date | null; provider: string | null; kind: string | null }>('invoices')
        .find({ tenant_id: { $in: tenantIds }, currency, status: { $in: ['open', 'paid', 'void', 'uncollectible'] } });
      const credits = await tx.collection<{ number: string; tenant_id: string; amount: string; kind: string; method: string; created_at: Date; reason: string; status: string; invoice_id: string | null }>('credit_notes').find({ tenant_id: { $in: tenantIds }, currency, status: 'issued' });
      const nameOf = new Map(tenants.map((t) => [t.id, `${t.company}${t.company !== t.name ? ` / ${t.name}` : ''}`]));

      if (kind === 'business') {
        const paid = invoices.filter((i) => i.status === 'paid' && i.paid_at && i.paid_at >= from && i.paid_at <= to);
        const refunds = credits.filter((c) => c.kind === 'refund' && c.created_at >= from && c.created_at <= to);
        const newCompanies = all.filter((c) => c.company.created_at >= from && c.company.created_at <= to);
        const newTenants = tenants.filter((t) => t.createdAt >= from && t.createdAt <= to);
        const pts = series(starts, bucket, ['revenue', 'refunds', 'companies', 'workspaces'], [
          ...paid.map((i) => ({ at: i.paid_at!, key: 'revenue', value: Number(i.total) })),
          ...refunds.map((r) => ({ at: r.created_at, key: 'refunds', value: Number(r.amount) })),
          ...newCompanies.map((c) => ({ at: c.company.created_at, key: 'companies', value: 1 })),
          ...newTenants.map((t) => ({ at: t.createdAt, key: 'workspaces', value: 1 })),
        ]);
        const mrr = bm.sum(tenants.filter((t) => t.sub?.currency === currency).map((t) => t.mrr));
        const gross = bm.sum(paid.map((i) => String(i.total)));
        const refunded = bm.sum(refunds.map((r) => String(r.amount)));
        return {
          ...base,
          summary: [
            { label: 'Revenue collected', value: `${currency} ${gross}` },
            { label: 'Refunded', value: `${currency} ${refunded}` },
            { label: 'Net revenue', value: `${currency} ${bm.minus(gross, refunded)}` },
            { label: 'MRR now', value: `${currency} ${mrr}`, hint: `ARR ${currency} ${bm.times(mrr, 12)}` },
            { label: 'New companies', value: String(newCompanies.length) },
            { label: 'New Super Workspaces', value: String(newTenants.length) },
          ],
          seriesKeys: [{ key: 'revenue', label: 'Revenue' }, { key: 'refunds', label: 'Refunds' }, { key: 'companies', label: 'New companies' }, { key: 'workspaces', label: 'New Super Workspaces' }],
          series: pts,
          table: {
            columns: [{ key: 'period', label: 'Period' }, { key: 'revenue', label: `Revenue (${currency})`, align: 'right' }, { key: 'refunds', label: `Refunds (${currency})`, align: 'right' }, { key: 'net', label: `Net (${currency})`, align: 'right' }, { key: 'companies', label: 'New companies', align: 'right' }, { key: 'workspaces', label: 'New Super Workspaces', align: 'right' }],
            rows: pts.map((p) => ({ period: p.label, revenue: p.values.revenue!.toFixed(2), refunds: p.values.refunds!.toFixed(2), net: (p.values.revenue! - p.values.refunds!).toFixed(2), companies: p.values.companies!, workspaces: p.values.workspaces! })),
          },
        };
      }

      if (kind === 'subscriptions') {
        const events = await tx.collection<{ tenant_id: string; kind: string; occurred_at: Date }>('billing_events').find({ tenant_id: { $in: tenantIds }, occurred_at: inWin, kind: { $in: ['new', 'trial_started', 'trial_converted', 'upgrade', 'downgrade', 'cancelled'] } });
        const subs = tenants.filter((t) => t.sub);
        const count = (k: string) => events.filter((e) => e.kind === k).length;
        return {
          ...base,
          summary: [
            { label: 'Active', value: String(subs.filter((t) => ['active', 'past_due'].includes(t.sub!.status)).length) },
            { label: 'Trials', value: String(subs.filter((t) => t.sub!.status === 'trialing').length) },
            { label: 'Payment due', value: String(subs.filter((t) => t.sub!.status === 'past_due').length) },
            { label: 'New in range', value: String(count('new')) },
            { label: 'Upgrades in range', value: String(count('upgrade')) },
            { label: 'Downgrades in range', value: String(count('downgrade')) },
            { label: 'Cancelled in range', value: String(count('cancelled')) },
          ],
          seriesKeys: [{ key: 'trial_started', label: 'Trials started' }, { key: 'trial_converted', label: 'Trials converted' }, { key: 'upgrade', label: 'Upgrades' }, { key: 'downgrade', label: 'Downgrades' }, { key: 'cancelled', label: 'Cancelled' }],
          series: series(starts, bucket, ['trial_started', 'trial_converted', 'upgrade', 'downgrade', 'cancelled'], events.filter((e) => e.kind !== 'new').map((e) => ({ at: e.occurred_at, key: e.kind, value: 1 }))),
          table: {
            columns: [{ key: 'company', label: 'Company' }, { key: 'workspace', label: 'Super Workspace' }, { key: 'plan', label: 'Plan' }, { key: 'status', label: 'Status' }, { key: 'cycle', label: 'Cycle' }, { key: 'seats', label: 'Seats', align: 'right' }, { key: 'mrr', label: `MRR (${currency})`, align: 'right' }, { key: 'renews', label: 'Renews / ends' }, { key: 'provider', label: 'Paid through' }],
            rows: subs.map((t) => ({
              company: t.company, workspace: t.name, plan: t.plan?.name ?? null, status: t.sub!.status.replace('_', ' '), cycle: t.sub!.billing_cycle, seats: t.sub!.seats,
              mrr: t.sub!.currency === currency ? t.mrr : null, renews: t.sub!.status === 'trialing' ? t.sub!.trial_ends_on ?? null : t.sub!.current_period_end, provider: (t.sub as { provider?: string }).provider ?? 'manual',
            })),
          },
        };
      }

      // payments
      const orders = await tx.collection<{ id: string; tenant_id: string; status: string; amount: string; created_at: Date; paid_at: Date | null; provider: string; provider_payment_id: string | null; failure_reason: string | null }>('payment_orders')
        .find({ tenant_id: { $in: tenantIds }, currency, created_at: inWin });
      const issued = invoices.filter((i) => (i.issued_at ?? i.created_at) >= from && (i.issued_at ?? i.created_at) <= to);
      const paidIn = invoices.filter((i) => i.status === 'paid' && i.paid_at && i.paid_at >= from && i.paid_at <= to);
      const creditsIn = credits.filter((c) => c.created_at >= from && c.created_at <= to);
      const today = new Date();
      const rows: Record<string, string | number | null>[] = [
        ...issued.map((i) => ({ date: d10(i.issued_at ?? i.created_at), type: 'Invoice', number: i.number, client: nameOf.get(i.tenant_id) ?? null, amount: String(i.total), tax: String(i.tax ?? '0'), status: i.status === 'open' && i.due_at && i.due_at < today ? 'overdue' : i.status, method: i.provider ?? 'manual', detail: i.paid_at ? `Paid ${d10(i.paid_at)}` : i.due_at ? `Due ${d10(i.due_at)}` : null })),
        ...orders.filter((o) => o.status !== 'paid').map((o) => ({ date: d10(o.created_at), type: 'Payment attempt', number: o.provider_payment_id ?? o.id.slice(0, 8), client: nameOf.get(o.tenant_id) ?? null, amount: String(o.amount), tax: null, status: o.status, method: o.provider, detail: o.failure_reason ?? null })),
        ...creditsIn.map((c) => ({ date: d10(c.created_at), type: c.kind === 'refund' ? 'Refund' : 'Credit', number: c.number, client: nameOf.get(c.tenant_id) ?? null, amount: `-${String(c.amount)}`, tax: null, status: c.status, method: c.method.replace('_', ' '), detail: c.reason })),
      ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const failed = orders.filter((o) => o.status === 'failed');
      return {
        ...base,
        summary: [
          { label: 'Invoiced', value: `${currency} ${bm.sum(issued.map((i) => String(i.total)))}`, hint: `${issued.length} invoices` },
          { label: 'Collected', value: `${currency} ${bm.sum(paidIn.map((i) => String(i.total)))}` },
          { label: 'Outstanding now', value: `${currency} ${bm.sum(invoices.filter((i) => i.status === 'open').map((i) => String(i.total)))}` },
          { label: 'Failed payments', value: String(failed.length), hint: `${currency} ${bm.sum(failed.map((o) => String(o.amount)))}` },
          { label: 'Refunds and credits', value: `${currency} ${bm.sum(creditsIn.map((c) => String(c.amount)))}` },
        ],
        seriesKeys: [{ key: 'collected', label: 'Collected' }, { key: 'failed', label: 'Failed' }, { key: 'refunded', label: 'Refunded' }],
        series: series(starts, bucket, ['collected', 'failed', 'refunded'], [
          ...paidIn.map((i) => ({ at: i.paid_at!, key: 'collected', value: Number(i.total) })),
          ...failed.map((o) => ({ at: o.created_at, key: 'failed', value: Number(o.amount) })),
          ...creditsIn.filter((c) => c.kind === 'refund').map((c) => ({ at: c.created_at, key: 'refunded', value: Number(c.amount) })),
        ]),
        table: {
          columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'number', label: 'Number' }, { key: 'client', label: 'Client' }, { key: 'amount', label: `Amount (${currency})`, align: 'right' }, { key: 'tax', label: 'Tax', align: 'right' }, { key: 'status', label: 'Status' }, { key: 'method', label: 'Method' }, { key: 'detail', label: 'Detail' }],
          rows,
        },
      };
    });
  }

  async file(kind: ReportKind, q: ReportQuery, format: 'csv' | 'xlsx' | 'pdf') {
    if (!requestContext.platformActor().permissions.includes('reports:export')) throw Errors.forbidden('Your role cannot download reports.');
    const r = await this.run(kind, q);
    await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.report_exported', resourceType: 'report', resourceId: kind, metadata: { format, rows: r.table.rows.length, filters: { ...q, format: undefined } } }));
    const rows = [r.table.columns.map((c) => c.label), ...r.table.rows.map((row) => r.table.columns.map((c) => row[c.key] ?? null))];
    return tableFile(`sampcrew-${kind}-report`, r.title, `${r.from} to ${r.to} · ${r.currency} · ${r.summary.map((s) => `${s.label}: ${s.value}`).join(' · ')}`.slice(0, 300), rows, format);
  }
}

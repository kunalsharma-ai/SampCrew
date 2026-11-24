import { billingMath as bm, type ClientStatus } from '@crew/contracts';
import type { PlatformTx } from '../../platform/database/mongo.service';
import type { BillingEngine } from '../billing/billing-engine.service';

/**
 * The Console's view of every customer in one pass: client companies, their Super Workspaces (tenants), each
 * workspace's subscription and counts, and money per currency. Read by the client list, the client 360, the command
 * center and the reports, so a number means the same thing everywhere. Counts only: no HR records are read.
 *
 * Definitions (also shown in the Console help):
 *  - Users: sign-in accounts of a workspace that are not suspended (active or invited).
 *  - Active users: accounts that are active.
 *  - HR/Admin users: people holding the Super Workspace or HR Workspace level.
 *  - Employees: employee records that have not exited.
 *  - Employee Workspaces: sign-in accounts (the same count the plan limit uses).
 *  - Revenue: paid invoices. Outstanding: open invoices. MRR: active and overdue subscriptions (not trials or demo).
 */
export interface TenantStats {
  id: string;
  companyId: string | null;
  name: string;
  slug: string;
  status: string;
  isDemo: boolean;
  createdAt: Date;
  setupDone: boolean;
  countryCode: string | null;
  plan: { id: string; key: string; name: string; quoteOnly: boolean; enterprise: boolean } | null;
  sub: SubRow | null;
  mrr: string;
  users: number;
  activeUsers: number;
  invited: number;
  hrUsers: number;
  employees: number;
  hrWorkspaces: number;
  employeeWorkspaces: number;
  revenue: Record<string, string>;
  outstanding: Record<string, string>;
  overdue: boolean;
  lastActivityAt: Date | null;
}

export interface SubRow {
  id: string; tenant_id: string; plan_id: string; status: string; currency: string; seats: number; unit_price: string; billing_cycle: string;
  trial_ends_on: string | null; current_period_end: string; current_period_start: string; cancel_at_period_end: boolean; created_at: Date; cancelled_at: Date | null;
  deal?: unknown; feature_overrides?: unknown; locked_at?: Date | null;
}

export interface CompanyRow {
  id: string; name: string; legal_name: string | null; industry: string | null; company_size: string | null; country_code: string | null; address: { city?: string | null; country?: string | null } | null;
  logo_url: string | null; is_demo: boolean; created_at: Date; archived_at: Date | null; tags: string[]; account_manager_admin_id: string | null;
  website: string | null; email: string | null; phone: string | null;
}

export interface CompanyStats {
  company: CompanyRow;
  tenants: TenantStats[];
  status: ClientStatus;
}

const sumInto = (into: Record<string, string>, currency: string, amount: string) => { into[currency] = bm.sum([into[currency] ?? '0', amount]); };

/** Group-by counts as a map (id -> n). */
async function groupCount(tx: PlatformTx, table: string, match: Record<string, unknown>, by: string, distinct?: string): Promise<Map<string, number>> {
  const pipeline = distinct
    ? [{ $match: match }, { $group: { _id: { k: `$${by}`, d: `$${distinct}` } } }, { $group: { _id: '$_id.k', n: { $sum: 1 } } }]
    : [{ $match: match }, { $group: { _id: `$${by}`, n: { $sum: 1 } } }];
  const rows = await tx.collection(table).aggregate<{ id: string; n: number }>(pipeline);
  return new Map(rows.map((r) => [String(r.id), r.n]));
}

export async function loadTenantStats(tx: PlatformTx, engine: BillingEngine, filter: { tenantIds?: string[] } = {}): Promise<TenantStats[]> {
  const tFilter = filter.tenantIds ? { id: { $in: filter.tenantIds } } : {};
  const tenants = await tx.collection<{ id: string; company_id?: string | null; name: string; slug: string; status: string; is_demo: boolean; created_at: Date; setup_completed_at: Date | null; country_code: string | null }>('tenants')
    .find(tFilter, { projection: { id: 1, company_id: 1, name: 1, slug: 1, status: 1, is_demo: 1, created_at: 1, setup_completed_at: 1, country_code: 1 } });
  const ids = tenants.map((t) => t.id);
  const inT = { tenant_id: { $in: ids } };
  const subs = new Map((await tx.collection<SubRow>('subscriptions').find(inT)).map((s) => [s.tenant_id, s]));
  const plans = new Map((await tx.collection<{ id: string; key: string; name: string; quote_only: boolean }>('plans').find({})).map((p) => [p.id, p]));
  const addonRows = await tx.collection<{ tenant_id: string; addon_id: string }>('subscription_addons').find({ ...inT, status: 'active' });
  const addonDefs = new Map((await tx.collection('addons').find({})).map((a) => [a.id as string, a]));
  const users = await groupCount(tx, 'memberships', { ...inT, status: { $ne: 'suspended' } }, 'tenant_id');
  const active = await groupCount(tx, 'memberships', { ...inT, status: 'active' }, 'tenant_id');
  const invited = await groupCount(tx, 'memberships', { ...inT, status: 'invited' }, 'tenant_id');
  const levelRoles = await tx.collection<{ id: string }>('roles').find({ ...inT, is_system: true, key: { $in: ['super_workspace', 'hr_workspace'] } }, { projection: { id: 1 } });
  const liveMemberships = await tx.collection<{ id: string }>('memberships').distinct<string>('id', { ...inT, status: { $ne: 'suspended' } });
  const hrUsers = await groupCount(tx, 'role_assignments', { ...inT, role_id: { $in: levelRoles.map((r) => r.id) }, membership_id: { $in: liveMemberships } }, 'tenant_id', 'membership_id');
  const employees = await groupCount(tx, 'employees', { ...inT, status: { $ne: 'exited' } }, 'tenant_id');
  const hrSpaces = await groupCount(tx, 'hr_workspaces', { ...inT, status: { $ne: 'archived' } }, 'tenant_id');
  const money = await tx.collection('invoices').aggregate<{ id: { t: string; c: string; s: string }; total: string; overdue: number }>([
    { $match: { ...inT, status: { $in: ['paid', 'open'] } } },
    { $group: { _id: { t: '$tenant_id', c: '$currency', s: '$status' }, total: { $sum: '$total' }, overdue: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'open'] }, { $lt: ['$due_at', new Date()] }] }, 1, 0] } } } },
  ]);
  const refunds = await tx.collection('credit_notes').aggregate<{ id: { t: string; c: string }; total: string }>([
    { $match: { ...inT, kind: 'refund', status: 'issued' } }, { $group: { _id: { t: '$tenant_id', c: '$currency' }, total: { $sum: '$amount' } } },
  ]);
  const lastSeen = new Map((await tx.collection('sessions').aggregate<{ id: string; at: Date }>([{ $match: inT }, { $group: { _id: '$tenant_id', at: { $max: '$created_at' } } }])).map((r) => [String(r.id), r.at]));
  return tenants.map((t): TenantStats => {
    const sub = subs.get(t.id) ?? null;
    const p = sub ? plans.get(sub.plan_id) : undefined;
    const revenue: Record<string, string> = {};
    const outstanding: Record<string, string> = {};
    let overdue = false;
    for (const m of money.filter((x) => x.id.t === t.id)) {
      if (m.id.s === 'paid') sumInto(revenue, m.id.c, String(m.total));
      else { sumInto(outstanding, m.id.c, String(m.total)); if (m.overdue > 0) overdue = true; }
    }
    for (const r of refunds.filter((x) => x.id.t === t.id)) sumInto(revenue, r.id.c, bm.minus('0', String(r.total)));
    const mrr = sub && !t.is_demo ? engine.mrr({ sub: sub as never, addons: addonRows.filter((a) => a.tenant_id === t.id).map((row) => ({ row, def: addonDefs.get(row.addon_id) ?? {} })) as never }) : '0.00';
    return {
      id: t.id, companyId: t.company_id ?? null, name: t.name, slug: t.slug, status: t.status, isDemo: t.is_demo, createdAt: t.created_at, setupDone: !!t.setup_completed_at, countryCode: t.country_code ?? null,
      plan: p ? { id: p.id, key: p.key, name: p.name, quoteOnly: !!p.quote_only, enterprise: p.key === 'enterprise' || !!p.quote_only } : null,
      sub, mrr,
      users: users.get(t.id) ?? 0, activeUsers: active.get(t.id) ?? 0, invited: invited.get(t.id) ?? 0, hrUsers: hrUsers.get(t.id) ?? 0, employees: employees.get(t.id) ?? 0,
      hrWorkspaces: hrSpaces.get(t.id) ?? 0, employeeWorkspaces: users.get(t.id) ?? 0, revenue, outstanding, overdue, lastActivityAt: lastSeen.get(t.id) ?? null,
    };
  });
}

/** A company's account status, worked out from its workspaces (never typed in). */
export function companyStatus(c: Pick<CompanyRow, 'archived_at'>, tenants: TenantStats[], inactiveAfterDays: number): ClientStatus {
  if (c.archived_at) return 'archived';
  const live = tenants.filter((t) => t.status === 'active');
  if (!tenants.length) return 'setup_pending';
  if (!live.length) return 'suspended';
  if (live.some((t) => t.overdue || t.sub?.status === 'past_due' || t.sub?.locked_at)) return 'payment_due';
  if (live.every((t) => t.sub?.status === 'trialing')) return 'trial';
  if (live.every((t) => !t.setupDone) && live.every((t) => t.activeUsers <= 1)) return 'setup_pending';
  const cutoff = Date.now() - inactiveAfterDays * 86_400_000;
  if (live.every((t) => !t.lastActivityAt || t.lastActivityAt.getTime() < cutoff)) return 'inactive';
  return 'active';
}

export async function loadPortfolio(tx: PlatformTx, engine: BillingEngine, inactiveAfterDays: number, filter: { companyIds?: string[] } = {}): Promise<CompanyStats[]> {
  const companies = await tx.collection<CompanyRow>('companies').find(filter.companyIds ? { id: { $in: filter.companyIds } } : {});
  const tenantIds = filter.companyIds ? await tx.collection('tenants').distinct<string>('id', { company_id: { $in: filter.companyIds } }) : undefined;
  const stats = await loadTenantStats(tx, engine, tenantIds ? { tenantIds } : {});
  const by = new Map<string, TenantStats[]>();
  for (const t of stats) if (t.companyId) by.set(t.companyId, [...(by.get(t.companyId) ?? []), t]);
  return companies.map((company) => {
    const tenants = (by.get(company.id) ?? []).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return { company, tenants, status: companyStatus(company, tenants, inactiveAfterDays) };
  });
}

export function addMoney(maps: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) for (const [c, v] of Object.entries(m)) sumInto(out, c, v);
  return out;
}

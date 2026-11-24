import { Alert, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import { SubNav } from '@/components/sub-nav';
import type { LeaveDashboard, LeaveHistoryRow, LeaveQuantities, LeaveReport, LeaveRequest, LeaveType, Me } from '@/lib/types';
import { ApprovalsPanel } from './approvals-panel';
import { DashboardPanel, HistoryPanel, ReportsPanel } from './panels';
import type { LeaveOptions } from './pickers';
import { QuantitiesPanel } from './quantities-panel';
import { TypesPanel } from './types-panel';

export const metadata: Metadata = { title: 'Leave management' };

const TABS = ['dashboard', 'types', 'quantities', 'approvals', 'reports', 'history'] as const;
type Tab = (typeof TABS)[number];

/**
 * Leave management for the Super Workspace and HR Workspaces: leave types (name, code, who sees them, on or off),
 * quantities typed by hand, approvals, reports and history. Nothing is allocated or calculated automatically.
 * Each tab shows only when the person's permissions allow it; the API checks every action again.
 */
export default async function LeaveManagePage({ searchParams }: { searchParams: Promise<{ tab?: string; year?: string; hrWorkspaceId?: string; q?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  if (!can(me, 'leave:allocate') && !can(me, 'leave:assign') && !can(me, 'leavetypes:create')) {
    return (
      <>
        <PageHeader title="Leave management" />
        <Alert tone="info">Leave management is for the Super Workspace and HR Workspaces. Your own leave is on the <Link className="underline" href="/leave">Leave</Link> page.</Alert>
      </>
    );
  }
  const isSuper = can(me, 'leave:configure');
  const allowed = new Set<Tab>(TABS.filter((t) => t === 'quantities' ? can(me, 'leave:assign') : t === 'types' ? can(me, 'leave:read') : t === 'approvals' ? can(me, 'leave:approve') : can(me, 'leave:allocate')));
  const first = TABS.find((t) => allowed.has(t)) ?? 'types';
  const tab: Tab = allowed.has(sp.tab as Tab) ? (sp.tab as Tab) : first;
  const year = /^\d{4}$/.test(sp.year ?? '') ? Number(sp.year) : new Date().getUTCFullYear();
  const q = new URLSearchParams({ year: String(year), ...(sp.hrWorkspaceId ? { hrWorkspaceId: sp.hrWorkspaceId } : {}) });
  const [dashboard, types, options, quantities, waiting, recent, report, history] = await Promise.all([
    can(me, 'leave:allocate') ? loadOptional<LeaveDashboard>(`/leave/dashboard?${q}`) : Promise.resolve(null),
    tab === 'types' ? load<LeaveType[]>('/leave/types?includeArchived=true') : Promise.resolve([] as LeaveType[]),
    tab === 'types' && can(me, 'leave:allocate') ? loadOptional<LeaveOptions>('/leave/options') : Promise.resolve(null),
    tab === 'quantities' ? load<LeaveQuantities>(`/leave/quantities?${new URLSearchParams({ year: String(year), ...(sp.q ? { q: sp.q } : {}) })}`) : Promise.resolve(null),
    tab === 'approvals' ? load<LeaveRequest[]>('/leave/requests?scope=review&limit=200') : Promise.resolve([] as LeaveRequest[]),
    tab === 'approvals' ? load<LeaveRequest[]>('/leave/requests?scope=visible&limit=50') : Promise.resolve([] as LeaveRequest[]),
    tab === 'reports' ? load<LeaveReport>(`/leave/reports?${q}`) : Promise.resolve(null),
    tab === 'history' ? load<LeaveHistoryRow[]>('/leave/history?limit=300') : Promise.resolve([] as LeaveHistoryRow[]),
  ]);
  const href = (t: Tab) => `/leave/manage?${new URLSearchParams({ tab: t, ...(sp.year ? { year: sp.year } : {}) })}`;
  const labels: Record<Tab, string> = { dashboard: 'Dashboard', types: 'Leave types', quantities: 'Quantities', approvals: 'Approvals', reports: 'Reports', history: 'History' };
  const order: Tab[] = TABS.filter((t) => allowed.has(t));
  const noOptions = { level: isSuper ? 'super' : 'hr', departments: [], designations: [], locations: [], legalEntities: [], groups: [], hrWorkspaces: [], companyHr: false, superAdmins: [], employees: [] } as LeaveOptions;
  return (
    <>
      <PageHeader
        title="Leave management"
        eyebrow={isSuper ? 'Super Workspace' : 'HR Workspace'}
        description={isSuper
          ? 'Create leave types, choose who sees them, type the quantities people have, and follow every application across the company.'
          : 'Review your people’s applications, type the quantities they have, and manage your own leave types when the Super Workspace allows it.'}
        actions={!isSuper ? <Link className="text-sm font-medium text-accent hover:underline" href="/leave/balances">Balances and adjustments</Link> : undefined}
      />
      <SubNav label="Leave management" current={href(tab)} items={order.map((t) => ({ href: href(t), label: labels[t], count: t === 'approvals' ? dashboard?.counts.waitingForMe : undefined, alert: t === 'approvals', testId: `leave-tab-${t}` }))} />
      {(tab === 'dashboard' || tab === 'reports') && (
        <nav aria-label="Year" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-muted">Year:</span>
          {[year - 1, year, year + 1].map((y) => (
            <Link key={y} href={`/leave/manage?${new URLSearchParams({ tab, year: String(y), ...(sp.hrWorkspaceId ? { hrWorkspaceId: sp.hrWorkspaceId } : {}) })}`} aria-current={y === year ? 'page' : undefined}
              className={y === year ? 'rounded-md bg-bg-subtle px-2 py-1 font-semibold' : 'rounded-md px-2 py-1 text-fg-muted hover:text-fg'}>{y}</Link>
          ))}
          {dashboard && dashboard.hrWorkspaces.length > 1 && (
            <>
              <span className="ml-3 text-fg-muted">HR Workspace:</span>
              <Link href={`/leave/manage?${new URLSearchParams({ tab, year: String(year) })}`} className={!sp.hrWorkspaceId ? 'font-semibold' : 'text-fg-muted'}>All</Link>
              {dashboard.hrWorkspaces.map((w) => (
                <Link key={w.id} href={`/leave/manage?${new URLSearchParams({ tab, year: String(year), hrWorkspaceId: w.id })}`} className={sp.hrWorkspaceId === w.id ? 'font-semibold' : 'text-fg-muted'}>{w.name}</Link>
              ))}
            </>
          )}
        </nav>
      )}
      {tab === 'dashboard' && dashboard && <DashboardPanel d={dashboard} />}
      {tab === 'types' && <TypesPanel types={types} options={options ?? noOptions} isSuper={isSuper} canCreate={can(me, 'leavetypes:create')} canVisibility={can(me, 'leavetypes:visibility')} />}
      {tab === 'quantities' && quantities && <QuantitiesPanel data={quantities} q={sp.q ?? ''} />}
      {tab === 'approvals' && <ApprovalsPanel waiting={waiting} recent={recent} />}
      {tab === 'reports' && report && <ReportsPanel r={report} />}
      {tab === 'history' && <HistoryPanel rows={history} />}
    </>
  );
}

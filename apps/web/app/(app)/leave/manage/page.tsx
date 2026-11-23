import { Alert, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import { SubNav } from '@/components/sub-nav';
import type { LeaveAllocation, LeaveDashboard, LeaveHistoryRow, LeaveReport, LeaveRequest, LeaveType, Me, StandardLeaveType } from '@/lib/types';
import { AllocationPanel } from './allocation-panel';
import { ApprovalsPanel } from './approvals-panel';
import { DashboardPanel, HistoryPanel, ReportsPanel } from './panels';
import type { LeaveOptions } from './pickers';
import { TypesPanel } from './types-panel';

export const metadata: Metadata = { title: 'Leave management' };

const TABS = ['dashboard', 'types', 'allocation', 'approvals', 'reports', 'history'] as const;
type Tab = (typeof TABS)[number];

/**
 * Leave management for the Super Workspace (leave types and their policies, allocation, approvals, reports and
 * history) and for HR Workspaces (the types made available to them, allocation to their people, approvals).
 */
export default async function LeaveManagePage({ searchParams }: { searchParams: Promise<{ tab?: string; year?: string; hrWorkspaceId?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  if (!can(me, 'leave:allocate')) {
    return (
      <>
        <PageHeader title="Leave management" />
        <Alert tone="info">Leave management is for the Super Workspace and HR Workspaces. Your own leave is on the <Link className="underline" href="/leave">Leave</Link> page.</Alert>
      </>
    );
  }
  const isSuper = can(me, 'leave:configure');
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? (sp.tab as Tab) : 'dashboard';
  const year = /^\d{4}$/.test(sp.year ?? '') ? Number(sp.year) : new Date().getUTCFullYear();
  const q = new URLSearchParams({ year: String(year), ...(sp.hrWorkspaceId ? { hrWorkspaceId: sp.hrWorkspaceId } : {}) });
  const needsTypes = tab === 'types' || tab === 'allocation';
  const [dashboard, types, options, allocations, standard, waiting, recent, report, history] = await Promise.all([
    load<LeaveDashboard>(`/leave/dashboard?${q}`),
    needsTypes ? load<LeaveType[]>('/leave/types?includeArchived=true') : Promise.resolve([] as LeaveType[]),
    needsTypes ? load<LeaveOptions>('/leave/options') : Promise.resolve(null),
    tab === 'allocation' ? load<LeaveAllocation[]>('/leave/allocations') : Promise.resolve([] as LeaveAllocation[]),
    tab === 'types' && isSuper ? loadOptional<StandardLeaveType[]>('/leave/types/standard') : Promise.resolve(null),
    tab === 'approvals' ? load<LeaveRequest[]>('/leave/requests?scope=review&limit=200') : Promise.resolve([] as LeaveRequest[]),
    tab === 'approvals' ? load<LeaveRequest[]>('/leave/requests?scope=visible&limit=50') : Promise.resolve([] as LeaveRequest[]),
    tab === 'reports' ? load<LeaveReport>(`/leave/reports?${q}`) : Promise.resolve(null),
    tab === 'history' ? load<LeaveHistoryRow[]>('/leave/history?limit=300') : Promise.resolve([] as LeaveHistoryRow[]),
  ]);
  const href = (t: Tab) => `/leave/manage?${new URLSearchParams({ tab: t, ...(sp.year ? { year: sp.year } : {}) })}`;
  const labels: Record<Tab, string> = { dashboard: 'Dashboard', types: isSuper ? 'Leave types' : 'Leave policies', allocation: 'Allocation', approvals: 'Approvals', reports: 'Reports', history: 'History' };
  const order: Tab[] = isSuper ? ['dashboard', 'types', 'allocation', 'approvals', 'reports', 'history'] : ['dashboard', 'allocation', 'approvals', 'types', 'reports', 'history'];
  return (
    <>
      <PageHeader
        title="Leave management"
        eyebrow={isSuper ? 'Super Workspace' : 'HR Workspace'}
        description={isSuper
          ? 'Create leave types with their policies, decide who gets them and who approves them, and follow every application across the company.'
          : 'Allocate the leave types the Super Workspace made available to you, review your people’s applications and follow their balances.'}
        actions={!isSuper ? <Link className="text-sm font-medium text-accent hover:underline" href="/leave/balances">Balances and adjustments</Link> : undefined}
      />
      <SubNav label="Leave management" current={href(tab)} items={order.map((t) => ({ href: href(t), label: labels[t], count: t === 'approvals' ? dashboard.counts.waitingForMe : undefined, alert: t === 'approvals', testId: `leave-tab-${t}` }))} />
      {(tab === 'dashboard' || tab === 'reports') && (
        <nav aria-label="Year" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-fg-muted">Year:</span>
          {[year - 1, year, year + 1].map((y) => (
            <Link key={y} href={`/leave/manage?${new URLSearchParams({ tab, year: String(y), ...(sp.hrWorkspaceId ? { hrWorkspaceId: sp.hrWorkspaceId } : {}) })}`} aria-current={y === year ? 'page' : undefined}
              className={y === year ? 'rounded-md bg-bg-subtle px-2 py-1 font-semibold' : 'rounded-md px-2 py-1 text-fg-muted hover:text-fg'}>{y}</Link>
          ))}
          {dashboard.hrWorkspaces.length > 1 && (
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
      {tab === 'dashboard' && <DashboardPanel d={dashboard} />}
      {tab === 'types' && options && <TypesPanel types={types} standard={standard ?? []} options={options} canConfigure={isSuper} />}
      {tab === 'allocation' && options && <AllocationPanel types={types} allocations={allocations} options={options} />}
      {tab === 'approvals' && <ApprovalsPanel waiting={waiting} recent={recent} />}
      {tab === 'reports' && report && <ReportsPanel r={report} />}
      {tab === 'history' && <HistoryPanel rows={history} />}
    </>
  );
}

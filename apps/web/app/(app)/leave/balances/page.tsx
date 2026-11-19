import { Alert, PageHeader, cn } from '@crew/ui';
import Link from 'next/link';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Department, LeaveAdjustment, LeaveOverview, LeaveType, Me } from '@/lib/types';
import { AdjustmentHistory, BalanceOverview } from './balances-view';

export const metadata: Metadata = { title: 'Leave balances' };

/**
 * Leave balances of everyone the member may see (HR for their scope, managers for their team), with manual
 * adjustments and the history of every adjustment and its remark.
 */
export default async function LeaveBalancesPage({ searchParams }: { searchParams: Promise<{ year?: string; departmentId?: string; q?: string; tab?: string; employeeId?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const year = /^\d{4}$/.test(sp.year ?? '') ? Number(sp.year) : new Date().getUTCFullYear();
  const tab = sp.tab === 'history' ? 'history' : 'balances';
  if (!can(me, 'leave:approve')) {
    return (
      <>
        <PageHeader title="Leave balances" />
        <Alert tone="info">Team leave balances are for managers and HR. Your own balances are on the Leave page.</Alert>
      </>
    );
  }
  const qs = new URLSearchParams({ year: String(year) });
  if (sp.departmentId) qs.set('departmentId', sp.departmentId);
  if (sp.q) qs.set('q', sp.q);
  const hq = new URLSearchParams({ year: String(year) });
  if (sp.employeeId) hq.set('employeeId', sp.employeeId);
  const [overview, history, departments, types] = await Promise.all([
    tab === 'balances' ? load<LeaveOverview>(`/leave/balances/overview?${qs}`) : Promise.resolve(null),
    tab === 'history' ? load<LeaveAdjustment[]>(`/leave/adjustments?${hq}`) : Promise.resolve(null),
    loadOptional<Department[]>('/org/departments'),
    load<LeaveType[]>('/leave/types'),
  ]);
  const base = (t: string) => `/leave/balances?${new URLSearchParams({ year: String(year), ...(t === 'history' ? { tab: 'history' } : {}) })}`;
  return (
    <>
      <PageHeader title="Leave balances" description={`What everyone you can see has available in ${year}, and every manual change made to a balance with its remark.`} />
      <nav className="mb-5 flex flex-wrap gap-1 border-b border-border" aria-label="Leave balances">
        {([['balances', 'Balances'], ['history', 'Adjustment history']] as const).map(([k, label]) => (
          <Link key={k} href={base(k)} aria-current={tab === k ? 'page' : undefined}
            className={cn('-mb-px border-b-2 px-3 py-2 text-[0.8125rem] font-medium', tab === k ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg')}>{label}</Link>
        ))}
      </nav>
      {overview && <BalanceOverview data={overview} departments={departments ?? []} types={types} filters={{ departmentId: sp.departmentId ?? '', q: sp.q ?? '' }} />}
      {history && <AdjustmentHistory rows={history} year={year} />}
    </>
  );
}

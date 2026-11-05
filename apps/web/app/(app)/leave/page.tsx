import { Alert, Card, CardHeader, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ApiError, api, load } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { can } from '@/lib/nav';
import type { LeaveBalance, LeaveRequest, Me } from '@/lib/types';
import { BalanceCards } from '../employees/[id]/tabs';
import { ApplyLeave, MyRequests, TeamAway } from './leave-view';

export const metadata: Metadata = { title: 'Leave' };

export default async function LeavePage() {
  const me = await load<Me>('/me');
  let balances: { year: number; balances: LeaveBalance[] } | null = null;
  try {
    balances = await api('/leave/balances');
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'no_employee_record')) return load<never>('/leave/balances');
  }
  if (!balances) {
    return (
      <>
        <PageHeader title="Leave" />
        <Alert tone="info" title="No employee record linked">Your login is not linked to an employee record yet, so there is no leave balance to show. Ask HR to link it from your employee profile.</Alert>
      </>
    );
  }
  const scope = me.permissions['leave:read'];
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [requests, away] = await Promise.all([
    load<LeaveRequest[]>('/leave/requests?scope=mine&limit=100'),
    scope && scope !== 'own' ? load<LeaveRequest[]>(`/leave/away?from=${today}&to=${in30}`) : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader title="Leave" description={`Your balances for ${balances.year}, requests and approvals.`} actions={can(me, 'leave:request') && <ApplyLeave balances={balances.balances} />} />
      <ModuleOverview module="leave" actions={allowed(me, [
        { label: 'Apply leave', href: '/leave?create=leave', icon: 'calendar', permission: 'leave:request' },
        { label: 'Approve requests', href: '/approvals', icon: 'check', permission: 'leave:approve' },
        { label: 'Team attendance', href: '/attendance/team?status=on_leave', icon: 'users-round', permission: 'attendance:approve', feature: 'attendance_basic' },
        { label: 'Leave policy', href: '/settings/leave', icon: 'sliders', permission: 'leave:configure' },
      ])} />
      <div className="grid gap-6">
        <BalanceCards balances={balances.balances} />
        <Card>
          <CardHeader title="My requests" />
          <MyRequests requests={requests} />
        </Card>
        {away && <TeamAway rows={away} />}
      </div>
    </>
  );
}

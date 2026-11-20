import { Alert, Card, CardHeader, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ApiError, api, load, loadOptional } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { can } from '@/lib/nav';
import type { LeaveBalance, LeaveCalendarData, LeaveRequest, Me } from '@/lib/types';
import { BalanceCards } from '../employees/[id]/tabs';
import { LeaveCalendar } from './leave-calendar';
import { LeaveYear } from './leave-year';
import { monthRange } from './month';
import { AddDefaultLeaveTypes, ApplyLeave, MyRequests, TeamAway } from './leave-view';

export const metadata: Metadata = { title: 'Leave' };

export default async function LeavePage({ searchParams }: { searchParams: Promise<{ month?: string; sent?: string; view?: string; year?: string }> }) {
  const sp = await searchParams;
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
  const month = sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : today.slice(0, 7);
  // The year view shows all twelve months; the month view one month with room to apply from a day.
  const yearView = sp.view === 'year';
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : Number(today.slice(0, 4));
  const { from, to } = yearView ? { from: `${year}-01-01`, to: `${year}-12-31` } : monthRange(month);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [requests, away, calendar, leaveFields] = await Promise.all([
    load<LeaveRequest[]>('/leave/requests?scope=mine&limit=100'),
    scope && scope !== 'own' ? load<LeaveRequest[]>(`/leave/away?from=${today}&to=${in30}`) : Promise.resolve(null),
    load<LeaveCalendarData>(`/leave/calendar?from=${from}&to=${to}`),
    loadOptional<{ id: string; enabled: boolean }[]>('/custom-fields?entity=leave_request'),
  ]);
  const sent = sp.sent ? requests.find((r) => r.id === sp.sent) : undefined;
  const canApply = can(me, 'leave:request') && balances.balances.length > 0;
  return (
    <>
      <PageHeader title="Leave" description={`Your balances for ${balances.year}, your leave calendar, requests and approvals.`} actions={can(me, 'leave:request') && <ApplyLeave balances={balances.balances} />} />
      <ModuleOverview module="leave" actions={allowed(me, [
        { label: 'Apply leave', href: '/leave?create=leave', icon: 'calendar', permission: 'leave:request' },
        { label: 'Approve requests', href: '/approvals', icon: 'check', permission: 'leave:approve' },
        { label: 'Team balances', href: '/leave/balances', icon: 'users-round', permission: 'leave:approve' },
        { label: 'Team attendance', href: '/attendance/team?status=on_leave', icon: 'users-round', permission: 'attendance:approve', feature: 'attendance_basic' },
        { label: 'Leave policy', href: '/settings/leave', icon: 'sliders', permission: 'leave:configure' },
      ])} />
      <div className="grid gap-6">
        {sent && (
          <Alert tone={sent.status === 'pending' ? 'info' : 'success'} title="Leave request sent">
            <span data-testid="leave-sent">
              {sent.status === 'pending'
                ? `Your ${sent.leaveTypeName.toLowerCase()} request (${sent.days} days from ${sent.startDate}) is waiting for approval${sent.waitingOn ? ` from ${sent.waitingOn}` : ''}. You will get a notification when it is decided.`
                : `Your ${sent.leaveTypeName.toLowerCase()} request is ${sent.status}.`}
            </span>
          </Alert>
        )}
        {balances.balances.length === 0 && (
          can(me, 'leave:configure') ? (
            <Alert tone="warning" title="No leave types are set up yet">
              Employees cannot apply for leave until the workspace has leave types. Add the standard ones (casual, sick, earned and leave without pay) now and change them later on Leave settings.
              <div className="mt-2"><AddDefaultLeaveTypes /></div>
            </Alert>
          ) : (
            <Alert tone="warning" title="No leave types apply to you yet">You cannot apply for leave until HR sets up leave types and policies. Ask HR to add them on Leave settings.</Alert>
          )
        )}
        <BalanceCards balances={balances.balances} />
        {yearView ? <LeaveYear data={calendar} year={year} today={today} /> : <LeaveCalendar data={calendar} month={month} today={today} canApply={canApply} />}
        <Card>
          <CardHeader title="My requests" description="A request waiting for approval can be changed or cancelled. Approved leave that has not started can be changed too: the change goes for approval and replaces it once approved." />
          <MyRequests requests={requests} balances={balances.balances} hasFields={Boolean(leaveFields?.some((f) => f.enabled))} />
        </Card>
        {away && <TeamAway rows={away} />}
      </div>
    </>
  );
}

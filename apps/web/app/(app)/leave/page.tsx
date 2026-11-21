import { Alert, Card, CardHeader, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ApiError, api, load, loadOptional } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { can } from '@/lib/nav';
import type { LeaveCalendarData, LeaveMine, LeaveRequest, Me } from '@/lib/types';
import { BalanceCards } from '../employees/[id]/tabs';
import { LeaveCalendar } from './leave-calendar';
import { LeaveYear } from './leave-year';
import { monthRange } from './month';
import { ApplyLeave, MyRequests, TeamAway } from './leave-view';
import { MyLeaveTypes } from './my-types';

export const metadata: Metadata = { title: 'Leave' };

export default async function LeavePage({ searchParams }: { searchParams: Promise<{ month?: string; sent?: string; view?: string; year?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  let mine: LeaveMine | null = null;
  try {
    mine = await api<LeaveMine>('/leave/mine');
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'no_employee_record')) return load<never>('/leave/mine');
  }
  if (!mine) {
    return (
      <>
        <PageHeader title="Leave" />
        <Alert tone="info" title="No employee record linked">Your login is not linked to an employee record yet, so there is no leave balance to show. Ask your HR Workspace to link it from your employee profile.</Alert>
        {can(me, 'leave:allocate') && <Alert tone="info" className="mt-4">Leave types, allocation and approvals are on <a className="underline" href="/leave/manage">Leave management</a>.</Alert>}
      </>
    );
  }
  const balances = { year: mine.year, balances: mine.types };
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
      <PageHeader title="Leave" description={`Your balances for ${balances.year}, your leave types and their rules, your leave calendar and applications.`} actions={can(me, 'leave:request') && <ApplyLeave balances={balances.balances} />} />
      <ModuleOverview module="leave" actions={allowed(me, [
        { label: 'Apply leave', href: '/leave?create=leave', icon: 'calendar', permission: 'leave:request' },
        { label: 'Approve requests', href: '/approvals', icon: 'check', permission: 'leave:approve' },
        { label: 'Team balances', href: '/leave/balances', icon: 'users-round', permission: 'leave:approve' },
        { label: 'Team attendance', href: '/attendance/team?status=on_leave', icon: 'users-round', permission: 'attendance:approve', feature: 'attendance_basic' },
        { label: 'Leave management', href: '/leave/manage', icon: 'sliders', permission: 'leave:allocate' },
        { label: 'Holidays and leave rules', href: '/settings/leave', icon: 'calendar', permission: 'leave:allocate' },
      ])} />
      <div className="grid gap-6">
        {sent && (
          <Alert tone={sent.status === 'pending' ? 'info' : 'success'} title="Leave request sent">
            <span data-testid="leave-sent">
              {sent.status === 'pending'
                ? `Your ${sent.leaveTypeName.toLowerCase()} request (${sent.days} days from ${sent.startDate}) (${sent.reference ?? ''}) went to ${sent.approvalRouteLabel ?? 'approval'} and is waiting${sent.waitingOn ? ` for ${sent.waitingOn}` : ''}. You will get a notification when it is decided.`
                : `Your ${sent.leaveTypeName.toLowerCase()} request is ${sent.status}.`}
            </span>
          </Alert>
        )}
        {balances.balances.length === 0 && (
          <Alert tone="warning" title="No leave types apply to you yet">
            You cannot apply for leave until the Super Workspace or your HR Workspace allocates leave types to you.
            {can(me, 'leave:allocate') && <> Allocate them on <a className="underline" href="/leave/manage?tab=allocation">Leave management</a>.</>}
          </Alert>
        )}
        <BalanceCards balances={balances.balances} />
        <MyLeaveTypes types={mine.types} />
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

import { ModuleNotices } from '@/components/module-notices';
import { Alert, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ApiError, api, load, loadOptional } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { inMyDay } from '@/lib/my-day';
import { can } from '@/lib/nav';
import { todayIn } from '@/lib/time';
import type { LeaveCalendarData, LeaveMine, LeaveRequest, Me } from '@/lib/types';
import { BalanceCards } from '../employees/[id]/tabs';
import { LeaveCalendar } from './leave-calendar';
import { LeaveYear } from './leave-year';
import { monthRange } from './month';
import { ApplyLeave, MyRequestsCard, TeamAway } from './leave-view';
import type { CompOff } from './actions';
import { CompOffCard } from './comp-off';
import { MyLeaveTypes } from './my-types';

export const metadata: Metadata = { title: 'Leave' };

export default async function LeavePage({ searchParams }: { searchParams: Promise<{ month?: string; sent?: string; view?: string; year?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  // My Day: the person's own leave only, without the HR shortcuts.
  const admin = can(me, 'leave:allocate') && !(await inMyDay(me));
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
        {admin && <Alert tone="info" className="mt-4">Leave types, quantities and approvals are on <a className="underline" href="/leave/manage">Leave management</a>.</Alert>}
      </>
    );
  }
  const balances = { year: mine.year, balances: mine.types };
  const scope = me.permissions['leave:read'];
  const today = todayIn(me.tenant.timezone);
  const month = sp.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : today.slice(0, 7);
  // The year view shows all twelve months; the month view one month with room to apply from a day.
  const yearView = sp.view === 'year';
  const year = sp.year && /^\d{4}$/.test(sp.year) ? Number(sp.year) : Number(today.slice(0, 4));
  const { from, to } = yearView ? { from: `${year}-01-01`, to: `${year}-12-31` } : monthRange(month);
  const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const [requests, away, calendar, leaveFields, compOffs] = await Promise.all([
    load<LeaveRequest[]>('/leave/requests?scope=mine&limit=100'),
    scope && scope !== 'own' ? load<LeaveRequest[]>(`/leave/away?from=${today}&to=${in30}`) : Promise.resolve(null),
    load<LeaveCalendarData>(`/leave/calendar?from=${from}&to=${to}`),
    loadOptional<{ id: string; enabled: boolean }[]>('/custom-fields?entity=leave_request'),
    loadOptional<CompOff[]>('/leave/comp-off?scope=mine'),
  ]);
  const sent = sp.sent ? requests.find((r) => r.id === sp.sent) : undefined;
  const canApply = can(me, 'leave:request') && balances.balances.length > 0;
  return (
    <>
      <PageHeader title="Leave" description={`Your balances for ${balances.year}, your leave types and their rules, your leave calendar and applications.`} actions={can(me, 'leave:request') && <ApplyLeave balances={balances.balances} />} />
      <ModuleOverview module="leave" actions={allowed(me, [
        { label: 'Apply leave', href: '/leave/apply', icon: 'calendar', permission: 'leave:request' },
        { label: 'Approve requests', href: '/approvals', icon: 'check', permission: 'leave:approve' },
        { label: 'Team balances', href: '/leave/balances', icon: 'users-round', permission: 'leave:approve' },
        { label: 'Team attendance', href: '/attendance/team?status=on_leave', icon: 'users-round', permission: 'attendance:approve', feature: 'attendance_basic' },
        { label: 'Leave management', href: '/leave/manage', icon: 'sliders', permission: 'leave:allocate' },
        { label: 'Holidays and leave rules', href: '/settings/leave', icon: 'calendar', permission: 'leave:allocate' },
      ])} />
      <ModuleNotices category="leave" label="Leave" />
      <div className="grid gap-6">
        {sent && (
          <Alert tone={sent.status === 'pending' ? 'info' : 'success'} title="Leave request sent">
            <span data-testid="leave-sent">
              {sent.status === 'pending'
                ? `Your ${sent.leaveTypeName} request ${sent.reference ?? ''} (${sent.days} days from ${sent.startDate}) went to ${sent.approvalRouteLabel ?? 'approval'} and is waiting for approval${sent.waitingOn ? ` from ${sent.waitingOn}` : ''}. You will get a notification when it is decided.`
                : `Your ${sent.leaveTypeName.toLowerCase()} request is ${sent.status}.`}
            </span>
          </Alert>
        )}
        {balances.balances.length === 0 && (
          <Alert tone="warning" title="No leave types apply to you yet">
            No leave type is visible to you yet. One appears here as soon as the Super Workspace or your HR Workspace creates it for your workspace.
            {admin && <> Create one on <a className="underline" href="/leave/manage?tab=types">Leave management</a>.</>}
          </Alert>
        )}
        {/* Issue #91 point 2: the count cards, then My requests (collapsible), then the calendar, then My leave types last. */}
        <BalanceCards balances={balances.balances} />
        <MyRequestsCard requests={requests} balances={balances.balances} hasFields={Boolean(leaveFields?.some((f) => f.enabled))} />
        {yearView ? <LeaveYear data={calendar} year={year} today={today} /> : <LeaveCalendar data={calendar} month={month} today={today} canApply={canApply} />}
        {compOffs && (compOffs.length > 0 || mine.types.some((t) => t.kind === 'comp_off')) && <CompOffCard rows={compOffs} />}
        {away && <TeamAway rows={away} />}
        <MyLeaveTypes types={mine.types} />
      </div>
    </>
  );
}

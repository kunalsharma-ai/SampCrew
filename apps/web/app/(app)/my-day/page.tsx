import type { EmployeeHome } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import { ArrowRight, Check, Inbox, ListChecks, RotateCcw, X } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { EmployeeHomeView } from '@/components/home/employee-home';
import { RecentNotifications } from '@/components/notifications-widget';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { AttendanceToday, LeaveBalance, Me, MyCalendar, MyRewards } from '@/lib/types';
import { RequestCard } from '../requests/request-card';
import type { MyDayRequests } from '../requests/types';

export const metadata: Metadata = { title: 'My Day' };

const DECISION = { approved: { label: 'Approved', icon: Check, cls: 'bg-success text-white' }, rejected: { label: 'Rejected', icon: X, cls: 'bg-danger text-white' }, changes_requested: { label: 'Asked for changes', icon: RotateCcw, cls: 'bg-info text-white' } } as const;

/**
 * My Day: the person's own workspace, whatever level they hold. Their attendance (check in and out, breaks, work
 * location), leave balances, their requests and leave applications, the approvals they made, and their own
 * notifications. No organization data: every number here is theirs.
 */
export default async function MyDayPage() {
  const me = await load<Me>('/me');
  const has = (f: string) => me.features.includes(f);
  const renderedAt = Date.now();
  const year = new Date(renderedAt + 330 * 60_000).toISOString().slice(0, 4);
  const [home, today, balances, rewards, requests] = await Promise.all([
    me.employee ? loadOptional<EmployeeHome>('/home/employee') : null,
    me.employee && has('attendance_basic') && can(me, 'attendance:punch') ? loadOptional<AttendanceToday>('/attendance/today') : null,
    me.employee && has('leave') && can(me, 'leave:read') ? loadOptional<{ balances: LeaveBalance[] }>(`/leave/balances?year=${year}`).then((b) => b?.balances ?? null) : null,
    me.employee && has('attendance_basic') ? loadOptional<MyRewards>('/workspace/rewards?history=0') : null,
    loadOptional<MyDayRequests>('/requests/my-day'),
  ]);
  const calendar = home ? await loadOptional<MyCalendar>(`/workspace/calendar?month=${home.month}`) : null;
  return (
    <div data-testid="my-day-page" data-level="employee">
      <PageHeader title={`My Day, ${me.user.fullName.split(' ')[0]}`} eyebrow="Employee Workspace · My Day" description="Your own attendance, leave, requests, approvals and notifications. Nothing about anyone else's work." />
      <div className="grid gap-5">
        {me.employee && <EmployeeHomeView home={home} today={today} balances={balances} rewards={rewards} calendar={calendar} renderedAt={renderedAt} />}
        {requests && (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <section aria-labelledby="my-requests" className="rounded-2xl border border-border bg-surface p-5 shadow-card" data-testid="my-day-requests">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 id="my-requests" className="flex items-center gap-2 text-[0.9375rem] font-semibold"><ListChecks className="size-4 text-accent" /> My requests and leave applications</h2>
                <Link href="/requests/mine" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">All my requests <ArrowRight className="size-3.5" /></Link>
              </div>
              <div className="mb-4 grid grid-cols-3 gap-2 text-center">
                {[['Pending', requests.counts.pending], ['Changes asked', requests.counts.changesRequested], ['Approved', requests.counts.approved]].map(([l, n]) => (
                  <div key={l} className="rounded-xl bg-bg-subtle px-3 py-2"><div className="text-xl font-semibold tabular">{n}</div><div className="text-[0.6875rem] text-fg-muted">{l}</div></div>
                ))}
              </div>
              {requests.recent.length ? <ul className="grid gap-3">{requests.recent.map((r) => <RequestCard key={r.id} r={r} />)}</ul> : <p className="text-[0.8125rem] text-fg-muted">No requests yet. <Link href="/requests/new" className="font-medium text-accent hover:underline">Create one</Link> or <Link href="/leave/apply" className="font-medium text-accent hover:underline">apply for leave</Link>.</p>}
            </section>
            <div className="grid content-start gap-5">
              <section aria-labelledby="my-decisions" className="rounded-2xl border border-border bg-surface p-5 shadow-card" data-testid="my-day-decisions">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 id="my-decisions" className="flex items-center gap-2 text-[0.9375rem] font-semibold"><Inbox className="size-4 text-accent" /> My approval history</h2>
                  <Link href="/requests/approvals" className="text-xs font-medium text-accent hover:underline">My Approvals</Link>
                </div>
                {requests.decisions.length ? (
                  <ul className="grid gap-3">
                    {requests.decisions.map((d) => {
                      const v = DECISION[d.action as keyof typeof DECISION] ?? DECISION.approved;
                      const Icon = v.icon;
                      return (
                        <li key={d.id} className="flex gap-3">
                          <span className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full ${v.cls}`}><Icon className="size-3.5" /></span>
                          <div className="min-w-0 text-[0.8125rem]">
                            <Link href={`/requests/${d.requestId}`} className="font-semibold text-fg hover:underline">{v.label}: {d.title}</Link>
                            <div className="text-[0.6875rem] text-fg-muted"><span className="font-mono">{d.ref}</span> · {new Date(d.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="text-[0.8125rem] text-fg-muted">You have not decided any request yet.</p>}
              </section>
              <RecentNotifications limit={5} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

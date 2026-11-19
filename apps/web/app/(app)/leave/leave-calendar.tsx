'use client';
import { Card, CardHeader, buttonClass, cn } from '@crew/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LeaveCalendarData, LeaveRequest } from '@/lib/types';
import { iso, monthRange } from './month';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const half = (r: LeaveRequest, date: string) =>
  (date === r.startDate && r.startHalf === 'second_half') || (date === r.endDate && r.endHalf === 'first_half') ? ' (half day)' : '';

/**
 * The employee's own month: working days, weekly offs, public holidays and their pending and approved leave.
 * Choosing a free working day starts a leave request for that date.
 */
export function LeaveCalendar({ data, month, today, canApply }: { data: LeaveCalendarData; month: string; today: string; canApply: boolean }) {
  const router = useRouter();
  const { y, m, last, prev, next } = monthRange(month);
  const holidays = new Map(data.holidays.map((h) => [h.date, h]));
  const leaveOn = (date: string) => data.requests.filter((r) => r.startDate <= date && r.endDate >= date);
  // Monday-first grid: blanks before the 1st.
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lead = (firstDow + 6) % 7;
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: last }, (_, i) => iso(y, m, i + 1))];
  while (cells.length % 7) cells.push(null);
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const monthLeave = data.requests.reduce((a, r) => a + (r.status === 'approved' ? 1 : 0), 0);

  return (
    <Card data-testid="leave-calendar">
      <CardHeader
        title="My leave calendar"
        className="flex-wrap"
        description={canApply ? 'Your leave, weekly offs and public holidays. Choose a working day to apply for leave from that date.' : 'Your leave, weekly offs and public holidays.'}
        action={
          <div className="flex items-center gap-1">
            <Link aria-label="Previous month" className={buttonClass('ghost', 'sm')} href={`/leave?month=${prev}`} scroll={false}><ChevronLeft className="size-4" /></Link>
            <span className="min-w-32 text-center text-sm font-semibold" data-testid="leave-calendar-month">{title}</span>
            <Link aria-label="Next month" className={buttonClass('ghost', 'sm')} href={`/leave?month=${next}`} scroll={false}><ChevronRight className="size-4" /></Link>
            {month !== today.slice(0, 7) && <Link className={buttonClass('secondary', 'sm')} href="/leave" scroll={false}>Today</Link>}
            <Link className={buttonClass('secondary', 'sm')} href={`/leave?view=year&year=${y}`} scroll={false} data-testid="leave-year-link">Year view</Link>
          </div>
        }
      />
      <div className="px-3 pb-4 sm:px-5">
        <div role="group" aria-label={`Leave calendar, ${title}`} className="grid grid-cols-7 gap-1 text-[0.75rem]">
          {WEEKDAYS.map((d) => <div key={d} aria-hidden className="px-1 pb-1 text-center font-medium text-fg-subtle">{d}</div>)}
          {cells.map((date, i) => {
            if (!date) return <div key={`b${i}`} aria-hidden className="min-h-16 rounded-md" />;
            const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
            const off = data.weeklyOffs.includes(dow);
            const hol = holidays.get(date);
            const leave = leaveOn(date);
            const free = canApply && !off && !(hol && !hol.optional) && !leave.length;
            // Screen readers hear the whole day; the cell shows the short form.
            const spoken = [
              new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }),
              off ? 'weekly off' : null,
              hol ? `${hol.name}${hol.optional ? ' (optional holiday)' : ' (public holiday)'}` : null,
              ...leave.map((r) => `${r.leaveTypeName} ${r.status}${half(r, date)}`),
            ].filter(Boolean).join(', ');
            const body = (
              <>
                <span aria-hidden className={cn('inline-flex size-6 items-center justify-center rounded-full tabular-nums', date === today && 'bg-accent font-semibold text-accent-fg')}>{Number(date.slice(8))}</span>
                {hol && <span aria-hidden className={cn('mt-0.5 block truncate text-[0.6875rem]', hol.optional ? 'text-fg-muted' : 'font-medium text-fg')}>{hol.name}</span>}
                {leave.map((r) => (
                  <span
                    key={r.id}
                    aria-hidden
                    className={cn('mt-0.5 block truncate rounded border-l-4 px-1 text-[0.6875rem] font-medium text-fg', r.status === 'pending' ? 'border border-dashed' : '')}
                    style={r.status === 'pending' ? { borderColor: r.color } : { borderColor: r.color, background: `${r.color}26` }}
                  >
                    {r.leaveTypeCode}{r.status === 'pending' ? ' · pending' : ''}{half(r, date) ? ' · ½' : ''}
                  </span>
                ))}
                <span className="sr-only" data-day-text>{spoken}{free ? '. Apply for leave from this day' : ''}</span>
              </>
            );
            const cls = cn('min-h-16 rounded-md border p-1 text-left align-top', off || (hol && !hol.optional) ? 'border-transparent bg-bg-subtle text-fg-muted' : 'border-border bg-surface', free && 'hover:border-accent hover:bg-accent/5');
            return free ? (
              <button key={date} type="button" data-date={date} className={cls}
                onClick={() => router.push(`/leave?month=${month}&create=leave&date=${date}`, { scroll: false })}>
                {body}
              </button>
            ) : (
              <div key={date} data-date={date} className={cls}>{body}</div>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem] text-fg-muted">
          <span className="flex items-center gap-1"><span className="size-3 rounded border-l-4 border-accent bg-accent/15" /> Approved leave</span>
          <span className="flex items-center gap-1"><span className="size-3 rounded border border-dashed border-accent" /> Waiting for approval</span>
          <span className="flex items-center gap-1"><span className="size-3 rounded bg-bg-subtle ring-1 ring-border" /> Weekly off or public holiday</span>
          <span className="ml-auto tabular-nums">{data.holidays.length} holiday{data.holidays.length === 1 ? '' : 's'} · {monthLeave} approved leave request{monthLeave === 1 ? '' : 's'} this month</span>
        </div>
      </div>
    </Card>
  );
}

import { Card, CardHeader, buttonClass, cn } from '@crew/ui';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { LeaveCalendarData } from '@/lib/types';
import { iso, monthRange, pad } from './month';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * The employee's whole year at a glance: twelve small months with weekly offs, public and optional holidays, and
 * pending and approved leave coloured by type. A month's name opens that month.
 */
export function LeaveYear({ data, year, today }: { data: LeaveCalendarData; year: number; today: string }) {
  const holidays = new Map(data.holidays.map((h) => [h.date, h]));
  const leaveOn = (date: string) => data.requests.filter((r) => r.startDate <= date && r.endDate >= date);
  const approved = data.requests.filter((r) => r.status === 'approved');
  const days = (rs: typeof data.requests) => rs.reduce((t, r) => t + Number(r.days), 0);
  // Leave taken per type this year, for the summary under the grid.
  const byType = new Map<string, { name: string; color: string; days: number }>();
  for (const r of approved) {
    const cur = byType.get(r.leaveTypeId) ?? { name: r.leaveTypeName, color: r.color, days: 0 };
    cur.days += Number(r.days);
    byType.set(r.leaveTypeId, cur);
  }

  return (
    <Card data-testid="leave-year">
      <CardHeader
        title={`My leave in ${year}`}
        className="flex-wrap"
        description="Every month of the year. Choose a month to see it in full and apply from a day."
        action={
          <div className="flex items-center gap-1">
            <Link aria-label="Previous year" className={buttonClass('ghost', 'sm')} href={`/leave?view=year&year=${year - 1}`} scroll={false}><ChevronLeft className="size-4" /></Link>
            <span className="min-w-16 text-center text-sm font-semibold tabular-nums" data-testid="leave-year-title">{year}</span>
            <Link aria-label="Next year" className={buttonClass('ghost', 'sm')} href={`/leave?view=year&year=${year + 1}`} scroll={false}><ChevronRight className="size-4" /></Link>
            <Link className={buttonClass('secondary', 'sm')} href={`/leave?month=${year === Number(today.slice(0, 4)) ? today.slice(0, 7) : `${year}-01`}`} scroll={false}>Month view</Link>
          </div>
        }
      />
      <div className="grid gap-5 px-3 pb-4 sm:grid-cols-2 sm:px-5 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 12 }, (_, i) => {
          const month = `${year}-${pad(i + 1)}`;
          const { y, m, last } = monthRange(month);
          const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
          const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: last }, (_, d) => iso(y, m, d + 1))];
          const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
          const inMonth = data.requests.filter((r) => r.endDate >= `${month}-01` && r.startDate <= `${month}-${pad(last)}`);
          return (
            <section key={month} aria-label={`${name} ${year}`} data-month={month}>
              <div className="mb-1 flex items-baseline justify-between">
                <Link href={`/leave?month=${month}`} className="text-[0.8125rem] font-semibold hover:text-accent hover:underline" scroll={false}>{name}</Link>
                {inMonth.length > 0 && <span className="text-[0.6875rem] text-fg-muted">{inMonth.length} request{inMonth.length === 1 ? '' : 's'}</span>}
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center text-[0.625rem]">
                {WEEKDAYS.map((d, k) => <span key={k} aria-hidden className="text-fg-subtle">{d}</span>)}
                {cells.map((date, k) => {
                  if (!date) return <span key={`b${k}`} aria-hidden />;
                  const off = data.weeklyOffs.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
                  const hol = holidays.get(date);
                  const leave = leaveOn(date);
                  const top = leave[0];
                  const label = [date, off ? 'weekly off' : null, hol ? `${hol.name}${hol.optional ? ' (optional)' : ''}` : null, ...leave.map((r) => `${r.leaveTypeName} ${r.status}`)].filter(Boolean).join(', ');
                  return (
                    <span
                      key={date}
                      title={label}
                      data-date={date}
                      data-leave={top ? top.leaveTypeCode : undefined}
                      className={cn(
                        'flex aspect-square items-center justify-center rounded tabular-nums',
                        off || (hol && !hol.optional) ? 'bg-bg-subtle text-fg-subtle' : 'text-fg',
                        hol && hol.optional && 'ring-1 ring-inset ring-warning/60',
                        top && 'font-semibold',
                        top?.status === 'pending' && 'border border-dashed',
                        date === today && 'outline outline-2 outline-accent',
                      )}
                      style={top ? (top.status === 'pending' ? { borderColor: top.color } : { background: `${top.color}33` }) : undefined}
                    >
                      <span aria-hidden>{Number(date.slice(8))}</span>
                      <span className="sr-only">{label}</span>
                    </span>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-5 py-3 text-[0.6875rem] text-fg-muted">
        {[...byType.values()].map((t) => (
          <span key={t.name} className="flex items-center gap-1"><span className="size-3 rounded" style={{ background: `${t.color}55` }} /> {t.name}: {t.days} day{t.days === 1 ? '' : 's'}</span>
        ))}
        <span className="flex items-center gap-1"><span className="size-3 rounded border border-dashed border-fg-muted" /> Waiting for approval</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded ring-1 ring-inset ring-warning/60" /> Optional holiday</span>
        <span className="ml-auto tabular-nums" data-testid="leave-year-summary">{days(approved)} approved day{days(approved) === 1 ? '' : 's'} · {data.holidays.filter((h) => !h.optional).length} public holidays</span>
      </div>
    </Card>
  );
}

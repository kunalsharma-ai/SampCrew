'use client';
import { unverifiedReason, type EmployeeHome, type HomeCalendarDay } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, cn, type Tone } from '@crew/ui';
import {
  AlarmClock, CalendarCheck2, CalendarDays, CalendarOff, ChevronLeft, ChevronRight, CircleDot, Clock3, Coffee, GraduationCap, Home as HomeIcon, LogIn, LogOut,
  Medal, Megaphone, PartyPopper, Plane, Star, TimerReset, TriangleAlert, Trophy, UserCheck, UserX,
} from 'lucide-react';
import Link from 'next/link';
import { ExportDialogButton } from '@/app/(app)/attendance/export-dialog';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { punchAction } from '@/app/(app)/attendance/actions';
import { punchLocation } from '@/lib/locate';
import { hm } from '@/lib/time';
import { serverNow, syncServerClock, useServerNow } from '@/lib/server-clock';
import type { AttendanceToday, LeaveBalance, MyCalendar, MyRewards } from '@/lib/types';
import { ActionCenter, Empty, Progress, relative, SectionError, shortDate, StatCard } from './ui';

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };
/** The punch note that marks a check-out as the start of a break (the next check-in ends it). */
export const BREAK_NOTE = 'Break';

/** Worked and break minutes from today's punches, counting an open check-in (or break) up to now. */
export function tally(punches: AttendanceToday['punches'], now: number) {
  let worked = 0;
  let breaks = 0;
  let inAt: number | null = null;
  let outAt: number | null = null;
  for (const p of punches) {
    const at = Date.parse(p.at);
    if (p.direction === 'in') {
      if (outAt !== null) breaks += at - outAt;
      inAt = at;
      outAt = null;
    } else if (inAt !== null) {
      worked += at - inAt;
      inAt = null;
      outAt = at;
    }
  }
  const open = inAt !== null;
  if (inAt !== null) worked += now - inAt;
  const last = punches.at(-1);
  const onBreak = !open && last?.direction === 'out' && last.note === BREAK_NOTE;
  if (onBreak && outAt !== null) breaks += now - outAt;
  const lastOut = [...punches].reverse().find((p) => p.direction === 'out' && p.note !== BREAK_NOTE)?.at ?? null;
  return { worked: Math.max(0, Math.round(worked / 60000)), breaks: Math.round(breaks / 60000), open, onBreak, firstIn: punches.find((p) => p.direction === 'in')?.at ?? null, lastOut: open || onBreak ? null : lastOut };
}

type Phase = 'not_in' | 'working' | 'on_break' | 'done';

/** Today's attendance: status, times, progress and the one button the person needs now. */
export function AttendanceHero({ today, renderedAt }: { today: AttendanceToday; renderedAt: number }) {
  const router = useRouter();
  // A fresh server reading with today's attendance sets the page clock before it starts ticking.
  useEffect(() => { if (today.serverTime) syncServerClock(today.serverTime); }, [today.serverTime]);
  const now = useServerNow(today.serverTime ?? renderedAt, 1000);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  const tz = today.timeZone;
  const t = tally(today.punches, now);
  const expected = today.shift ? ((toMin(today.shift.end) - toMin(today.shift.start) + 1440) % 1440 || 1440) : 480;
  const remaining = Math.max(0, expected - t.worked);
  const pct = Math.min(100, Math.round((t.worked / expected) * 100));
  const clock = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso)) : '—');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  const phase: Phase = t.open ? 'working' : t.onBreak ? 'on_break' : today.punches.length ? 'done' : 'not_in';
  const off = today.dayType !== 'working';
  const day = today.day;
  const late = (day?.lateMinutes ?? 0) > 0;
  const early = (day?.earlyLeaveMinutes ?? 0) > 0 && phase === 'done';
  const missing = day?.status === 'missing_punch';
  const canPunch = today.allowed.web && !today.locked;

  const punch = (direction: 'in' | 'out', note?: string, done?: string) => start(async () => {
    setNotice(null);
    const { where, refused } = await punchLocation(today);
    const fix = where;
    if (refused) {
      setNotice({ tone: 'danger', text: refused });
      return;
    }
    const r = await punchAction({ ...where, direction, ...(note ? { note } : {}) });
    if (!r.ok) setNotice({ tone: 'danger', text: r.message });
    else {
      const pz = r.data!.punch;
      const outside = pz.geofence === 'outside' && !pz.workZone;
      const where = pz.workZone === 'office' ? ` at ${pz.place ?? 'the office'}` : pz.workZone === 'remote' ? ', away from the office' : '';
      const unverified = pz.workZone === 'unverified';
      setNotice({ tone: outside || unverified ? 'warning' : 'success', text: `${done ?? (direction === 'in' ? 'Checked in' : 'Checked out')}${where} at ${clock(new Date(serverNow()).toISOString())}.${outside ? ' You appear to be away from your workplace; this is recorded.' : ''}${unverified ? ` ${unverifiedReason(fix.locationStatus === 'ok' ? 'poor_accuracy' : fix.locationStatus === 'denied' ? 'denied' : fix.locationStatus ? 'unavailable' : 'no_location', { accuracyM: fix.accuracyM ?? null, maxAccuracyM: today.workMode?.maxAccuracyM ?? null })} Until then today waits for verification.` : ''}` });
      window.dispatchEvent(new Event('crew:punched')); // the top bar's check-in button follows
      router.refresh();
    }
  });

  const STATUS: Record<Phase, { label: string; tone: string; icon: typeof LogIn }> = {
    not_in: { label: off ? (today.holidayName ?? 'Weekly off') : 'Not checked in', tone: off ? 'text-info' : 'text-warning', icon: off ? CalendarOff : AlarmClock },
    working: { label: 'Working', tone: 'text-success', icon: CircleDot },
    on_break: { label: 'On a break', tone: 'text-ember', icon: Coffee },
    done: { label: 'Checked out', tone: 'text-fg-muted', icon: LogOut },
  };
  const st = STATUS[phase];
  const Icon = st.icon;
  return (
    <Card className="overflow-hidden" data-testid="attendance-hero">
      <div className="grid grid-cols-1 gap-5 bg-gradient-to-br from-accent/15 via-transparent to-transparent p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="grid grid-cols-1 gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Today&apos;s attendance</div>
          <div className="flex flex-wrap items-center gap-3">
            <span className={cn('inline-flex items-center gap-2 text-2xl font-bold tracking-tight', st.tone)} data-testid="attendance-phase" data-phase={phase}>
              <span className="relative grid size-9 place-items-center rounded-full bg-surface shadow-sm">
                {phase === 'working' && <span className="absolute inset-0 animate-ping rounded-full bg-success/30 motion-reduce:hidden" aria-hidden />}
                <Icon className="size-5" aria-hidden />
              </span>
              {st.label}
            </span>
            <span className="text-3xl font-bold tabular tracking-tight text-fg" aria-label={`Time now ${time.slice(0, 5)}`}>{time}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {today.shift ? <span>{today.shift.name}: {today.shift.start} to {today.shift.end}</span> : <span>No shift set, 8 hours expected</span>}
            {late && <Badge tone="warning" dot>Late by {hm(day!.lateMinutes)}</Badge>}
            {early && <Badge tone="warning" dot>Left {hm(day!.earlyLeaveMinutes)} early</Badge>}
            {missing && <Badge tone="danger" dot>Missing punch</Badge>}
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row lg:flex-col lg:items-end">
          {canPunch ? (
            <div className="flex flex-wrap gap-2 lg:justify-end">
              {phase === 'not_in' && <Button size="lg" loading={pending} onClick={() => punch('in')} data-testid="check-in" data-feature="attendance_basic.web_punch"><LogIn className="size-5" />Check in</Button>}
              {phase === 'working' && (
                <>
                  <Button size="lg" variant="secondary" loading={pending} onClick={() => punch('out', BREAK_NOTE, 'Break started')} data-testid="start-break" data-feature="attendance_basic.web_punch"><Coffee className="size-5" />Start break</Button>
                  <Button size="lg" loading={pending} onClick={() => punch('out')} data-testid="check-out" data-feature="attendance_basic.web_punch"><LogOut className="size-5" />Check out</Button>
                </>
              )}
              {phase === 'on_break' && <Button size="lg" loading={pending} onClick={() => punch('in', 'Back from break', 'Break ended')} data-testid="end-break" data-feature="attendance_basic.web_punch"><TimerReset className="size-5" />End break</Button>}
              {phase === 'done' && <Button size="lg" variant="secondary" loading={pending} onClick={() => punch('in')} data-testid="check-in" data-feature="attendance_basic.web_punch"><LogIn className="size-5" />Check in again</Button>}
            </div>
          ) : <span className="text-sm text-fg-muted">{today.locked ? 'This day is locked by HR.' : 'Web check-in is off; use the mobile app or the site kiosk.'}</span>}
          <Link className="text-right text-xs font-medium text-accent hover:underline" href="/attendance">Attendance details</Link>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 border-t border-border px-5 py-4">
        <div className="flex items-center justify-between text-xs text-fg-subtle"><span>Working hours</span><span className="font-semibold tabular text-fg" data-testid="hours-percent">{pct}%</span></div>
        <Progress value={pct} label="Today's working hours" barClass={pct >= 100 ? 'bg-success' : undefined} />
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {[
            ['Check in', clock(t.firstIn), LogIn, 'first-in'],
            ['Check out', clock(t.lastOut), LogOut, 'last-out'],
            ['Working time', hm(t.worked) === '—' ? '0m' : hm(t.worked), Clock3, 'worked-today'],
            ['Break', hm(t.breaks) === '—' ? '0m' : hm(t.breaks), Coffee, 'break-today'],
            ['Expected', hm(expected), CalendarCheck2, 'expected'],
            ['Remaining', off ? '—' : remaining ? hm(remaining) : 'Done', TimerReset, 'remaining'],
          ].map(([label, value, I, id]) => {
            const C = I as typeof LogIn;
            return (
              <div key={label as string}>
                <dt className="flex items-center gap-1.5 text-xs text-fg-subtle"><C className="size-3.5" aria-hidden />{label as string}</dt>
                <dd className="font-semibold tabular" data-testid={id as string}>{value as string}</dd>
              </div>
            );
          })}
        </dl>
        {notice && <Alert tone={notice.tone as 'success'}>{notice.text}</Alert>}
      </div>
    </Card>
  );
}

const DAY_TONE: Record<string, { label: string; cls: string; dot: string }> = {
  present: { label: 'Present', cls: 'bg-success/12 text-success', dot: 'bg-success' },
  late: { label: 'Late', cls: 'bg-warning/15 text-warning', dot: 'bg-warning' },
  absent: { label: 'Absent', cls: 'bg-danger/12 text-danger', dot: 'bg-danger' },
  on_leave: { label: 'Leave', cls: 'bg-info/12 text-info', dot: 'bg-info' },
  holiday: { label: 'Holiday', cls: 'bg-ember/12 text-ember', dot: 'bg-ember' },
  missing_punch: { label: 'Missing punch', cls: 'bg-danger/10 text-danger ring-1 ring-inset ring-danger/40', dot: 'bg-danger' },
  half_day: { label: 'Half day', cls: 'bg-warning/10 text-warning', dot: 'bg-warning/60' },
  wfh: { label: 'WFH', cls: 'bg-accent/12 text-accent', dot: 'bg-accent' },
  weekly_off: { label: 'Weekly off', cls: 'text-fg-subtle', dot: 'bg-border-strong' },
  working: { label: 'Working', cls: 'bg-success/8 text-success', dot: 'bg-success/60' },
};
/** The calendar's reading of a day: WFH and late win over plain present, as in the legend. */
export function dayKey(d: HomeCalendarDay): string | null {
  if (d.dayType === 'holiday') return 'holiday';
  if (d.status === 'on_leave' || (d.leaveName && !d.status)) return 'on_leave';
  if (!d.status) return d.dayType === 'weekly_off' ? 'weekly_off' : null;
  if (d.remote) return 'wfh';
  if (d.status === 'in_progress') return d.firstIn ? (d.lateMinutes > 0 ? 'late' : 'working') : null;
  if (d.status === 'present' && d.lateMinutes > 0) return 'late';
  if (d.status === 'half_day_leave') return 'half_day';
  if (d.status === 'not_joined') return null;
  return d.status;
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Month calendar of the person's own attendance; a day opens its detail. */
export function AttendanceCalendar({ home, events }: { home: EmployeeHome; events?: MyCalendar | null }) {
  const eventsOn = new Map((events?.month === home.month ? events.days : []).map((d) => [d.date, d.events]));
  const a = home.attendance!;
  const [selected, setSelected] = useState(home.today.startsWith(home.month) ? home.today : a.days[0]!.date);
  const [filter, setFilter] = useState<string | null>(null);
  const first = new Date(`${a.days[0]!.date}T00:00:00Z`).getUTCDay();
  const lead = (first + 6) % 7;
  const pick = a.days.find((d) => d.date === selected);
  const title = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${home.month}-01T00:00:00Z`));
  const shift = (n: number) => { const [y, m] = home.month.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
  const clock = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: home.timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso)) : '—');
  const used = useMemo(() => new Set(a.days.map(dayKey).filter(Boolean) as string[]), [a.days]);
  const isThisMonth = home.today.startsWith(home.month);
  return (
    <Card data-testid="attendance-calendar">
      <CardHeader
        title="Attendance calendar"
        description="Each day as it was counted, with holidays, leave and deadlines. Pick a day for its times."
        action={
          <div className="flex items-center gap-1">
            <Link aria-label="Previous month" className="rounded p-1 hover:bg-bg-subtle" href={`/?view=me&month=${shift(-1)}`} scroll={false}><ChevronLeft className="size-4" /></Link>
            <span className="min-w-28 text-center text-sm font-medium" data-testid="calendar-month">{title}</span>
            <Link aria-label="Next month" className={cn('rounded p-1 hover:bg-bg-subtle', isThisMonth && 'pointer-events-none opacity-30')} aria-disabled={isThisMonth} href={`/?view=me&month=${shift(1)}`} scroll={false}><ChevronRight className="size-4" /></Link>
            {!isThisMonth && <Link className="ml-1 rounded-md border border-border px-2 py-0.5 text-xs font-medium hover:bg-bg-subtle" href="/?view=me" scroll={false}>Today</Link>}
            {home.exportEmployeeId && (
              <span className="ml-2"><ExportDialogButton period={{ from: a.days[0]!.date, to: a.days[a.days.length - 1]!.date, today: home.today, label: title }} filters={{ employeeId: home.exportEmployeeId }} own label="Download report" /></span>
            )}
          </div>
        }
      />
      <div className="grid grid-cols-1 gap-3 px-5 pb-5">
        <div className="grid grid-cols-7 gap-1 text-center text-[0.6875rem] font-medium text-fg-subtle" aria-hidden>{DOW.map((d) => <div key={d}>{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1" role="group" aria-label={title}>
          {Array.from({ length: lead }, (_, i) => <div key={`l${i}`} />)}
          {a.days.map((d) => {
            const k = dayKey(d);
            const tone = k ? DAY_TONE[k] : null;
            const dim = filter && k !== filter;
            const n = Number(d.date.slice(8));
            return (
              <button
                key={d.date}
                type="button"
                aria-pressed={selected === d.date}
                aria-label={`${n} ${title}${tone ? `, ${tone.label}` : ''}${d.holidayName ? `, ${d.holidayName}` : ''}`}
                title={tone ? `${shortDate(d.date)}: ${tone.label}${d.workedMinutes ? `, ${hm(d.workedMinutes)} worked` : ''}` : shortDate(d.date)}
                onClick={() => setSelected(d.date)}
                data-testid={`cal-${d.date}`}
                data-status={k ?? ''}
                className={cn(
                  'relative flex aspect-square flex-col items-center justify-center rounded-lg text-sm tabular transition-[opacity,transform] duration-150 hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100',
                  selected === d.date ? 'bg-accent text-accent-fg shadow' : cn(tone?.cls ?? 'hover:bg-bg-subtle'),
                  d.date === home.today && selected !== d.date && 'ring-2 ring-accent',
                  dim && 'opacity-25',
                )}
              >
                {n}
                {d.correctionPending && <span className="absolute right-1 top-1 size-1.5 rounded-full bg-info" aria-hidden />}
                {(eventsOn.get(d.date)?.length ?? 0) > 0 && <span className="absolute bottom-1 size-1 rounded-full bg-current opacity-70" aria-hidden />}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1.5 text-[0.6875rem]" aria-label="Legend: pick one to highlight those days">
          {Object.entries(DAY_TONE).filter(([k]) => used.has(k) || ['present', 'absent', 'on_leave', 'holiday'].includes(k)).map(([k, v]) => (
            <button key={k} type="button" onClick={() => setFilter((f) => (f === k ? null : k))} aria-pressed={filter === k}
              className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-fg-muted transition-colors', filter === k ? 'border-accent bg-accent-subtle text-fg' : 'border-border hover:bg-bg-subtle')}>
              <span className={cn('size-2 rounded-full', v.dot)} aria-hidden />{v.label}
            </button>
          ))}
        </div>
        {pick && (
          <div className="rounded-xl bg-bg-subtle p-3 text-sm" aria-live="polite" data-testid="calendar-detail">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold">{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${pick.date}T00:00:00Z`))}</span>
              {dayKey(pick) && <Badge tone={dayKey(pick) === 'present' || dayKey(pick) === 'working' ? 'success' : dayKey(pick) === 'absent' || dayKey(pick) === 'missing_punch' ? 'danger' : 'info'}>{DAY_TONE[dayKey(pick)!]!.label}</Badge>}
            </div>
            {pick.holidayName && <p className="mt-1 text-fg-muted">Holiday: {pick.holidayName}</p>}
            {pick.leaveName && <p className="mt-1 text-fg-muted">{pick.leaveName}</p>}
            {pick.status && !['holiday', 'weekly_off', 'on_leave', 'not_joined'].includes(pick.status) ? (
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem] sm:grid-cols-4">
                <div><dt className="text-fg-subtle">Login</dt><dd className="font-medium tabular">{clock(pick.firstIn)}</dd></div>
                <div><dt className="text-fg-subtle">Logout</dt><dd className="font-medium tabular">{clock(pick.lastOut)}</dd></div>
                <div><dt className="text-fg-subtle">Working</dt><dd className="font-medium tabular">{hm(pick.workedMinutes)}</dd></div>
                <div><dt className="text-fg-subtle">Break</dt><dd className="font-medium tabular">{hm(pick.breakMinutes)}</dd></div>
              </dl>
            ) : !pick.holidayName && !pick.leaveName && <p className="mt-1 text-fg-muted">{pick.dayType === 'weekly_off' ? 'Weekly off.' : pick.date > home.today ? 'Not yet.' : 'Nothing recorded.'}</p>}
            {pick.status === 'missing_punch' && !pick.correctionPending && <Link className="mt-2 inline-block text-[0.8125rem] font-medium text-accent hover:underline" href="/attendance">Ask for a correction</Link>}
            {pick.correctionPending && <p className="mt-2 text-[0.8125rem] text-info">A correction for this day is waiting for approval.</p>}
            {(eventsOn.get(pick.date) ?? []).filter((e) => e.kind !== 'leave').map((e, i) => <Link key={i} className="mt-1 block text-[0.8125rem] text-fg-muted hover:text-accent hover:underline" href={e.href}>{e.kind === 'task' ? 'Task due: ' : e.kind === 'appraisal' ? 'Appraisal: ' : ''}{e.title}</Link>)}
          </div>
        )}
      </div>
    </Card>
  );
}

export function MonthSummary({ home }: { home: EmployeeHome }) {
  const s = home.attendance!.summary;
  const counted = s.present + s.absent + s.halfDay + s.missingPunch;
  const items: [string, number, typeof UserCheck, string][] = [
    ['Present', s.present, UserCheck, 'bg-success-subtle text-success'],
    ['Late', s.late, AlarmClock, 'bg-warning-subtle text-warning'],
    ['Absent', s.absent, UserX, 'bg-danger-subtle text-danger'],
    ['Leave', s.onLeave, Plane, 'bg-info-subtle text-info'],
    ['Missing punch', s.missingPunch, TriangleAlert, 'bg-danger-subtle text-danger'],
    ['WFH', s.wfh, HomeIcon, 'bg-accent-subtle text-accent'],
  ];
  return (
    <Card data-testid="month-summary">
      <CardHeader title="This month" href="/attendance" linkAs={Link} description={`${hm(s.workedMinutes) === '—' ? '0h' : hm(s.workedMinutes)} worked over ${counted} counted day${counted === 1 ? '' : 's'}`} action={<Link className="text-xs font-medium text-accent hover:underline" href="/attendance">Details</Link>} />
      <ul className="grid grid-cols-1 gap-2 px-5 pb-5">
        {items.map(([label, n, I, tone]) => (
          <li key={label} className="flex items-center gap-3">
            <span className={cn('grid size-7 place-items-center rounded-lg', tone)} aria-hidden><I className="size-3.5" /></span>
            <span className="flex-1 text-[0.8125rem]">{label}</span>
            <span className="w-20"><Progress value={counted ? (n / counted) * 100 : 0} label={`${label} share`} className="h-1.5" /></span>
            <span className="w-6 text-right text-sm font-bold tabular" data-testid={`month-${label.toLowerCase().replace(' ', '-')}`}>{n}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Small cards for today: one per status the day can have, the current one highlighted. */
export function TodayStatus({ home, today }: { home: EmployeeHome; today: AttendanceToday | null }) {
  const d = home.attendance?.days.find((x) => x.date === home.today);
  const current = d ? dayKey(d) : null;
  const opts: [string, string, typeof UserCheck][] = [
    ['present', 'Present', UserCheck], ['late', 'Late', AlarmClock], ['absent', 'Absent', UserX], ['half_day', 'Half day', Clock3],
    ['on_leave', 'Leave', Plane], ['holiday', 'Holiday', PartyPopper], ['missing_punch', 'Missing punch', TriangleAlert], ['wfh', 'WFH', HomeIcon],
  ];
  const now = current === 'working' ? 'present' : current;
  return (
    <section aria-label="Today's status" className="grid grid-cols-4 gap-2 sm:grid-cols-8" data-testid="today-status">
      {opts.map(([k, label, I]) => {
        // A weekly off lights the Holiday card, named for what today is.
        const off = k === 'holiday' && now === 'weekly_off';
        const on = now === k || off || (k === 'late' && (today?.day?.lateMinutes ?? 0) > 0);
        return (
          <div key={k} aria-current={on ? 'true' : undefined} className={cn('flex flex-col items-center gap-1 rounded-xl border p-2 text-center text-[0.6875rem] transition-colors', on ? 'border-accent bg-accent-subtle font-semibold text-fg' : 'border-border bg-surface text-fg-subtle')}>
            <I className={cn('size-4', on ? 'text-accent' : '')} aria-hidden />{off ? 'Weekly off' : label}{on && <span className="sr-only"> (today)</span>}
          </div>
        );
      })}
    </section>
  );
}

export function LeaveCard({ home, balances }: { home: EmployeeHome; balances: LeaveBalance[] | null }) {
  const l = home.leave;
  const shown = (balances ?? []).filter((b) => b.kind !== 'wfh').slice(0, 4);
  return (
    <Card data-testid="leave-card">
      <CardHeader title="Leave" href="/leave" linkAs={Link} description="Balance, requests waiting and leave coming up." action={<Link href="/leave/apply" className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-xs font-semibold text-accent-fg hover:opacity-90" data-testid="apply-leave">Apply leave</Link>} />
      <div className="grid grid-cols-1 gap-4 px-5 pb-5">
        {shown.length > 0 ? (
          <ul className="grid grid-cols-1 gap-2">
            {shown.map((b) => {
              const total = b.assigned === null ? 0 : Number(b.assigned);
              const used = Number(b.used);
              return (
                <li key={b.leaveTypeId} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
                  <span className="flex items-center gap-2 text-[0.8125rem]"><span className="size-2.5 rounded-full" style={{ background: b.color }} aria-hidden />{b.name}{Number(b.pending) > 0 && <Badge tone="warning">{b.pending} pending</Badge>}</span>
                  {b.notAssigned
                    ? <span className="text-xs text-fg-subtle" data-testid="not-assigned">Not Assigned</span>
                    : <span className="text-sm font-bold tabular">{b.available ?? b.balance}<span className="ml-1 text-[0.6875rem] font-normal text-fg-subtle">left</span></span>}
                  {!b.notAssigned && <Progress value={total ? (used / total) * 100 : 0} label={`${b.name} used`} className="col-span-2 h-1.5" />}
                </li>
              );
            })}
          </ul>
        ) : <p className="text-[0.8125rem] text-fg-muted">No leave type is visible to you yet.</p>}
        {l && (l.pending.length > 0 || l.upcoming.length > 0) && (
          <div className="grid grid-cols-1 gap-2 border-t border-border pt-3 text-[0.8125rem]">
            {l.pending.map((r) => <div key={r.id} className="flex items-center justify-between gap-2"><span>{r.type}: {shortDate(r.startDate)}{r.endDate !== r.startDate ? ` to ${shortDate(r.endDate)}` : ''}</span><Badge tone="warning">Waiting</Badge></div>)}
            {l.upcoming.map((r) => <div key={r.id} className="flex items-center justify-between gap-2"><span>{r.type}: {shortDate(r.startDate)}{r.endDate !== r.startDate ? ` to ${shortDate(r.endDate)}` : ''}</span><Badge tone="success">Approved</Badge></div>)}
          </div>
        )}
      </div>
    </Card>
  );
}

export function LearningCard({ learning }: { learning: NonNullable<EmployeeHome['learning']> }) {
  return (
    <Card data-testid="learning-card">
      <CardHeader title="My learning" href="/learning" linkAs={Link} description={learning.completion === null ? 'Nothing assigned yet.' : `${learning.completed} completed, ${learning.inProgress} in progress, ${learning.assigned} not started`} action={<Link className="text-xs font-medium text-accent hover:underline" href="/learning">All learning</Link>} />
      <div className="grid grid-cols-1 gap-3 px-5 pb-5">
        {learning.items.length === 0 ? <Empty icon={<GraduationCap className="size-5" />} title="No courses waiting" text="New learning shows here when it is assigned." /> : learning.items.map((i) => {
          const value = i.progress ?? (i.status === 'in_progress' ? 50 : 0);
          return (
            <div key={i.id} className="grid grid-cols-1 gap-1.5">
              <div className="flex items-center justify-between gap-2 text-[0.8125rem]">
                <span className="truncate font-medium">{i.title}</span>
                {i.overdue ? <Badge tone="danger">Overdue</Badge> : i.dueOn ? <span className="shrink-0 text-[0.6875rem] text-fg-subtle">Due {shortDate(i.dueOn)}</span> : null}
              </div>
              <div className="flex items-center gap-2"><Progress value={value} label={`${i.title} progress`} className="h-1.5 flex-1" /><span className="text-[0.6875rem] tabular text-fg-subtle">{i.progress === null ? (i.status === 'in_progress' ? 'Started' : 'Not started') : `${i.progress}%`}</span></div>
            </div>
          );
        })}
        {learning.items.length > 0 && <Link href="/learning" className="justify-self-start rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">Continue learning</Link>}
      </div>
    </Card>
  );
}

const REWARD_ICON = { trophy: Trophy, medal: Medal, star: Star, clock: Clock3 } as const;
const REWARD_STATUS: Record<string, [string, Tone]> = { earned: ['Earned', 'success'], on_track: ['On track', 'accent'], missed: ['Missed this month', 'danger'], not_eligible: ['Not counted', 'neutral'] };

export function Rewards({ rewards }: { rewards: MyRewards }) {
  if (!rewards.rewards.length) return null;
  return (
    <Card>
      <CardHeader title="Attendance rewards" href="/attendance" linkAs={Link} description="Set by HR. Holidays and weekly offs never count, and sick leave does not break a reward." />
      <ul className="grid grid-cols-1 gap-3 px-5 pb-5">
        {rewards.rewards.map((r) => {
          const Icon = REWARD_ICON[r.icon] ?? Trophy;
          const [label, tone] = REWARD_STATUS[r.status] ?? [r.status, 'neutral'];
          const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
          return (
            <li key={r.id} className="flex items-center gap-3" data-testid={`reward-${r.kind}`}>
              <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', r.status === 'earned' ? 'bg-success text-white' : r.status === 'missed' ? 'bg-bg-subtle text-fg-subtle' : 'bg-accent/15 text-accent')}><Icon className="size-5" aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.name}</span><Badge tone={tone}>{label}</Badge>{r.payout && <span className="text-xs font-medium text-success" data-testid="reward-payout">Wins {r.payout}</span>}</div>
                <div className="truncate text-xs text-fg-muted">{r.reason ?? r.description ?? ''}{!r.reason && r.total ? ` ${r.done} of ${r.total} working days so far.` : ''}</div>
                {r.status !== 'missed' && r.total > 0 && <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-subtle"><div className="h-full bg-accent" style={{ width: `${pct}%` }} /></div>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const PRIORITY_TONE: Record<string, Tone> = { urgent: 'danger', high: 'warning', normal: 'neutral', low: 'neutral' };

export function AnnouncementsCard({ a }: { a: NonNullable<EmployeeHome['announcements']> }) {
  return (
    <Card data-testid="announcements-card">
      <CardHeader title="Announcements" href="/announcements" linkAs={Link} description={a.unread ? `${a.unread} new` : 'All read'} action={<Link className="text-xs font-medium text-accent hover:underline" href="/announcements">All announcements</Link>} />
      {a.items.length === 0 ? <Empty icon={<Megaphone className="size-5" />} title="No announcements" text="Company news shows here." /> : (
        <ul className="divide-y divide-border border-t border-border">
          {a.items.map((n) => (
            <li key={n.id}>
              <Link href="/announcements" className="flex gap-3 px-5 py-2.5 hover:bg-bg-subtle">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-accent')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2"><span className={cn('truncate text-[0.8125rem]', !n.read && 'font-semibold')}>{n.title}</span>{n.priority !== 'normal' && n.priority !== 'low' && <Badge tone={PRIORITY_TONE[n.priority]}>{n.priority === 'urgent' ? 'Urgent' : 'Important'}</Badge>}{n.needsAck && <Badge tone="accent">Acknowledge</Badge>}</span>
                  <span className="block truncate text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{n.author ? `From ${n.author}${n.authorLevel ? `, ${n.authorLevel}` : ''}` : 'From HR'} · {relative(n.publishedAt)}{n.read ? '' : ' · Unread'}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ActivityCard({ items }: { items: EmployeeHome['activity'] }) {
  return (
    <Card data-testid="activity-card">
      <CardHeader title="Recent activity" href="/activity" linkAs={Link} description="What you did in SampCrew lately." />
      {items.length === 0 ? <Empty icon={<CalendarDays className="size-5" />} title="Nothing yet" text="Check-ins, leave and learning show here." /> : (
        <ol className="relative mx-5 mb-5 grid gap-3 border-l border-border pl-4">
          {items.map((x, i) => (
            <li key={`${x.at}${i}`} className="relative">
              <span className={cn('absolute -left-[1.3rem] top-1 size-2.5 rounded-full ring-2 ring-surface', x.kind.startsWith('punch') ? 'bg-success' : 'bg-accent')} aria-hidden />
              {x.href ? <Link href={x.href} className="text-[0.8125rem] font-medium hover:underline">{x.title}</Link> : <span className="text-[0.8125rem] font-medium">{x.title}</span>}
              <span className="block text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(x.at))}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * The Employee Workspace Home, in the order an employee needs it: today's attendance, what needs them, the month and
 * calendar, leave, learning, announcements, notifications and recent activity.
 */
export function EmployeeHomeView({ home, today, balances, rewards, calendar, renderedAt }: { home: EmployeeHome | null; today: AttendanceToday | null; balances: LeaveBalance[] | null; rewards?: MyRewards | null; calendar?: MyCalendar | null; renderedAt: number }) {
  // A check-in that is due shows first among the actions.
  const actions = home ? [...home.actions] : [];
  if (today && today.dayType === 'working' && !today.punches.length && today.allowed.web && today.shift && !today.locked) {
    const nowMin = Number(new Intl.DateTimeFormat('en-GB', { timeZone: today.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(renderedAt))) * 60
      + Number(new Intl.DateTimeFormat('en-GB', { timeZone: today.timeZone, minute: '2-digit' }).format(new Date(renderedAt)));
    if (nowMin >= toMin(today.shift.start)) actions.unshift({ key: 'check-in', level: 'warning', title: 'You have not checked in today', detail: `Your shift started at ${today.shift.start}.`, count: null, href: '/', cta: 'Check in' });
  }
  return (
    <section data-testid="employee-home" aria-label="My day" className="grid grid-cols-1 gap-5 animate-fade-in">
      {today ? <AttendanceHero today={today} renderedAt={renderedAt} /> : null}
      {home && home.attendance && <TodayStatus home={home} today={today} />}
      {!home ? <SectionError title="My day" what="Your attendance, leave and learning" /> : (
        <>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
            <ActionCenter actions={actions} title="Today's attention" description={actions.length ? undefined : 'Nothing needs you right now.'} />
            {home.attendance && <MonthSummary home={home} />}
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {home.attendance ? <AttendanceCalendar home={home} events={calendar} /> : <div />}
            <div className="grid grid-cols-1 content-start gap-5">
              {rewards && <Rewards rewards={rewards} />}
              {(home.leave || balances) && <LeaveCard home={home} balances={balances} />}
              {home.learning && <LearningCard learning={home.learning} />}
            </div>
          </div>
          {/* Announcements and notifications are read from the bell and their own pages, not repeated here (issue #86). */}
          <ActivityCard items={home.activity} />
        </>
      )}
    </section>
  );
}

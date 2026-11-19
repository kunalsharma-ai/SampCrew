'use client';
import { Alert, Badge, Button, Card, CardHeader, cn, type Tone } from '@crew/ui';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Coffee, LogIn, LogOut, Medal, Star, Timer, Trophy } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { hm } from '@/lib/time';
import type { AttendanceMonth, AttendanceToday, LeaveBalance, MyCalendar, MyRewards, TaskCounts } from '@/lib/types';
import { punchAction } from './attendance/actions';
import { RecentNotifications } from '@/components/notifications-widget';

/** Browser location for geofenced punching; resolves without coordinates if declined or slow. */
function locate(): Promise<{ latitude?: number; longitude?: number; accuracyM?: number; denied?: boolean }> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      (err) => resolve({ denied: err.code === err.PERMISSION_DENIED }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return (h ?? 0) * 60 + (m ?? 0); };

/** Worked and break minutes from today's punches, counting an open punch-in up to now. */
function tally(punches: AttendanceToday['punches'], now: number) {
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
  return { worked: Math.max(0, Math.round(worked / 60000)), breaks: Math.round(breaks / 60000), open, firstIn: punches.find((p) => p.direction === 'in')?.at ?? null };
}

function ClockCard({ today }: { today: AttendanceToday }) {
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const tz = today.timeZone;
  const t = tally(today.punches, now);
  const shiftMinutes = today.shift ? ((toMin(today.shift.end) - toMin(today.shift.start) + 1440) % 1440 || 1440) : 480;
  const remaining = Math.max(0, shiftMinutes - t.worked);
  const pct = Math.min(100, Math.round((t.worked / shiftMinutes) * 100));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(now));
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(now));
  const clockIn = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '—');
  const next = today.nextDirection;
  const canPunch = today.allowed.web && !today.locked;
  const punch = () => start(async () => {
    setNotice(null);
    const where = today.geofence.mode !== 'off' && today.geofence.configured ? await locate() : {};
    if (today.geofence.mode === 'enforce' && where.denied) {
      setNotice({ tone: 'danger', text: 'Your workplace checks that you are on site. Allow location access and try again.' });
      return;
    }
    const { denied: _d, ...coords } = where;
    const r = await punchAction({ ...coords, direction: next });
    if (!r.ok) setNotice({ tone: 'danger', text: r.message });
    else {
      const outside = r.data!.punch.geofence === 'outside';
      setNotice({ tone: outside ? 'warning' : 'success', text: `Clocked ${r.data!.punch.direction === 'in' ? 'in' : 'out'} at ${clockIn(new Date().toISOString())}.${outside ? ' You appear to be away from your workplace; this is recorded.' : ''}` });
      router.refresh();
    }
  });
  const off = today.dayType !== 'working';
  return (
    <Card className="overflow-hidden" data-testid="clock-card">
      <div className="grid gap-5 bg-gradient-to-br from-accent/15 via-transparent to-transparent p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="grid gap-1">
          <div className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{date}</div>
          <div className="text-4xl font-bold tabular tracking-tight" aria-live="off" aria-label={`Time now ${time.slice(0, 5)}`}>{time}</div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            {today.shift ? <span>{today.shift.name}: {today.shift.start} to {today.shift.end}</span> : <span>No shift set</span>}
            {off && <Badge tone="info">{today.holidayName ?? 'Weekly off'}</Badge>}
            {t.open ? <Badge tone="success" dot>Clocked in since {clockIn(t.firstIn)}</Badge> : today.punches.length ? <Badge tone="neutral" dot>Clocked out</Badge> : <Badge tone="warning" dot>Not clocked in yet</Badge>}
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          {canPunch ? (
            <Button size="lg" loading={pending} onClick={punch} variant={next === 'out' ? 'secondary' : 'primary'} data-testid="clock-button">
              {next === 'in' ? <LogIn className="size-5" /> : <LogOut className="size-5" />}{next === 'in' ? 'Clock in' : 'Clock out'}
            </Button>
          ) : <span className="text-sm text-fg-muted">{today.locked ? 'This day is locked by HR.' : 'Web clock-in is off; use the mobile app or the site kiosk.'}</span>}
          <Link className="text-right text-xs font-medium text-accent hover:underline" href="/attendance">Attendance details</Link>
        </div>
      </div>
      <div className="grid gap-3 border-t border-border px-5 py-4">
        <div className="h-2 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-label="Today's hours worked" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
        </div>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div className="flex items-center gap-2"><LogIn className="size-4 text-fg-subtle" aria-hidden /><div><dt className="text-xs text-fg-subtle">First in</dt><dd className="font-semibold tabular">{clockIn(t.firstIn)}</dd></div></div>
          <div className="flex items-center gap-2"><Timer className="size-4 text-fg-subtle" aria-hidden /><div><dt className="text-xs text-fg-subtle">Worked</dt><dd className="font-semibold tabular" data-testid="worked-today">{hm(t.worked) === '—' ? '0m' : hm(t.worked)}</dd></div></div>
          <div className="flex items-center gap-2"><Coffee className="size-4 text-fg-subtle" aria-hidden /><div><dt className="text-xs text-fg-subtle">Breaks</dt><dd className="font-semibold tabular">{hm(t.breaks) === '—' ? '0m' : hm(t.breaks)}</dd></div></div>
          <div className="flex items-center gap-2"><Clock3 className="size-4 text-fg-subtle" aria-hidden /><div><dt className="text-xs text-fg-subtle">Remaining</dt><dd className="font-semibold tabular">{off ? '—' : hm(remaining) === '—' ? 'Done' : hm(remaining)}</dd></div></div>
        </dl>
        {notice && <Alert tone={notice.tone as 'success'}>{notice.text}</Alert>}
      </div>
    </Card>
  );
}

function MonthStats({ month }: { month: AttendanceMonth }) {
  const s = month.summary;
  const items: [string, number | string, string][] = [
    ['Present', s.present, 'text-success'], ['Late', s.late, 'text-warning'], ['Absent', s.absent, 'text-danger'], ['On leave', s.onLeave, 'text-info'],
    ['Missing punch', s.missingPunch, 'text-danger'], ['Hours', hm(s.workedMinutes), 'text-accent'],
  ];
  return (
    <Card>
      <CardHeader title="This month" description="Your attendance so far this month." action={<Link className="text-xs font-medium text-accent hover:underline" href="/attendance">Details</Link>} />
      <dl className="grid grid-cols-3 gap-3 px-5 pb-5">
        {items.map(([k, v, c]) => (
          <div key={k} className="rounded-xl bg-bg-subtle p-3">
            <dt className="text-xs text-fg-subtle">{k}</dt>
            <dd className={cn('text-xl font-bold tabular', c)}>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function LeaveCards({ balances }: { balances: LeaveBalance[] }) {
  const shown = balances.filter((b) => b.tracked).slice(0, 4);
  if (!shown.length) return null;
  return (
    <section aria-label="Leave balances" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {shown.map((b) => {
        const total = Number(b.accrued) + Number(b.carriedForward) + Number(b.adjusted) || Number(b.annualEntitlement) || 0;
        const used = Number(b.taken);
        const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
        return (
          <Link key={b.leaveTypeId} href="/leave" className="crew-card group rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium"><span className="size-2.5 rounded-full" style={{ background: b.color }} aria-hidden />{b.name}</span>
              {Number(b.pending) > 0 && <Badge tone="warning">{b.pending} pending</Badge>}
            </div>
            <div className="mt-2 flex items-baseline gap-1"><span className="text-2xl font-bold tabular">{b.available ?? b.balance}</span><span className="text-xs text-fg-subtle">days left</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-label={`${b.name} used`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full transition-[width] duration-700 motion-reduce:transition-none" style={{ width: `${pct}%`, background: b.color }} />
            </div>
            <div className="mt-1 text-xs text-fg-subtle">{used} used of {total}</div>
          </Link>
        );
      })}
    </section>
  );
}

const REWARD_ICON = { trophy: Trophy, medal: Medal, star: Star, clock: Clock3 } as const;
const REWARD_STATUS: Record<string, [string, Tone]> = { earned: ['Earned', 'success'], on_track: ['On track', 'accent'], missed: ['Missed this month', 'danger'], not_eligible: ['Not counted', 'neutral'] };

function Rewards({ rewards }: { rewards: MyRewards }) {
  if (!rewards.rewards.length) return null;
  return (
    <Card>
      <CardHeader title="Attendance rewards" description="Set by HR. Holidays and weekly offs never count, and sick leave does not break a reward." />
      <ul className="grid gap-3 px-5 pb-5">
        {rewards.rewards.map((r) => {
          const Icon = REWARD_ICON[r.icon] ?? Trophy;
          const [label, tone] = REWARD_STATUS[r.status] ?? [r.status, 'neutral'];
          const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
          return (
            <li key={r.id} className="flex items-center gap-3" data-testid={`reward-${r.kind}`}>
              <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', r.status === 'earned' ? 'bg-success text-white' : r.status === 'missed' ? 'bg-bg-subtle text-fg-subtle' : 'bg-accent/15 text-accent')}><Icon className="size-5" aria-hidden /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.name}</span><Badge tone={tone}>{label}</Badge></div>
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

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KIND_DOT: Record<string, string> = { leave: 'bg-info', task: 'bg-warning', appraisal: 'bg-accent', holiday: 'bg-success' };

function MonthCalendar({ calendar }: { calendar: MyCalendar }) {
  const [selected, setSelected] = useState(calendar.today.startsWith(calendar.month) ? calendar.today : calendar.days[0]!.date);
  const first = new Date(`${calendar.days[0]!.date}T00:00:00Z`).getUTCDay();
  const lead = (first + 6) % 7;
  const pick = calendar.days.find((d) => d.date === selected);
  const title = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${calendar.month}-01T00:00:00Z`));
  const prev = useMemo(() => { const [y, m] = calendar.month.split('-').map(Number) as [number, number]; return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; }, [calendar.month]);
  const next = useMemo(() => { const [y, m] = calendar.month.split('-').map(Number) as [number, number]; return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }, [calendar.month]);
  return (
    <Card>
      <CardHeader
        title="My calendar"
        description="Holidays, weekly offs, your leave and deadlines."
        action={
          <div className="flex items-center gap-1">
            <Link aria-label="Previous month" className="rounded p-1 hover:bg-bg-subtle" href={`/?month=${prev}`} scroll={false}><ChevronLeft className="size-4" /></Link>
            <span className="min-w-28 text-center text-sm font-medium">{title}</span>
            <Link aria-label="Next month" className="rounded p-1 hover:bg-bg-subtle" href={`/?month=${next}`} scroll={false}><ChevronRight className="size-4" /></Link>
          </div>
        }
      />
      <div className="grid gap-3 px-5 pb-5">
        <div className="grid grid-cols-7 gap-1 text-center text-[0.6875rem] font-medium text-fg-subtle" aria-hidden>{DOW.map((d) => <div key={d}>{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1" role="grid" aria-label={title}>
          {Array.from({ length: lead }, (_, i) => <div key={`l${i}`} />)}
          {calendar.days.map((d) => {
            const n = Number(d.date.slice(8));
            const isToday = d.date === calendar.today;
            const kinds = [...new Set([...(d.dayType === 'holiday' ? ['holiday'] : []), ...d.events.map((e) => e.kind)])];
            return (
              <button
                key={d.date}
                type="button"
                role="gridcell"
                aria-selected={selected === d.date}
                aria-label={`${d.date}${d.holidayName ? `, ${d.holidayName}` : d.dayType === 'weekly_off' ? ', weekly off' : ''}${d.events.length ? `, ${d.events.length} events` : ''}`}
                onClick={() => setSelected(d.date)}
                className={cn(
                  'flex aspect-square flex-col items-center justify-center gap-0.5 rounded-lg text-sm tabular transition-colors motion-reduce:transition-none',
                  d.dayType === 'weekly_off' && 'text-fg-subtle',
                  d.dayType === 'holiday' && 'bg-success/10 text-success',
                  isToday && 'ring-2 ring-accent',
                  selected === d.date ? 'bg-accent text-accent-fg' : 'hover:bg-bg-subtle',
                )}
              >
                {n}
                <span className="flex h-1.5 gap-0.5">{kinds.slice(0, 3).map((k) => <span key={k} className={cn('size-1.5 rounded-full', KIND_DOT[k] ?? 'bg-fg-subtle')} />)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-3 text-[0.6875rem] text-fg-muted" aria-hidden>
          {Object.entries({ holiday: 'Holiday', leave: 'Leave', task: 'Task due', appraisal: 'Appraisal' }).map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className={cn('size-2 rounded-full', KIND_DOT[k])} />{l}</span>)}
        </div>
        {pick && (
          <div className="rounded-lg bg-bg-subtle p-3 text-sm" aria-live="polite">
            <div className="font-medium">{new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${pick.date}T00:00:00Z`))}</div>
            <ul className="mt-1 grid gap-1 text-fg-muted">
              {pick.holidayName && <li>Holiday: {pick.holidayName}</li>}
              {pick.dayType === 'weekly_off' && <li>Weekly off</li>}
              {pick.events.map((e, i) => <li key={i}><Link className="hover:text-accent hover:underline" href={e.href}>{e.title}</Link></li>)}
              {!pick.holidayName && pick.dayType !== 'weekly_off' && !pick.events.length && <li>Working day, nothing planned.</li>}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

/** The employee's own day at the top of Home: clock, hours, leave, month, rewards and calendar. */
export function MyDay({ firstName, today, month, balances, rewards, calendar, taskCounts }: {
  firstName: string; today: AttendanceToday | null; month: AttendanceMonth | null; balances: LeaveBalance[] | null; rewards: MyRewards | null; calendar: MyCalendar | null; taskCounts: TaskCounts | null;
}) {
  if (!today && !balances && !calendar) return null;
  const open = taskCounts ? taskCounts.hr.open + taskCounts.manager.open : 0;
  const overdue = taskCounts ? taskCounts.hr.overdue + taskCounts.manager.overdue : 0;
  return (
    <section aria-label={`${firstName}'s day`} className="mb-6 grid gap-5 animate-fade-in">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {today ? <ClockCard today={today} /> : <div />}
        {month && <MonthStats month={month} />}
      </div>
      {balances && <LeaveCards balances={balances} />}
      <div className="grid gap-5 lg:grid-cols-2">
        {calendar && <MonthCalendar calendar={calendar} />}
        <div className="grid content-start gap-5">
          {rewards && <Rewards rewards={rewards} />}
          {taskCounts && (
            <Card>
              <CardHeader title="My tasks" action={<Link className="text-xs font-medium text-accent hover:underline" href="/tasks">All tasks</Link>} />
              <div className="grid grid-cols-3 gap-3 px-5 pb-5 text-center">
                <Link href="/tasks?tab=hr" className="rounded-xl bg-bg-subtle p-3 hover:ring-1 hover:ring-accent"><div className="text-xl font-bold tabular">{taskCounts.hr.open}</div><div className="text-xs text-fg-subtle">HR tasks</div></Link>
                <Link href="/tasks?tab=manager" className="rounded-xl bg-bg-subtle p-3 hover:ring-1 hover:ring-accent"><div className="text-xl font-bold tabular">{taskCounts.manager.open}</div><div className="text-xs text-fg-subtle">Manager tasks</div></Link>
                <div className="rounded-xl bg-bg-subtle p-3"><div className={cn('text-xl font-bold tabular', overdue && 'text-danger')}>{overdue}</div><div className="text-xs text-fg-subtle">Overdue</div></div>
              </div>
              {!open && <p className="-mt-2 px-5 pb-5 text-xs text-fg-muted"><CalendarDays className="mr-1 inline size-3.5" aria-hidden />Nothing open right now.</p>}
            </Card>
          )}
          <RecentNotifications limit={5} />
        </div>
      </div>
    </section>
  );
}

'use client';
import { HOME_COUNT_CARDS, type HomeCountCard, type HomeSection, type WorkforceHome, type WorkforceTrend } from '@crew/contracts';
import { Badge, Card, CardHeader, cn } from '@crew/ui';
import {
  AlarmClock, CalendarClock, CircleDot, Home as HomeIcon, MessagesSquare, Plane, TriangleAlert, UserCheck, UserPlus, Users, UserX,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { ExportDialogButton } from '@/app/(app)/attendance/export-dialog';
import { ICONS } from '@/lib/icons';
import type { QuickAction } from '@/lib/nav';
import { ActionCenter, DailyBars, Empty, Progress, relative, SectionError, shortDate, StatCard } from './ui';

/** Filters kept in the page's address, so a filtered view can be shared and survives a refresh. */
function Filters({ w, extra }: { w: WorkforceHome; extra?: Record<string, string> }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(sp.toString());
    for (const [ek, ev] of Object.entries(extra ?? {})) p.set(ek, ev);
    if (v) p.set(k, v);
    else p.delete(k);
    start(() => router.push(`${path}?${p}`, { scroll: false }));
  };
  const sel = 'h-8 rounded-md border border-border bg-surface px-2 text-[0.8125rem]';
  const f = w.filters;
  return (
    <form className={cn('flex flex-wrap items-end gap-2 text-[0.75rem]', pending && 'opacity-60')} aria-label="Filter the dashboard" data-testid="home-filters" onSubmit={(e) => e.preventDefault()}>
      {f.hrWorkspaces.length > 1 && (
        <label className="grid grid-cols-1 gap-0.5"><span className="text-fg-subtle">HR Workspace</span>
          <select className={sel} value={f.applied.hrWorkspaceId ?? ''} onChange={(e) => set('hrWorkspace', e.target.value)} data-testid="filter-hr-workspace">
            <option value="">All</option>{f.hrWorkspaces.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      )}
      {f.departments.length > 0 && (
        <label className="grid grid-cols-1 gap-0.5"><span className="text-fg-subtle">Department</span>
          <select className={sel} value={f.applied.departmentId ?? ''} onChange={(e) => set('department', e.target.value)} data-testid="filter-department">
            <option value="">All</option>{f.departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      )}
      {f.locations.length > 0 && (
        <label className="grid grid-cols-1 gap-0.5"><span className="text-fg-subtle">Location</span>
          <select className={sel} value={f.applied.locationId ?? ''} onChange={(e) => set('location', e.target.value)}>
            <option value="">All</option>{f.locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
      )}
      <label className="grid grid-cols-1 gap-0.5"><span className="text-fg-subtle">Date</span>
        <input type="date" className={sel} value={w.date} onChange={(e) => set('date', e.target.value)} data-testid="filter-date" />
      </label>
    </form>
  );
}

/** Today's workforce cards; each opens the attendance list with that filter. */
export function WorkforceCards({ w, hidden = [] }: { w: WorkforceHome; hidden?: readonly string[] }) {
  const t = w.today;
  if (!t) return null;
  const show = (k: HomeCountCard) => !hidden.includes(k);
  if (HOME_COUNT_CARDS.every((c) => !show(c.key))) return null;
  const qs = (patch: Record<string, string>) => `/attendance/team?${new URLSearchParams({ date: w.date, ...(w.filters.applied.departmentId ? { departmentId: w.filters.applied.departmentId } : {}), ...(w.filters.applied.locationId ? { locationId: w.filters.applied.locationId } : {}), ...patch })}`;
  return (
    <section aria-label="Today's workforce" className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8" data-testid="workforce-cards">
      {show('employees') && <StatCard label="Employees" value={t.employees} hint={`${t.expected} expected today`} href="/employees" icon={<Users className="size-4" />} tone="bg-accent-subtle text-accent" testId="wf-employees" />}
      {show('present') && <StatCard label="Present" value={t.present} hint={t.rate === null ? 'Nobody expected' : `${t.rate}% of expected`} href={qs({ status: 'present' })} icon={<UserCheck className="size-4" />} tone="bg-success-subtle text-success" testId="wf-present" />}
      {show('working') && <StatCard label="Working now" value={t.workingNow} hint={`${t.notInYet} not in yet`} href={qs({ filter: 'working_now' })} icon={<CircleDot className="size-4" />} tone="bg-success-subtle text-success" testId="wf-working" />}
      {show('absent') && <StatCard label="Absent" value={t.absent} level={t.absent ? 'attention' : 'normal'} href={qs({ status: 'absent' })} icon={<UserX className="size-4" />} testId="wf-absent" />}
      {show('leave') && <StatCard label="On leave" value={t.onLeave} href={qs({ status: 'on_leave' })} icon={<Plane className="size-4" />} tone="bg-info-subtle text-info" testId="wf-leave" />}
      {show('late') && <StatCard label="Late" value={t.late} level={t.late ? 'attention' : 'normal'} href={qs({ filter: 'late' })} icon={<AlarmClock className="size-4" />} testId="wf-late" />}
      {show('missing') && <StatCard label="Missing punch" value={t.missingPunch} level={t.missingPunch ? 'warning' : 'normal'} href={qs({ status: 'missing_punch' })} icon={<TriangleAlert className="size-4" />} testId="wf-missing" />}
      {show('wfh') && <StatCard label="Work from home" value={t.wfh} href={qs({ filter: 'wfh' })} icon={<HomeIcon className="size-4" />} tone="bg-accent-subtle text-accent" testId="wf-wfh" />}
    </section>
  );
}

/** Where everyone is today, as one stacked bar, plus the people who need a look. */
function AttendanceMonitor({ w }: { w: WorkforceHome }) {
  const t = w.today!;
  const parts: [string, number, string, string][] = [
    ['Present', t.present, 'bg-success', 'present'], ['Not in yet', t.notInYet, 'bg-border-strong', 'not_in_yet'], ['Absent', t.absent, 'bg-danger', 'absent'],
    ['Missing punch', t.missingPunch, 'bg-warning', 'missing_punch'], ['On leave', t.onLeave, 'bg-info', 'on_leave'], ['Off or holiday', t.holidayOrOff, 'bg-bg-subtle', ''],
  ];
  const total = parts.reduce((s, p) => s + p[1], 0) || 1;
  const team = (k: string) => `/attendance/team?${new URLSearchParams({ date: w.date, ...(['not_in_yet'].includes(k) ? { filter: k } : k ? { status: k } : {}) })}`;
  return (
    <Card data-testid="attendance-monitor">
      <CardHeader title="Attendance monitoring" href="/attendance" linkAs={Link} description={`${t.workingNow} working now, ${t.earlyLeave} left early, ${t.late} late.`} action={<Link className="text-xs font-medium text-accent hover:underline" href={`/attendance/team?date=${w.date}`}>Team attendance</Link>} />
      <div className="grid grid-cols-1 gap-4 px-5 pb-5">
        <div className="flex h-3 overflow-hidden rounded-full bg-bg-subtle" role="img" aria-label={parts.map((p) => `${p[0]} ${p[1]}`).join(', ')}>
          {parts.map(([label, n, cls]) => n > 0 && <div key={label} className={cn('h-full', cls)} style={{ width: `${(n / total) * 100}%` }} title={`${label}: ${n}`} />)}
        </div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem] sm:grid-cols-3">
          {parts.map(([label, n, cls, k]) => (
            <li key={label}><Link href={team(k)} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-bg-subtle"><span className={cn('size-2.5 rounded-sm', cls)} aria-hidden /><span className="flex-1">{label}</span><span className="font-semibold tabular">{n}</span></Link></li>
          ))}
        </ul>
        {w.people.absentToday.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">Absent today</div>
            <ul className="flex flex-wrap gap-1.5">{w.people.absentToday.map((p) => <li key={p.id}><Link href={`/attendance/day/${p.id}/${w.date}`} className="rounded-full border border-border px-2 py-0.5 text-[0.75rem] hover:border-accent">{p.name}{p.department ? ` · ${p.department}` : ''}</Link></li>)}</ul>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Daily attendance rate over the last days; a bar opens that day's list. A calendar view of the same days below. */
export function TrendCard({ trend, days, base, title = 'Attendance trend' }: { trend: WorkforceTrend | null; days: number; base: string; title?: string }) {
  const router = useRouter();
  if (!trend) return <SectionError title={title} what="The attendance trend" />;
  const avg = (() => { const r = trend.days.filter((d) => d.rate !== null); return r.length ? Math.round((r.reduce((s, d) => s + d.rate!, 0) / r.length) * 10) / 10 : null; })();
  const sum = (k: 'late' | 'absent' | 'onLeave' | 'missingPunch') => trend.days.reduce((s, d) => s + d[k], 0);
  const join = base.includes('?') ? '&' : '?';
  return (
    <Card data-testid="trend-card">
      <CardHeader title={title} description={avg === null ? 'No attendance counted yet.' : `Average ${avg}% over ${days} days`} action={
        <div className="inline-flex rounded-lg border border-border p-0.5 text-[0.75rem]" role="group" aria-label="Period">
          {[7, 14, 30].map((n) => <Link key={n} href={`${base}${join}trend=${n}`} scroll={false} aria-current={n === days ? 'true' : undefined} className={cn('rounded-md px-2 py-0.5', n === days ? 'bg-accent text-accent-fg' : 'hover:bg-bg-subtle')}>{n === 7 ? 'Week' : n === 14 ? '2 weeks' : 'Month'}</Link>)}
        </div>
      } />
      <div className="grid grid-cols-1 gap-4 px-5 pb-5">
        <DailyBars days={trend.days.map((d) => ({ date: d.date, value: d.rate, detail: d.rate === null ? 'nobody expected' : `${d.rate}% present (${d.present} of ${d.expected}), ${d.late} late, ${d.absent} absent` }))} label={`Daily attendance over ${days} days`} onPick={(d) => router.push(`/attendance/team?date=${d}`)} />
        <dl className="grid grid-cols-4 gap-2 text-center">
          {([['Late', sum('late'), 'text-warning'], ['Absent', sum('absent'), 'text-danger'], ['Leave days', sum('onLeave'), 'text-info'], ['Missing', sum('missingPunch'), 'text-danger']] as const).map(([l, v, c]) => (
            <div key={l} className="rounded-lg bg-bg-subtle p-2"><dt className="text-[0.6875rem] text-fg-subtle">{l}</dt><dd className={cn('text-lg font-bold tabular', c)}>{v}</dd></div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
/** The last weeks as a calendar: each day's attendance rate; a day opens the team list for it. */
export function WorkforceCalendar({ trend, canExport = false }: { trend: WorkforceTrend | null; canExport?: boolean }) {
  if (!trend || trend.days.length < 14) return null;
  const from = trend.days[0]!.date;
  const to = trend.days[trend.days.length - 1]!.date;
  const first = new Date(`${trend.days[0]!.date}T00:00:00Z`).getUTCDay();
  const lead = (first + 6) % 7;
  return (
    <Card data-testid="workforce-calendar">
      <CardHeader title="Attendance calendar" href="/attendance/team" linkAs={Link} description="Daily workforce attendance. Pick a day for who was in." action={canExport ? <ExportDialogButton period={{ from, to, today: to, label: `${shortDate(from)} to ${shortDate(to)}` }} label="Download report" /> : undefined} />
      <div className="px-5 pb-5">
        <div className="grid grid-cols-7 gap-1 text-center text-[0.625rem] text-fg-subtle" aria-hidden>{DOW.map((d, i) => <div key={i}>{d}</div>)}</div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {Array.from({ length: lead }, (_, i) => <div key={i} />)}
          {trend.days.map((d) => {
            const tone = d.rate === null ? 'bg-bg-subtle text-fg-subtle' : d.rate >= 90 ? 'bg-success-subtle text-success ring-1 ring-inset ring-success/40' : d.rate >= 75 ? 'bg-accent-subtle text-accent ring-1 ring-inset ring-accent/40' : 'bg-warning-subtle text-warning ring-1 ring-inset ring-warning/40';
            return (
              <Link key={d.date} href={`/attendance/team?date=${d.date}`} title={`${shortDate(d.date)}: ${d.rate === null ? 'nobody expected' : `${d.rate}% present, ${d.absent} absent, ${d.onLeave} on leave, ${d.missingPunch} missing punches`}`}
                className={cn('grid aspect-square place-items-center rounded-md text-[0.6875rem] tabular transition-transform hover:scale-105', tone)}>
                <span>{Number(d.date.slice(8))}<span className="block text-[0.5625rem] leading-none">{d.rate === null ? '' : `${Math.round(d.rate)}%`}</span></span>
              </Link>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[0.6875rem] text-fg-muted" aria-hidden>
          <span className="flex items-center gap-1"><span className="size-2 rounded bg-success/60" />90% or more</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded bg-accent/60" />75 to 90%</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded bg-warning/70" />Below 75%</span>
        </div>
      </div>
    </Card>
  );
}

function LeaveSummary({ l }: { l: NonNullable<WorkforceHome['leave']> }) {
  return (
    <Card data-testid="leave-summary">
      <CardHeader title="Leave management" href="/leave" linkAs={Link} description="Requests, who is away today and leave coming up." />
      <div className="grid grid-cols-1 gap-4 px-5 pb-5">
        <div className="grid grid-cols-3 gap-2 text-center">
          <Link href="/approvals?category=leave" className="rounded-lg bg-warning-subtle p-2 hover:ring-1 hover:ring-warning"><div className="text-xl font-bold tabular text-warning">{l.pending}</div><div className="text-[0.6875rem] text-fg-muted">Pending</div></Link>
          <div className="rounded-lg bg-success-subtle p-2"><div className="text-xl font-bold tabular text-success">{l.approvedThisMonth}</div><div className="text-[0.6875rem] text-fg-muted">Approved this month</div></div>
          <div className="rounded-lg bg-danger-subtle p-2"><div className="text-xl font-bold tabular text-danger">{l.rejectedThisMonth}</div><div className="text-[0.6875rem] text-fg-muted">Rejected this month</div></div>
        </div>
        <div>
          <div className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">On leave today</div>
          {l.onLeaveToday.length === 0 ? <p className="text-[0.8125rem] text-fg-muted">Nobody.</p> : <ul className="grid grid-cols-1 gap-1 text-[0.8125rem]">{l.onLeaveToday.map((p) => <li key={p.employeeId} className="flex justify-between gap-2"><span>{p.name}</span><span className="text-fg-subtle">{p.type}, back after {shortDate(p.until)}</span></li>)}</ul>}
        </div>
        <div>
          <div className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">Next two weeks</div>
          {l.upcoming.length === 0 ? <p className="text-[0.8125rem] text-fg-muted">No approved leave coming up.</p> : <ul className="grid grid-cols-1 gap-1 text-[0.8125rem]">{l.upcoming.map((p) => <li key={p.id} className="flex justify-between gap-2"><span>{p.name}</span><span className="text-fg-subtle">{p.type}, {shortDate(p.startDate)}{p.endDate !== p.startDate ? ` to ${shortDate(p.endDate)}` : ''}</span></li>)}</ul>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/approvals?category=leave" className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg">Review requests</Link>
          <Link href="/leave?view=year" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">View leave calendar</Link>
          <Link href="/leave/manage?tab=quantities" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">Assign quantities</Link>
          <Link href="/leave/balances" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">Balances</Link>
        </div>
      </div>
    </Card>
  );
}

function EmployeeInsights({ w }: { w: WorkforceHome }) {
  const p = w.people;
  return (
    <Card data-testid="employee-insights">
      <CardHeader title="Employee overview" href="/employees" linkAs={Link} description="New joiners and people who may need a word." />
      <div className="grid grid-cols-1 gap-4 px-5 pb-5 text-[0.8125rem]">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-bg-subtle p-2"><div className="text-lg font-bold tabular">{p.newJoiners.length}</div><div className="text-[0.6875rem] text-fg-subtle">Joined in 30 days</div></div>
          <Link href="/employees" className="rounded-lg bg-bg-subtle p-2 hover:ring-1 hover:ring-accent"><div className="text-lg font-bold tabular">{p.incompleteProfiles}</div><div className="text-[0.6875rem] text-fg-subtle">Profiles missing phone or birth date</div></Link>
          <Link href="/profile/updates" className="rounded-lg bg-bg-subtle p-2 hover:ring-1 hover:ring-accent"><div className="text-lg font-bold tabular">{p.pendingProfileUpdates}</div><div className="text-[0.6875rem] text-fg-subtle">Profile updates to check</div></Link>
        </div>
        {p.newJoiners.length > 0 && (
          <div><div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle"><UserPlus className="size-3.5" aria-hidden />New joiners</div>
            <ul className="grid grid-cols-1 gap-1">{p.newJoiners.map((j) => <li key={j.id}><Link href={`/employees/${j.id}`} className="flex justify-between gap-2 hover:underline"><span>{j.name}</span><span className="text-fg-subtle">{j.department ?? ''} · {shortDate(j.joinedOn)}</span></Link></li>)}</ul>
          </div>
        )}
        <div><div className="mb-1 flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle"><TriangleAlert className="size-3.5" aria-hidden />Attendance issues this month</div>
          {p.attendanceIssues.length === 0 ? <p className="text-fg-muted">No repeated late coming, absence or missing punches.</p> : (
            <ul className="grid grid-cols-1 gap-1">{p.attendanceIssues.map((x) => <li key={x.id}><Link href={`/employees/${x.id}?tab=attendance`} className="flex justify-between gap-2 hover:underline"><span>{x.name}</span><span className="flex gap-1">{x.late > 0 && <Badge tone="warning">{x.late} late</Badge>}{x.absent > 0 && <Badge tone="danger">{x.absent} absent</Badge>}{x.missing > 0 && <Badge tone="danger">{x.missing} missing</Badge>}</span></Link></li>)}</ul>
          )}
        </div>
      </div>
    </Card>
  );
}

export function LearningSummary({ l, title = 'Learning & development' }: { l: NonNullable<WorkforceHome['learning']>; title?: string }) {
  return (
    <Card data-testid="learning-summary">
      <CardHeader title={title} href="/learning?view=team" linkAs={Link} description={l.assigned ? `${l.completion ?? 0}% of ${l.assigned} assignments completed` : 'No learning assigned yet.'} action={<Link className="text-xs font-medium text-accent hover:underline" href="/learning?view=team">View progress</Link>} />
      <div className="grid grid-cols-1 gap-3 px-5 pb-5">
        <Progress value={l.completion} label="Learning completion" barClass="bg-success" />
        <div className="grid grid-cols-4 gap-2 text-center text-[0.6875rem]">
          <div className="rounded-lg bg-bg-subtle p-2"><div className="text-lg font-bold tabular">{l.assigned}</div>Assigned</div>
          <div className="rounded-lg bg-bg-subtle p-2"><div className="text-lg font-bold tabular">{l.inProgress}</div>In progress</div>
          <Link href="/learning?view=team&status=overdue" className="rounded-lg bg-danger-subtle p-2 text-danger hover:ring-1 hover:ring-danger"><div className="text-lg font-bold tabular">{l.overdue}</div>Overdue</Link>
          <div className="rounded-lg bg-bg-subtle p-2"><div className="text-lg font-bold tabular">{l.averageScore === null ? '—' : `${l.averageScore}%`}</div>Average score</div>
        </div>
        {l.canManage && (
          <div className="flex flex-wrap gap-2">
            <Link href="/learning/catalogue" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">Create learning</Link>
            <Link href="/learning?view=team" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">Assign learning</Link>
          </div>
        )}
      </div>
    </Card>
  );
}

export function CommunicationCard({ c, title = 'Communication' }: { c: { unreadChats: number; awaitingHr?: number | null; announcements: { id: string; title: string; publishedAt: string | null; priority: string }[] }; title?: string }) {
  return (
    <Card data-testid="communication-card">
      <CardHeader title={title} href="/communication" linkAs={Link} description="Messages, questions for HR and the latest announcements." action={<Link className="text-xs font-medium text-accent hover:underline" href="/communication">Open</Link>} />
      <div className="grid grid-cols-1 gap-3 px-5 pb-5 text-[0.8125rem]">
        <div className="grid grid-cols-2 gap-2 text-center">
          <Link href="/communication" className="rounded-lg bg-bg-subtle p-2 hover:ring-1 hover:ring-accent"><div className="text-lg font-bold tabular">{c.unreadChats}</div><div className="text-[0.6875rem] text-fg-subtle">Unread messages</div></Link>
          {c.awaitingHr !== undefined && c.awaitingHr !== null && <Link href="/communication" className="rounded-lg bg-bg-subtle p-2 hover:ring-1 hover:ring-accent"><div className="text-lg font-bold tabular">{c.awaitingHr}</div><div className="text-[0.6875rem] text-fg-subtle">Questions waiting for HR</div></Link>}
        </div>
        {c.announcements.length > 0 ? <ul className="grid grid-cols-1 gap-1">{c.announcements.map((a) => <li key={a.id} className="flex items-center gap-2"><MessagesSquare className="size-3.5 text-fg-subtle" aria-hidden /><Link href="/announcements" className="flex-1 truncate hover:underline">{a.title}</Link><span className="shrink-0 text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{relative(a.publishedAt)}</span></li>)}</ul> : <p className="text-fg-muted">No recent announcements.</p>}
      </div>
    </Card>
  );
}

/**
 * Quick actions as one compact row of chips (issue #86: the old card took half the screen). Hidden when the person
 * switches Quick actions off in Settings > Home dashboard.
 */
export function QuickActionsCard({ actions, title = 'Quick actions' }: { actions: QuickAction[]; title?: string }) {
  if (!actions.length) return null;
  return (
    <section aria-label={title} data-testid="home-quick-actions" className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2">
      <span className="mr-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">{title}</span>
      {actions.map((a) => {
        const Icon = ICONS[a.icon] ?? CalendarClock;
        return (
          <Link key={a.key} href={a.href} className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[0.75rem] font-medium transition-colors hover:border-accent hover:bg-accent-subtle hover:text-accent" data-testid={`qa-${a.key}`}>
            <Icon className="size-3.5 text-accent" aria-hidden />{a.label}
          </Link>
        );
      })}
    </section>
  );
}

/**
 * The HR Workspace Home (also the Super Workspace's Workforce view): workforce today, what needs HR, attendance,
 * leave, people, learning and communication for the people this person looks after.
 */
export function WorkforceHomeView({ w, trend, trendDays, actions, base, extraParams, hiddenCards = [], hiddenSections = [] }: {
  w: WorkforceHome | null; trend: WorkforceTrend | null; trendDays: number; actions: QuickAction[]; base: string; extraParams?: Record<string, string>;
  /** Cards and sections the person switched off in Settings > Home dashboard (issue #86). */
  hiddenCards?: readonly HomeCountCard[]; hiddenSections?: readonly HomeSection[];
}) {
  if (!w) return <SectionError title="Workforce" what="Today's workforce" />;
  const on = (k: HomeSection) => !hiddenSections.includes(k);
  const pair = (a: React.ReactNode, b: React.ReactNode, cls = 'lg:grid-cols-2') => (a || b ? <div className={cn('grid grid-cols-1 gap-5', a && b ? cls : '')}>{a}{b}</div> : null);
  return (
    <section data-testid="workforce-home" aria-label="Workforce" className="grid grid-cols-1 gap-5 animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Today&apos;s workforce</div>
          <div className="text-sm text-fg-muted" data-testid="workforce-scope">{w.scope.label} · {w.scope.employees} employee{w.scope.employees === 1 ? '' : 's'}</div>
        </div>
        <Filters w={w} extra={extraParams} />
      </div>
      {on('quick_actions') && <QuickActionsCard actions={actions} />}
      {w.scope.employees === 0 ? (
        <Card><Empty icon={<Users className="size-5" />} title="No employees here yet" text="Employees you look after show here once they are added or moved in." action={<Link href="/employees" className="mt-2 text-xs font-semibold text-accent hover:underline">Employees</Link>} /></Card>
      ) : (
        <>
          <WorkforceCards w={w} hidden={hiddenCards} />
          {pair(on('action_center') && <ActionCenter actions={w.actions} title="HR action center" />, on('monitoring') && w.today ? <AttendanceMonitor w={w} /> : null, 'xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]')}
          {w.today && pair(on('trend') && <TrendCard trend={trend} days={trendDays} base={base} />, on('calendar') && <WorkforceCalendar trend={trend} canExport={Boolean(w.canExport)} />)}
          {pair(on('leave') && w.leave ? <LeaveSummary l={w.leave} /> : null, on('people') && <EmployeeInsights w={w} />)}
          {pair(on('learning') && w.learning ? <LearningSummary l={w.learning} /> : null, on('communication') && w.communication ? <CommunicationCard c={w.communication} /> : null)}
        </>
      )}
      <p className="text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>Updated {relative(w.generatedAt)}. Figures refresh when approvals, leave or notifications change, and every minute. Choose the cards and sections in <Link href="/settings/home" className="text-accent hover:underline">Settings &gt; Home dashboard</Link>.</p>
    </section>
  );
}

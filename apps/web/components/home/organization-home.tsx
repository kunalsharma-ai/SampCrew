'use client';
import { ATTENTION_LABEL, type OrganizationHome, type WorkforceTrend, type WorkspaceHealth } from '@crew/contracts';
import { Card, CardHeader, cn } from '@crew/ui';
import { AlarmClock, Building2, GraduationCap, Network, Plane, TriangleAlert, UserCheck, Users, UserX, Workflow } from 'lucide-react';
import Link from 'next/link';
import { RecentNotifications } from '@/components/notifications-widget';
import type { QuickAction } from '@/lib/nav';
import type { LeaveDashboard } from '@/lib/types';
import { ActionCenter, LEVEL_STYLE, Progress, SectionError, StatCard, relative } from './ui';
import { CommunicationCard, QuickActionsCard, TrendCard } from './workforce-home';

const HEALTH: Record<WorkspaceHealth['health'], { label: string; level: 'normal' | 'attention' | 'warning' }> = {
  good: { label: 'Healthy', level: 'normal' },
  watch: { label: 'Watch', level: 'attention' },
  attention: { label: 'Needs attention', level: 'warning' },
};

function WorkspaceCard({ w }: { w: WorkspaceHealth }) {
  const h = HEALTH[w.health];
  const s = LEVEL_STYLE[h.level];
  const href = `/?hrWorkspace=${w.id}`;
  return (
    <Link href={href} className="crew-card group grid gap-3 rounded-xl border border-border bg-surface p-4 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-accent" data-testid={`ws-${w.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">{w.name}</div>
          <div className="text-[0.6875rem] text-fg-subtle">{w.employees} employees · {w.hrUsers} HR user{w.hrUsers === 1 ? '' : 's'}{w.status !== 'active' ? ` · ${w.status}` : ''}</div>
        </div>
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium', s.bg, s.text)}><s.icon className="size-3" aria-hidden />{h.label}</span>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-[0.75rem]"><span className="text-fg-muted">Present today</span><span className="font-semibold tabular">{w.presentRate === null ? '—' : `${w.presentRate}%`}</span></div>
        <Progress value={w.presentRate} label={`${w.name} present today`} barClass={w.presentRate !== null && w.presentRate < 75 ? 'bg-warning' : 'bg-success'} className="h-1.5" />
      </div>
      <dl className="grid grid-cols-4 gap-1 text-center text-[0.625rem] text-fg-subtle">
        <div><dd className="text-sm font-bold tabular text-fg">{w.late}</dd><dt>Late</dt></div>
        <div><dd className={cn('text-sm font-bold tabular', w.missingPunch ? 'text-danger' : 'text-fg')}>{w.missingPunch}</dd><dt>Missing</dt></div>
        <div><dd className={cn('text-sm font-bold tabular', w.pendingActions > 8 ? 'text-warning' : 'text-fg')}>{w.pendingActions}</dd><dt>Pending</dt></div>
        <div><dd className="text-sm font-bold tabular text-fg">{w.learningCompletion === null ? '—' : `${w.learningCompletion}%`}</dd><dt>Learning</dt></div>
      </dl>
      <div className="text-[0.6875rem] text-fg-subtle">{w.communication} message{w.communication === 1 ? '' : 's'} in 7 days</div>
    </Link>
  );
}

/** Side-by-side figures per HR Workspace: visibility, not a ranking (rows keep their name order). */
function Comparison({ list }: { list: WorkspaceHealth[] }) {
  return (
    <Card data-testid="workspace-comparison">
      <CardHeader title="HR Workspace performance" description="The same figures for each HR Workspace today, in name order." />
      <div className="overflow-x-auto px-2 pb-4">
        <table className="w-full min-w-[40rem] text-[0.8125rem]">
          <thead><tr className="text-left text-[0.6875rem] uppercase tracking-wide text-fg-subtle">
            {['HR Workspace', 'Employees', 'Attendance', 'Absence', 'On leave', 'Late', 'Missing punch', 'Learning', 'Pending'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-border">
            {list.map((w) => (
              <tr key={w.id} className="hover:bg-bg-subtle">
                <th scope="row" className="px-3 py-2 text-left font-medium"><Link href={`/?hrWorkspace=${w.id}`} className="hover:underline">{w.name}</Link></th>
                <td className="px-3 py-2 tabular">{w.employees}</td>
                <td className="px-3 py-2 tabular">{w.presentRate === null ? '—' : `${w.presentRate}%`}</td>
                <td className="px-3 py-2 tabular">{w.absentRate === null ? '—' : `${w.absentRate}%`}</td>
                <td className="px-3 py-2 tabular">{w.onLeave}</td>
                <td className="px-3 py-2 tabular">{w.late}</td>
                <td className="px-3 py-2 tabular">{w.missingPunch}</td>
                <td className="px-3 py-2 tabular">{w.learningCompletion === null ? '—' : `${w.learningCompletion}%`}</td>
                <td className="px-3 py-2 tabular">{w.pendingActions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function LearningOverview({ l }: { l: OrganizationHome['learning'] }) {
  return (
    <Card data-testid="org-learning">
      <CardHeader title="Learning overview" description={l.assigned ? `${l.completion ?? 0}% of ${l.assigned} assignments completed, ${l.active} courses in use` : 'No learning assigned yet.'} action={<Link className="text-xs font-medium text-accent hover:underline" href="/learning?view=team">View progress</Link>} />
      <div className="grid grid-cols-1 gap-3 px-5 pb-5">
        <div className="grid grid-cols-3 gap-2 text-center text-[0.6875rem]">
          <div className="rounded-lg bg-bg-subtle p-2"><div className="text-lg font-bold tabular">{l.active}</div>Active modules</div>
          <div className="rounded-lg bg-bg-subtle p-2"><div className="text-lg font-bold tabular">{l.completed}</div>Completed</div>
          <Link href="/learning?view=team&status=overdue" className="rounded-lg bg-danger-subtle p-2 text-danger hover:ring-1 hover:ring-danger"><div className="text-lg font-bold tabular">{l.overdue}</div>Overdue</Link>
        </div>
        <ul className="grid grid-cols-1 gap-2">
          {l.byWorkspace.map((w) => (
            <li key={w.id} className="grid grid-cols-[minmax(0,9rem)_1fr_3rem] items-center gap-2 text-[0.8125rem]">
              <span className="truncate">{w.name}</span>
              <Progress value={w.completion} label={`${w.name} learning completion`} barClass="bg-success" className="h-1.5" />
              <span className="text-right tabular text-fg-muted">{w.completion === null ? '—' : `${w.completion}%`}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

/** Leave across the company from the leave dashboard: real counts only, and the three things to do next. */
function LeaveOverview({ d }: { d: LeaveDashboard }) {
  const c = d.counts;
  return (
    <Card data-testid="org-leave-overview">
      <CardHeader title="Leave overview" description={`${c.activeTypes} active leave type${c.activeTypes === 1 ? '' : 's'} for ${c.employees} people in ${d.year}. Days are only what administrators typed.`} action={<Link className="text-xs font-medium text-accent hover:underline" href="/leave/manage">Leave management</Link>} />
      <div className="grid grid-cols-1 gap-3 px-5 pb-5">
        <div className="grid grid-cols-4 gap-2 text-center text-[0.6875rem]">
          <Link href="/leave/manage?tab=approvals" className="rounded-lg bg-warning-subtle p-2 text-warning hover:ring-1 hover:ring-warning"><div className="text-lg font-bold tabular">{c.waitingForMe}</div>Waiting for you</Link>
          <div className="rounded-lg bg-bg-subtle p-2"><div className="text-lg font-bold tabular">{c.pending}</div>Pending</div>
          <div className="rounded-lg bg-success-subtle p-2 text-success"><div className="text-lg font-bold tabular">{c.approved}</div>Approved</div>
          <div className="rounded-lg bg-info-subtle p-2 text-info"><div className="text-lg font-bold tabular">{c.onLeaveToday}</div>Away today</div>
        </div>
        <ul className="grid grid-cols-1 gap-2">
          {d.byType.slice(0, 5).map((t) => (
            <li key={t.id} className="grid grid-cols-[minmax(0,10rem)_1fr_5rem] items-center gap-2 text-[0.8125rem]">
              <span className="flex items-center gap-1.5 truncate"><span className="size-2 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden />{t.name}</span>
              <Progress value={t.utilisation} label={`${t.name} used`} className="h-1.5" />
              <span className="text-right text-[0.6875rem] tabular text-fg-muted">{Number(t.credited) ? `${t.taken} of ${t.credited}` : `${t.taken} taken`}</span>
            </li>
          ))}
          {d.byType.length === 0 && <li className="text-[0.8125rem] text-fg-muted">No leave types yet.</li>}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Link href="/leave/manage?tab=types" className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg">Create leave type</Link>
          <Link href="/leave/manage?tab=quantities" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">Assign quantities</Link>
          <Link href="/settings/workspace-permissions" className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-bg-subtle">Workspace Permissions</Link>
        </div>
      </div>
    </Card>
  );
}

/**
 * The Super Workspace Home: the whole organisation at once. Each HR Workspace card opens the workforce view filtered
 * to it; alerts name the HR Workspace and what to look at.
 */
export function OrganizationHomeView({ o, trend, trendDays, actions, leave }: { o: OrganizationHome | null; trend: WorkforceTrend | null; trendDays: number; actions: QuickAction[]; leave?: LeaveDashboard | null }) {
  if (!o) return <SectionError title="Organization overview" what="The organisation overview" />;
  const v = o.overview;
  return (
    <section data-testid="organization-home" aria-label="Organisation" className="grid grid-cols-1 gap-5 animate-fade-in">
      <section aria-label="Organization overview" className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8" data-testid="org-overview">
        <StatCard label="HR Workspaces" value={v.hrWorkspaces} href="/hr-workspaces" icon={<Network className="size-4" />} tone="bg-accent-subtle text-accent" testId="org-hr-workspaces" />
        <StatCard label="Employee Workspaces" value={v.employeeWorkspaces} hint="People who sign in to SampCrew" href="/people" icon={<Building2 className="size-4" />} tone="bg-accent-subtle text-accent" testId="org-employee-workspaces" />
        <StatCard label="Employees" value={v.employees} hint={`${v.hrUsers} HR users`} href="/employees" icon={<Users className="size-4" />} tone="bg-accent-subtle text-accent" testId="org-employees" />
        <StatCard label="Present" value={v.present} hint={v.rate === null ? 'Nobody expected today' : `${v.rate}% of ${v.expected} expected`} href="/attendance/team?status=present" icon={<UserCheck className="size-4" />} tone="bg-success-subtle text-success" testId="org-present" />
        <StatCard label="Absent" value={v.absent} level={v.absent ? 'attention' : 'normal'} href="/attendance/team?status=absent" icon={<UserX className="size-4" />} testId="org-absent" />
        <StatCard label="On leave" value={v.onLeave} href="/attendance/team?status=on_leave" icon={<Plane className="size-4" />} tone="bg-info-subtle text-info" testId="org-leave" />
        <StatCard label="Late" value={v.late} level={v.late ? 'attention' : 'normal'} href="/attendance/team?filter=late" icon={<AlarmClock className="size-4" />} testId="org-late" />
        <StatCard label="Missing punch" value={v.missingPunch} level={v.missingPunch ? 'warning' : 'normal'} href="/attendance/team?status=missing_punch" icon={<TriangleAlert className="size-4" />} testId="org-missing" />
      </section>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <ActionCenter actions={o.alerts} title="Requires attention" description={o.alerts.length ? `${o.alerts.length} across your HR Workspaces · ${ATTENTION_LABEL.warning} items first` : 'Every HR Workspace is on track.'} testId="org-alerts" />
        <TrendCard trend={trend} days={trendDays} base="/?view=organization" title="Attendance trends" />
      </div>
      <Card data-testid="workspace-health">
        <CardHeader title="Workspace health" description={`Attendance target ${o.targetRate}%. Open an HR Workspace for its own dashboard.`} action={<Link className="text-xs font-medium text-accent hover:underline" href="/hr-workspaces">Manage HR Workspaces</Link>} />
        <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
          {o.workspaces.length === 0 ? <p className="text-[0.8125rem] text-fg-muted">No HR Workspaces yet. Create one to delegate a department, branch or region.</p> : o.workspaces.map((w) => <WorkspaceCard key={w.id} w={w} />)}
        </div>
      </Card>
      {o.workspaces.length > 1 && <Comparison list={o.workspaces} />}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {leave && <LeaveOverview d={leave} />}
        <LearningOverview l={o.learning} />
        <div className="grid grid-cols-1 content-start gap-5">
          <CommunicationCard c={o.communication} title="Communication overview" />
          <Card data-testid="hr-activity">
            <CardHeader title="Recent HR activity" description="Changes made across HR Workspaces." />
            {o.communication.recentHrActivity.length === 0 ? <p className="px-5 pb-5 text-[0.8125rem] text-fg-muted">Nothing recent.</p> : (
              <ul className="grid grid-cols-1 gap-2 px-5 pb-5 text-[0.8125rem]">
                {o.communication.recentHrActivity.map((a, i) => <li key={i} className="flex items-center gap-2"><Workflow className="size-3.5 text-fg-subtle" aria-hidden /><span className="flex-1 truncate">{a.title}{a.actor ? <span className="text-fg-subtle"> · {a.actor}</span> : null}</span><span className="text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{relative(a.at)}</span></li>)}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <RecentNotifications limit={5} />
        <QuickActionsCard actions={actions} title="Super Workspace quick actions" />
      </div>
      <p className="text-[0.6875rem] text-fg-subtle" suppressHydrationWarning><GraduationCap className="mr-1 inline size-3" aria-hidden />{v.activeLearning} learning assignments open · {v.pendingActions} pending HR actions · updated {relative(o.generatedAt)}</p>
    </section>
  );
}

import {
  FEATURES, PERMISSIONS, designLevelOf, workspaceLevelLabel,
  type EmployeeHome, type HomeCountCard, type HomeSection, type MemberPreferences, type OrganizationHome, type WorkforceHome, type WorkforceTrend,
} from '@crew/contracts';
import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { EmployeeHomeView } from '@/components/home/employee-home';
import { HomeRefresh } from '@/components/home/home-refresh';
import { OrganizationHomeView } from '@/components/home/organization-home';
import { HomeHeader, SectionSkeleton, StatSkeletonRow, ViewTabs } from '@/components/home/ui';
import { WorkforceHomeView } from '@/components/home/workforce-home';
import { load, loadOptional } from '@/lib/api';
import { can, canSwitchWorkView, homeActions, quickActions, workflowActions } from '@/lib/nav';
import { SetupPrompt } from '@/components/home/setup-prompt';
import type { AttendanceToday, LeaveBalance, LeaveDashboard, Me, MyCalendar, MyRewards } from '@/lib/types';
import type { Announcement, Summary } from './helpdesk/types';
import { HomeDashboard, type Dashboard } from './home-dashboard';

interface Overview { legalEntities: number; businessUnits: number; locations: number; departments: number; activeMembers: number; pendingInvites: number; countries: number; shiftTemplates?: number; leaveTypes?: number; paidLeaveTypes?: number; employees?: number }
type Search = { welcome?: string; month?: string; view?: string; hrWorkspace?: string; department?: string; location?: string; date?: string; trend?: string };

const SCOPE_LABEL: Record<string, string> = { own: 'Yourself', team: 'Your team', department: 'Your department', entity: 'Your legal entity', tenant: 'Whole organization' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Home, one per level. The Super Workspace sees its organisation (and can open any HR Workspace's workforce view), an
 * HR Workspace person the workforce they look after, an employee their own day. Anyone with an employee record also has
 * "My day" for their own attendance. The API decides what each person may see; this page only picks the view.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const [me, prefs] = await Promise.all([load<Me>('/me'), loadOptional<MemberPreferences>('/me/preferences')]);
  const experience = prefs?.experience;
  // First sign-in to a new workspace: its administrators set up the company before anything else (unless they chose "Finish later").
  if (!me.tenant.setupCompletedAt && can(me, 'org:manage') && !(await cookies()).get('crew_setup_later')) redirect('/setup');

  const level = designLevelOf(me.levels);
  // The Super Workspace and HR Workspaces look after a workforce; an Employee Workspace (managers included) sees their own day.
  const seesWorkforce = level !== 'employee' && (me.permissions['employees:read'] ?? 'own') !== 'own';
  // My Workforce / My Day is switched at the top right (issue #86); Home follows it. My Day is the person's own day.
  const switchable = canSwitchWorkView(me);
  const myDay = switchable && experience?.workView === 'myday';
  const views = myDay ? [{ key: 'me', label: 'My day' }] : [
    ...(level === 'super' && me.levels?.super ? [{ key: 'organization', label: 'Organization' }] : []),
    ...(seesWorkforce ? [{ key: 'workforce', label: level === 'super' ? 'Workforce' : 'My workforce' }] : []),
    ...(me.employee && !switchable ? [{ key: 'me', label: 'My day' }] : []),
  ];
  const fallback = sp.hrWorkspace && views.some((v) => v.key === 'workforce') ? 'workforce' : (views[0]?.key ?? 'me');
  const view = views.some((v) => v.key === sp.view) ? sp.view! : fallback;
  const steps = myDay ? [] : await setupSteps(me);
  const trendDays = sp.trend === '7' ? 7 : sp.trend === '30' ? 30 : 14;
  const levelLabel = workspaceLevelLabel(me.levels, { withName: true });
  const firstName = me.user.fullName.split(' ')[0] ?? me.user.fullName;
  const renderedAt = Date.now();

  return (
    <>
      <HomeRefresh poll={view !== 'me'} />
      <HomeHeader name={me.user.fullName} level={levelLabel} workspace={me.tenant.name} timeZone={me.tenant.timezone} renderedAt={renderedAt} />
      {steps.length > 0 && !steps.every((s) => s.done) && !experience?.setupPromptSeenAt && <SetupPrompt steps={steps} />}
      {level !== 'employee' && !myDay && (
        <Suspense fallback={null}>
          <SetupGaps me={me} />
        </Suspense>
      )}
      {views.length > 1 && <ViewTabs current={view} tabs={views.map((v) => ({ ...v, href: v.key === fallback && !sp.hrWorkspace ? '/' : `/?view=${v.key}` }))} />}
      <Suspense key={`${view}:${JSON.stringify(sp)}`} fallback={<div className="grid grid-cols-1 gap-5"><StatSkeletonRow count={view === 'me' ? 4 : 8} /><SectionSkeleton rows={4} /><div className="grid grid-cols-1 gap-5 lg:grid-cols-2"><SectionSkeleton /><SectionSkeleton /></div></div>}>
        {view === 'organization' && <OrganizationSection me={me} trendDays={trendDays} />}
        {view === 'workforce' && <WorkforceSection me={me} sp={sp} trendDays={trendDays} level={level === 'super' ? 'super' : 'hr'} hiddenCards={experience?.hiddenCards ?? []} hiddenSections={experience?.hiddenSections ?? []} />}
        {view === 'me' && <MySection me={me} month={sp.month} renderedAt={renderedAt} />}
      </Suspense>
      {!myDay && (
        <Suspense fallback={null}>
          <MoreWidgets me={me} prefs={prefs} steps={steps} firstName={firstName} welcome={Boolean(sp.welcome)} />
        </Suspense>
      )}
    </>
  );
}

/**
 * Asks HR to define the basics a new workspace cannot run without (issue #83): at least one shift and one paid leave
 * type, before people are added and start punching or applying for leave. Only shows what is missing and what this
 * person may fix.
 */
async function SetupGaps({ me }: { me: Me }) {
  if (!can(me, 'org:read')) return null;
  const o = await loadOptional<Overview>('/org/overview');
  if (!o) return null;
  const gaps: { key: string; text: string; href: string; action: string }[] = [];
  if (me.features.includes('attendance_basic') && can(me, 'attendance:configure') && o.shiftTemplates === 0)
    gaps.push({ key: 'shift', text: 'No shift types yet. Add at least one shift (for example General, 09:30 to 18:30) so attendance knows when people should work.', href: '/settings/attendance', action: 'Add a shift' });
  if (me.features.includes('leave') && can(me, 'leavetypes:create') && o.paidLeaveTypes === 0)
    gaps.push({ key: 'leave', text: o.leaveTypes ? 'There is no paid leave type yet. Add one (for example Casual Leave) and say how many days people get.' : 'No leave types yet. Add at least one paid leave type and say how many days people get, so they can apply for leave.', href: '/leave/manage?tab=types', action: 'Add a leave type' });
  if (!gaps.length) return null;
  return (
    <section aria-label="Finish setting up" data-testid="setup-gaps" className="mb-5 rounded-xl border border-warning/40 bg-warning-subtle/40 p-4">
      <h2 className="text-[0.9375rem] font-semibold">Finish setting up{o.employees ? '' : ' before you add people'}</h2>
      <ul className="mt-2 grid gap-2">
        {gaps.map((g) => (
          <li key={g.key} className="flex flex-wrap items-center justify-between gap-2 text-[0.8125rem]" data-testid={`setup-gap-${g.key}`}>
            <span className="min-w-0 flex-1 text-fg-muted">{g.text}</span>
            <Link href={g.href} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-fg hover:bg-accent-hover">{g.action}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

async function OrganizationSection({ me, trendDays }: { me: Me; trendDays: number }) {
  const attendanceOn = me.features.includes('attendance_basic');
  const [o, trend, leave] = await Promise.all([
    loadOptional<OrganizationHome>('/home/organization'),
    attendanceOn ? loadOptional<WorkforceTrend>(`/home/workforce/trend?days=${trendDays}`) : null,
    me.features.includes('leave') && can(me, 'leave:allocate') ? loadOptional<LeaveDashboard>('/leave/dashboard') : null,
  ]);
  return <OrganizationHomeView o={o} trend={trend} trendDays={trendDays} actions={homeActions(me, 'super')} leave={leave} />;
}

async function WorkforceSection({ me, sp, trendDays, level, hiddenCards, hiddenSections }: { me: Me; sp: Search; trendDays: number; level: 'super' | 'hr'; hiddenCards: HomeCountCard[]; hiddenSections: HomeSection[] }) {
  const q = new URLSearchParams();
  if (sp.hrWorkspace && (uuid.test(sp.hrWorkspace) || sp.hrWorkspace === 'central')) q.set('hrWorkspaceId', sp.hrWorkspace);
  if (sp.department && uuid.test(sp.department)) q.set('departmentId', sp.department);
  if (sp.location && uuid.test(sp.location)) q.set('locationId', sp.location);
  const t = new URLSearchParams(q);
  if (sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)) q.set('date', sp.date);
  t.set('days', String(trendDays));
  const attendanceOn = me.features.includes('attendance_basic');
  const [w, trend] = await Promise.all([
    loadOptional<WorkforceHome>(`/home/workforce?${q}`),
    attendanceOn ? loadOptional<WorkforceTrend>(`/home/workforce/trend?${t}`) : null,
  ]);
  const base = new URLSearchParams({ view: 'workforce' });
  for (const k of ['hrWorkspace', 'department', 'location', 'date'] as const) if (sp[k]) base.set(k, sp[k]!);
  return <WorkforceHomeView w={w} trend={trend} trendDays={trendDays} actions={homeActions(me, level)} base={`/?${base}`} extraParams={{ view: 'workforce' }} hiddenCards={hiddenCards} hiddenSections={hiddenSections} />;
}

async function MySection({ me, month, renderedAt }: { me: Me; month?: string; renderedAt: number }) {
  if (!me.employee) return null;
  const has = (f: string) => me.features.includes(f);
  const m = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined;
  const year = new Date(renderedAt + 330 * 60_000).toISOString().slice(0, 4);
  const [home, today, balances, rewards] = await Promise.all([
    loadOptional<EmployeeHome>(`/home/employee${m ? `?month=${m}` : ''}`),
    has('attendance_basic') && can(me, 'attendance:punch') ? loadOptional<AttendanceToday>('/attendance/today') : null,
    has('leave') && can(me, 'leave:read') ? loadOptional<{ balances: LeaveBalance[] }>(`/leave/balances?year=${year}`).then((b) => b?.balances ?? null) : null,
    has('attendance_basic') ? loadOptional<MyRewards>('/workspace/rewards?history=0') : null,
  ]);
  // Deadlines and holidays for the calendar, for the month the attendance calendar shows.
  const calendar = home ? await loadOptional<MyCalendar>(`/workspace/calendar?month=${home.month}`) : null;
  return <EmployeeHomeView home={home} today={today} balances={balances} rewards={rewards} calendar={calendar} renderedAt={renderedAt} />;
}

/** The steps of "Set up your workspace" for the people who set it up (shown on top of Home until done or opened). */
async function setupSteps(me: Me) {
  const isAdmin = can(me, 'org:manage') || can(me, 'users:invite');
  if (!isAdmin || !can(me, 'org:read')) return [];
  const overview = await loadOptional<Overview>('/org/overview');
  if (!overview) return [];
  return [
    { done: !!me.tenant.setupCompletedAt, label: 'Finish the company setup', href: '/setup' },
    { done: overview.legalEntities > 0, label: 'Add your legal entities', href: '/organization?tab=entities' },
    { done: overview.locations > 0, label: 'Add offices, plants or sites', href: '/organization?tab=locations' },
    { done: overview.departments > 0, label: 'Build your department structure', href: '/organization?tab=departments' },
    { done: overview.activeMembers + overview.pendingInvites > 1, label: 'Invite your HR team', href: '/people' },
    { done: me.user.mfaEnabled, label: 'Turn on two-step verification', href: '/settings/security' },
  ];
}

/** The customisable widgets (notes, recently viewed, helpdesk ...), loaded after the level's Home. */
async function MoreWidgets({ me, prefs, steps, firstName, welcome }: { me: Me; prefs: MemberPreferences | null; steps: Awaited<ReturnType<typeof setupSteps>>; firstName: string; welcome: boolean }) {
  const hasAnnouncements = me.features.includes('announcements');
  const hasHelpdesk = me.features.includes('helpdesk');
  const [dashboard, news, helpdesk] = await Promise.all([
    loadOptional<Dashboard>('/dashboard'),
    hasAnnouncements && can(me, 'announcements:read') ? loadOptional<Announcement[]>('/announcements') : null,
    hasHelpdesk && (can(me, 'helpdesk:use') || can(me, 'helpdesk:manage')) ? loadOptional<Summary>('/helpdesk/summary') : null,
  ]);
  const access = Object.entries(me.permissions)
    .map(([key, scope]) => ({ key, def: PERMISSIONS.find((p) => p.key === key), scope }))
    .filter((x) => x.def)
    .map((x) => ({ key: x.key, description: x.def!.description, scope: SCOPE_LABEL[x.scope] ?? x.scope }));
  return (
    <HomeDashboard
      embedded
      firstName={firstName}
      tenantName={me.tenant.name}
      welcome={welcome}
      dashboard={dashboard}
      layout={prefs?.dashboard ?? null}
      notes={prefs?.notes ?? ''}
      news={news}
      helpdesk={helpdesk}
      steps={steps}
      roles={[{ key: 'level', name: workspaceLevelLabel(me.levels, { withName: true }) }]}
      access={access}
      plan={{
        name: me.subscription?.plan ?? null,
        status: me.subscription?.status ?? null,
        included: me.features.length,
        total: FEATURES.filter((f) => f.kind === 'boolean').length,
        maxEmployees: me.limits.max_employees ?? 0,
        canView: can(me, 'billing:read'),
      }}
      actions={[...quickActions(me), ...workflowActions(me).filter((a) => a.key !== 'theme')]}
      recruiter={can(me, 'requisitions:read') || can(me, 'candidates:read')}
    />
  );
}

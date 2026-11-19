import { FEATURES, PERMISSIONS, type MemberPreferences } from '@crew/contracts';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import { can, quickActions, workflowActions } from '@/lib/nav';
import type { AttendanceMonth, AttendanceToday, LeaveBalance, Me, MyCalendar, MyRewards, TaskCounts } from '@/lib/types';
import { MyDay } from './my-day';
import type { Announcement, Summary } from './helpdesk/types';
import { HomeDashboard, type Dashboard } from './home-dashboard';

interface Overview { legalEntities: number; businessUnits: number; locations: number; departments: number; activeMembers: number; pendingInvites: number; countries: number }

const SCOPE_LABEL: Record<string, string> = { own: 'Yourself', team: 'Your team', department: 'Your department', entity: 'Your legal entity', tenant: 'Whole organization' };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ welcome?: string; month?: string }> }) {
  const { welcome, month } = await searchParams;
  const me = await load<Me>('/me');
  // First sign-in to a new workspace: its administrators set up the company before anything else (unless they chose "Finish later").
  if (!me.tenant.setupCompletedAt && can(me, 'org:manage') && !(await cookies()).get('crew_setup_later')) redirect('/setup');
  const hasAnnouncements = me.features.includes('announcements');
  const hasHelpdesk = me.features.includes('helpdesk');
  const [overview, dashboard, prefs, news, helpdesk] = await Promise.all([
    can(me, 'org:read') ? loadOptional<Overview>('/org/overview') : null,
    loadOptional<Dashboard>('/dashboard'),
    loadOptional<MemberPreferences>('/me/preferences'),
    hasAnnouncements && can(me, 'announcements:read') ? loadOptional<Announcement[]>('/announcements') : null,
    hasHelpdesk && (can(me, 'helpdesk:use') || can(me, 'helpdesk:manage')) ? loadOptional<Summary>('/helpdesk/summary') : null,
  ]);
  const isAdmin = can(me, 'org:manage') || can(me, 'users:invite');

  // The person's own day (clock, hours, leave, rewards, calendar) for anyone with an employee record.
  const self = me.employee;
  const has = (f: string) => me.features.includes(f);
  const istToday = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const calMonth = month && /^\d{4}-\d{2}$/.test(month) ? month : istToday.slice(0, 7);
  const [today, monthDays, balances, rewards, calendar, taskCounts] = self
    ? await Promise.all([
        has('attendance_basic') && can(me, 'attendance:punch') ? loadOptional<AttendanceToday>('/attendance/today') : null,
        has('attendance_basic') && can(me, 'attendance:read') ? loadOptional<AttendanceMonth>(`/attendance/days?from=${istToday.slice(0, 8)}01&to=${istToday}`) : null,
        has('leave') && can(me, 'leave:read') ? loadOptional<{ balances: LeaveBalance[] }>(`/leave/balances?year=${istToday.slice(0, 4)}`).then((b) => b?.balances ?? null) : null,
        has('attendance_basic') ? loadOptional<MyRewards>('/workspace/rewards?history=0') : null,
        loadOptional<MyCalendar>(`/workspace/calendar?month=${calMonth}`),
        has('core_hr') ? loadOptional<TaskCounts>('/tasks/counts') : null,
      ])
    : [null, null, null, null, null, null];

  const steps = overview && isAdmin
    ? [
        { done: !!me.tenant.setupCompletedAt, label: 'Finish the company setup', href: '/setup' },
        { done: overview.legalEntities > 0, label: 'Add your legal entities', href: '/organization?tab=entities' },
        { done: overview.locations > 0, label: 'Add offices, plants or sites', href: '/organization?tab=locations' },
        { done: overview.departments > 0, label: 'Build your department structure', href: '/organization?tab=departments' },
        { done: overview.activeMembers + overview.pendingInvites > 1, label: 'Invite your HR team', href: '/people' },
        { done: me.user.mfaEnabled, label: 'Turn on two-step verification', href: '/settings/security' },
      ]
    : [];

  const access = Object.entries(me.permissions)
    .map(([key, scope]) => ({ key, def: PERMISSIONS.find((p) => p.key === key), scope }))
    .filter((x) => x.def)
    .map((x) => ({ key: x.key, description: x.def!.description, scope: SCOPE_LABEL[x.scope] ?? x.scope }));

  return (
    <HomeDashboard
      firstName={me.user.fullName.split(' ')[0] ?? me.user.fullName}
      tenantName={me.tenant.name}
      welcome={Boolean(welcome)}
      dashboard={dashboard}
      layout={prefs?.dashboard ?? null}
      notes={prefs?.notes ?? ''}
      news={news}
      helpdesk={helpdesk}
      steps={steps}
      roles={me.membership.roles.map((r) => ({ key: r.key, name: r.name }))}
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
      myDay={self ? <MyDay firstName={me.user.fullName.split(' ')[0] ?? ''} today={today} month={monthDays} balances={balances} rewards={rewards} calendar={calendar} taskCounts={taskCounts} /> : null}
    />
  );
}

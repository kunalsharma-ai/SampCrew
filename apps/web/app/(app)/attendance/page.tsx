import type { AttendanceOverview, AttendanceRecordRow, Paged } from '@crew/contracts';
import { Alert, Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { CalendarDays } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError, api, load } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { can } from '@/lib/nav';
import { dateLabel, monthBounds, resolvePeriod } from '@/lib/attendance-period';
import { hm } from '@/lib/time';
import type { AttendanceMonth, AttendanceToday, LateMonth, Me } from '@/lib/types';
import { LateSummary } from './late-summary';
import { MonthView, TodayCard } from './attendance-view';
import { BucketBadge, ExportButton, Pager, PercentRing, PeriodBar, pct, periodQuery, qs, SectionCard, Tile, TotalsTiles, TrendChart } from './overview-parts';

export const metadata: Metadata = { title: 'Attendance' };

type Search = { month?: string; employeeId?: string; period?: string; from?: string; to?: string; page?: string };

/** Someone else's month (opened from the register, a team list or an HR Workspace): the API checks they may see it. */
async function OtherPerson({ me, sp }: { me: Me; sp: Search }) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month ?? '') ? sp.month! : new Date().toISOString().slice(0, 7);
  const { from, to } = monthBounds(month);
  const data = await load<AttendanceMonth>(`/attendance/days?from=${from}&to=${to}&employeeId=${sp.employeeId}`);
  const late = await api<LateMonth>(`/attendance/late/month?month=${month}&employeeId=${data.employee.id}`).catch(() => null);
  return (
    <>
      <PageHeader
        title={`Attendance: ${data.employee.name}`}
        description={`${data.employee.code}. Times are shown in ${data.employee.timeZone}.`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/attendance/employees">Employee Workspace attendance</Link>}
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Attendance this month" value={pct(data.summary.attendancePercent)} />
        <Tile label="Working days" value={data.summary.workingDays ?? '-'} />
        <Tile label="Present" value={data.totals?.present ?? data.summary.present} tone="success" />
        <Tile label="Absent" value={data.totals?.absent ?? data.summary.absent} tone="danger" />
      </div>
      <div className="grid gap-6">
        {late && <LateSummary data={late} own={false} />}
        <MonthView data={data} month={month} own={false} canClaimFor={can(me, 'attendance:correct')} />
      </div>
    </>
  );
}

export default async function AttendancePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  if (sp.employeeId) return <OtherPerson me={me} sp={sp} />;
  const period = resolvePeriod(sp, me.tenant.timezone);
  let today: AttendanceToday | null = null;
  let noRecord = false;
  try {
    today = await api<AttendanceToday>('/attendance/today');
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'no_employee_record')) return load<never>('/attendance/today');
    noRecord = true;
  }
  const o = await load<AttendanceOverview>(`/attendance/overview?from=${period.from}&to=${period.to}`);
  const caps = o.capabilities;
  const keep = periodQuery(period);
  const page = Math.max(1, Number(sp.page) || 1);
  // The date-wise history: the month view (with punches and corrections) for a whole month, otherwise a table.
  const month = period.month;
  const monthData = !noRecord && month ? await load<AttendanceMonth>(`/attendance/days?from=${monthBounds(month).from}&to=${monthBounds(month).to}`) : null;
  const history = !noRecord && !month && o.me ? await load<Paged<AttendanceRecordRow>>(`/attendance/overview/records?from=${period.from}&to=${period.to}&employeeId=${o.me.employeeId}&page=${page}&pageSize=31`) : null;
  const late = !noRecord && o.me ? await api<LateMonth>(`/attendance/late/month?month=${(month ?? period.to).slice(0, 7)}&employeeId=${o.me.employeeId}`).catch(() => null) : null;
  const level = caps.level === 'super' ? 'Super Workspace' : caps.level === 'hr' ? 'HR Workspace' : 'Employee Workspace';

  return (
    <>
      <PageHeader
        title="Attendance"
        eyebrow={level}
        description={`${period.label}. Your own attendance first${caps.employees ? ', then the attendance you look after' : ''}.`}
        actions={caps.export && o.me ? <ExportButton period={period} filters={{ employeeId: o.me.employeeId }} label="Export my attendance" /> : undefined}
      />
      <PeriodBar period={period} path="/attendance" />

      {/* 1. Personal attendance, always first. */}
      <section aria-labelledby="my-attendance" className="mb-8 grid gap-6">
        <h2 id="my-attendance" className="sr-only">My attendance</h2>
        {noRecord || !o.me ? (
          <Alert tone="info" title="Your own attendance is not tracked">
            Your login has no employee record, so you have no punches of your own.{caps.employees ? ' The attendance you look after is below.' : ' Ask HR to link it from your employee profile.'}
          </Alert>
        ) : (
          <Card data-testid="my-attendance">
            <CardHeader title="My attendance" description={`${period.label}. Attendance % is present days out of working days (weekends and holidays left out).`} />
            <div className="flex flex-col gap-5 px-5 pb-5 md:flex-row md:items-center">
              <div className="flex items-center gap-4">
                <PercentRing value={o.me.totals.percent} label="My attendance" />
                <div className="grid gap-1 text-sm">
                  <span className="text-fg-muted">Today</span>
                  <BucketBadge bucket={o.me.today} />
                </div>
              </div>
              <div className="flex-1"><TotalsTiles totals={o.me.totals} /></div>
            </div>
          </Card>
        )}
        {today && <TodayCard today={today} />}
        {late && <LateSummary data={late} own />}
        {monthData && month && <MonthView data={monthData} month={month} own canClaimFor={false} />}
        {history && (
          <Card>
            <CardHeader title="Attendance history" description={`Every day from ${dateLabel(period.from)} to ${dateLabel(period.to)}, newest first.`} />
            {history.rows.length === 0 ? (
              <EmptyState icon={<CalendarDays className="size-5" />} title="No days counted" description="No attendance days have been counted in this period yet." />
            ) : (
              <Table>
                <THead><TR><TH>Date</TH><TH>Status</TH><TH>Check-in</TH><TH>Check-out</TH><TH className="text-right">Worked</TH><TH className="text-right">Late</TH></TR></THead>
                <TBody>
                  {history.rows.map((r) => (
                    <TR key={r.date}>
                      <TD><Link className="font-medium hover:underline" href={`/attendance/day/${r.employeeId}/${r.date}`}>{dateLabel(r.date)}</Link></TD>
                      <TD><BucketBadge bucket={r.status} /> <span className="ml-1 text-xs text-fg-subtle">{r.detail}</span></TD>
                      <TD className="tabular">{r.firstIn ?? '-'}</TD>
                      <TD className="tabular">{r.lastOut ?? '-'}</TD>
                      <TD className="tabular text-right">{hm(r.workedMinutes)}</TD>
                      <TD className="tabular text-right">{r.lateMinutes ? `${r.lateMinutes} min` : '-'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
            <Pager page={history.page} pageSize={history.pageSize} total={history.total} href={(n) => `/attendance${qs({ ...keep, page: String(n) })}`} />
          </Card>
        )}
      </section>

      {/* 2. The attendance this person looks after (Super and HR Workspace only). */}
      {caps.employees && o.cards && (
        <section aria-labelledby="dashboard" className="grid gap-6" data-testid="attendance-dashboard">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="dashboard" className="text-lg font-semibold text-fg">Attendance dashboard</h2>
              <p className="text-[0.8125rem] text-fg-muted">{caps.level === 'super' ? 'Everyone in the company.' : 'The people your HR Workspace access covers.'} {period.label}.</p>
            </div>
            {caps.export && <ExportButton period={period} />}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
            <Tile label="My attendance" value={pct(o.me?.totals.percent)} />
            {o.cards.hrWorkspaces !== null && <Tile label="HR Workspaces" value={o.cards.hrWorkspaces} />}
            <Tile label="Employee Workspaces" value={o.cards.employees} hint="People you can see" />
            <Tile label="Overall attendance" value={pct(o.cards.totals.percent)} tone={o.cards.totals.percent !== null && o.cards.totals.percent < 75 ? 'danger' : 'success'} />
            <Tile label="Present today" value={o.cards.presentToday} tone="success" />
            <Tile label="Absent today" value={o.cards.absentToday} tone="danger" />
            <Tile label="On leave today" value={o.cards.onLeaveToday} tone="info" />
            <Tile label="Not counted today" value={o.cards.notCountedToday} />
          </div>
          <Card>
            <CardHeader title="Attendance trend" description="Each bar is one day's attendance percentage for everyone you can see." />
            <TrendChart points={o.trend} />
          </Card>
          <div className="grid gap-4 md:grid-cols-2">
            {caps.hrWorkspaces && (
              <SectionCard testId="section-hr-workspaces" href={`/attendance/hr-workspaces${qs(keep)}`} title="HR Workspace Attendance"
                description={caps.level === 'super' ? 'Every HR Workspace and the central group: its people, who is in today and its attendance %.' : 'Your HR Workspace and the other HR Workspaces the Super Workspace opened to you.'}
                stats={[{ label: 'HR Workspaces', value: o.cards.hrWorkspaces ?? 0 }, { label: 'Present today', value: o.cards.presentToday }, { label: 'Overall', value: pct(o.cards.totals.percent) }]} />
            )}
            <SectionCard testId="section-employees" href={`/attendance/employees${qs(keep)}`} title="Employee Workspace Attendance"
              description="Each person: status today, present, absent and leave days, attendance % and date-wise records."
              stats={[{ label: 'People', value: o.cards.employees }, { label: 'Absent today', value: o.cards.absentToday }, { label: 'On leave today', value: o.cards.onLeaveToday }]} />
          </div>
          <ModuleOverview module="attendance" actions={allowed(me, [
            { label: 'Month register', href: '/attendance/register', icon: 'calendar-range', permission: 'attendance:read' },
            { label: 'One day', href: '/attendance/team', icon: 'users-round', permission: 'attendance:read' },
            { label: 'Missing punches', href: '/attendance/team?status=missing_punch', icon: 'clock', permission: 'attendance:read' },
            { label: 'Late coming & penalties', href: '/attendance/late', icon: 'alarm-clock', permission: 'attendance:approve' },
            { label: 'Shifts', href: '/shifts', icon: 'calendar-clock', permission: 'shifts:read', feature: 'shift_scheduling' },
            { label: 'Attendance settings', href: '/settings/attendance', icon: 'timer', permission: 'attendance:configure' },
            { label: 'Devices', href: '/settings/devices', icon: 'fingerprint', permission: 'devices:manage', feature: 'attendance_advanced' },
            ...(caps.managePermissions ? [{ label: 'Attendance permissions', href: '/settings/attendance-access', icon: 'shield-check' }] : []),
          ])} />
        </section>
      )}
    </>
  );
}

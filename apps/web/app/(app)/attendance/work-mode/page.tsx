import type { WorkforceDashboard, WorkforcePersonRow } from '@crew/contracts';
import { Alert, Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Building2, CalendarX2, CircleAlert, Clock3, Home, Repeat, ShieldQuestion, UserCheck, UserX, Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ApiError, api, load, loadOptional } from '@/lib/api';
import { dateLabel } from '@/lib/attendance-period';
import type { Department, Location } from '@/lib/types';
import { ModeBadge, ModeDonut, ModeTrend, hoursLabel } from '@/components/work-mode/parts';
import { ReportButton } from '@/components/work-mode/report-dialog';
import { RealtimeRefresh } from '@/components/work-mode/realtime-refresh';
import { Pager } from '../overview-parts';
import { pickFilters, toQs, WorkforceFilters } from './filters';

export const metadata: Metadata = { title: 'Workforce attendance' };

type Search = Record<string, string | undefined>;
const CATEGORIES = ['all', 'present', 'office', 'remote', 'hybrid', 'pending', 'not_checked_in', 'on_leave', 'incomplete', 'irregular', 'absent'] as const;
const LEVEL: Record<string, string> = { super: 'Super Workspace', hr: 'HR Workspace', employee: 'Employee Workspace' };

/**
 * Workforce visibility for Super Workspace and HR Workspace: everyone in the organisation (Super and HR Workspace people
 * included) by office, home and hybrid, who is not in, on leave or irregular, with the people behind each number.
 */
export default async function WorkforcePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const filters = pickFilters(sp);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date : undefined;
  let d: WorkforceDashboard;
  try {
    d = await api<WorkforceDashboard>(`/attendance/work-mode/dashboard${toQs({ date, ...filters })}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) redirect('/attendance');
    throw e;
  }
  const category = (CATEGORIES as readonly string[]).includes(sp.category ?? '') ? sp.category! : null;
  const page = Math.max(1, Number(sp.page) || 1);
  const list = category ? await load<{ rows: WorkforcePersonRow[]; total: number; page: number; pageSize: number }>(`/attendance/work-mode/people${toQs({ date: d.date, category, ...filters, page: String(page), pageSize: '25' })}`) : null;
  const [departments, designations, locations, spaces] = await Promise.all([
    loadOptional<Department[]>('/org/departments'),
    loadOptional<{ id: string; name: string }[]>('/designations'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<{ rows: { id: string; name: string }[] }>(`/attendance/overview/hr-workspaces?from=${d.date}&to=${d.date}`),
  ]);
  const L = d.labels;
  const c = d.cards;
  const keep = { date: sp.date, ...filters };
  const card = (key: string) => `/attendance/work-mode${toQs({ ...keep, category: key })}#people`;
  const level = d.level === 'super' ? 'Super Workspace' : 'HR Workspace';
  const tiles: { key: string; label: string; value: number; icon: typeof Users; tone: string; hint?: string }[] = [
    { key: 'all', label: 'Total employees', value: c.total, icon: Users, tone: 'text-fg', hint: d.orgWide ? 'Whole organisation' : 'People you can see' },
    { key: 'present', label: 'Present', value: c.present, icon: UserCheck, tone: 'text-success', hint: `${c.workingNow} working now` },
    { key: 'office', label: L.office, value: c.office, icon: Building2, tone: 'text-accent' },
    { key: 'remote', label: L.remote, value: c.remote, icon: Home, tone: 'text-success' },
    { key: 'hybrid', label: L.hybrid, value: c.hybrid, icon: Repeat, tone: 'text-ember' },
    { key: 'pending', label: 'Pending verification', value: c.pending, icon: ShieldQuestion, tone: 'text-warning' },
    { key: 'not_checked_in', label: 'Not checked in', value: c.notCheckedIn, icon: UserX, tone: 'text-danger' },
    { key: 'on_leave', label: 'On leave', value: c.onLeave, icon: CalendarX2, tone: 'text-info' },
    { key: 'incomplete', label: 'Incomplete', value: c.incomplete, icon: Clock3, tone: 'text-warning', hint: 'Missing check-in or out' },
    { key: 'irregular', label: 'Irregularities', value: c.irregular, icon: CircleAlert, tone: 'text-danger', hint: 'Late, early, short or mixed' },
  ];
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/attendance" className="hover:underline">Attendance · {level}</Link>}
        title="Workforce attendance"
        description={`${dateLabel(d.date)}. Who is at the office, at home or both, and who needs attention${d.orgWide ? ', counted across the whole organisation' : ''}.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-bg-subtle" href={`/attendance/work-mode/register${toQs({ from: d.from, to: d.date, ...filters })}`}>Register</Link>
            <Link className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-bg-subtle" href="/attendance/offices">Office locations</Link>
            <Link className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-bg-subtle" href="/attendance/work-mode/settings">Rules</Link>
            <ReportButton from={d.date} to={d.date} today={d.to} filters={filters} section="workforce-dashboard" labels={L} />
          </div>
        }
      />
      <RealtimeRefresh />
      <WorkforceFilters path="/attendance/work-mode" values={{ date: d.date, ...filters }} departments={departments ?? []} designations={designations ?? []} locations={locations ?? []} spaces={spaces?.rows ?? []} />
      {d.orgWide && d.level !== 'super' && (
        <Alert tone="info" className="mb-5">The numbers count everyone in the organisation, Super Workspace and other HR Workspaces included. The lists show only the {d.visiblePeople} people your HR Workspace access covers.</Alert>
      )}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="workforce-cards">
        {tiles.map((t, i) => (
          <Link key={t.key} href={card(t.key)} data-testid={`card-${t.key}`} aria-current={category === t.key ? 'true' : undefined}
            className={`wm-rise group relative overflow-hidden rounded-xl border bg-surface px-4 py-3 transition hover:-translate-y-0.5 hover:border-accent hover:shadow-sm ${category === t.key ? 'border-accent ring-1 ring-accent' : 'border-border'}`}
            style={{ animationDelay: `${i * 40}ms` }}>
            <div className="flex items-center justify-between gap-2"><span className="text-[0.8125rem] text-fg-muted">{t.label}</span><t.icon className={`size-4 ${t.tone}`} aria-hidden /></div>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular text-fg">{t.value}</div>
            {t.hint && <div className="mt-0.5 text-xs text-fg-subtle">{t.hint}</div>}
          </Link>
        ))}
      </div>
      <div className="mb-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Where people worked" description={`${dateLabel(d.date)}. Days still open count where people are so far.`} />
          <div className="px-5 pb-5"><ModeDonut values={{ office: c.office, remote: c.remote, hybrid: c.hybrid, pending_verification: c.pending }} labels={L} center={{ value: c.present, label: 'present' }} /></div>
        </Card>
        <Card>
          <CardHeader title="By workspace level" description="Super Workspace, HR Workspace and Employee Workspace people are all counted." />
          <Table>
            <THead><TR><TH>Level</TH><TH className="text-right">People</TH><TH className="text-right">Present</TH><TH className="text-right">Office</TH><TH className="text-right">Home</TH><TH className="text-right">Hybrid</TH></TR></THead>
            <TBody>{d.byLevel.map((g) => <TR key={g.level}><TD className="font-medium">{g.label}</TD><TD className="tabular text-right">{g.total}</TD><TD className="tabular text-right">{g.present}</TD><TD className="tabular text-right">{g.office}</TD><TD className="tabular text-right">{g.remote}</TD><TD className="tabular text-right">{g.hybrid}</TD></TR>)}</TBody>
          </Table>
          <p className="border-t border-border px-5 py-3 text-[0.8125rem] text-fg-muted">Hours today: office {hoursLabel(d.hours.office)} · away {hoursLabel(d.hours.remote)}</p>
        </Card>
      </div>
      <Card className="mb-6">
        <CardHeader title="Daily trend" description={`${dateLabel(d.from)} to ${dateLabel(d.to)}: ${L.office}, ${L.remote}, ${L.hybrid} and pending, per day.`} />
        <ModeTrend points={d.trend} labels={L} />
      </Card>
      <div className="mb-6 grid gap-6 lg:grid-cols-2">
        {([['By department', d.byDepartment, 'departmentId'], ['By office', d.byLocation, 'locationId']] as const).map(([title, rows, key]) => (
          <Card key={title}>
            <CardHeader title={title} />
            {rows.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">Nobody to show.</p> : (
              <Table>
                <THead><TR><TH>Name</TH><TH className="text-right">People</TH><TH className="text-right">Office</TH><TH className="text-right">Home</TH><TH className="text-right">Hybrid</TH><TH className="text-right">Pending</TH></TR></THead>
                <TBody>
                  {rows.slice(0, 12).map((g) => (
                    <TR key={g.id ?? 'none'}>
                      <TD>{g.id ? <Link className="font-medium hover:underline" href={`/attendance/work-mode${toQs({ ...keep, [key]: g.id, category: 'present' })}#people`}>{g.name}</Link> : <span className="text-fg-muted">{g.name}</span>}</TD>
                      <TD className="tabular text-right">{g.total}</TD><TD className="tabular text-right">{g.office}</TD><TD className="tabular text-right">{g.remote}</TD><TD className="tabular text-right">{g.hybrid}</TD><TD className="tabular text-right">{g.pending}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        ))}
      </div>
      <Card id="people" data-testid="workforce-people">
        <CardHeader title={category ? tiles.find((t) => t.key === category)?.label ?? 'People' : 'People'} description={category ? `${dateLabel(d.date)}. Only people you may see are listed.` : 'Choose a card above to see the people behind it.'} />
        {!list ? null : list.rows.length === 0 ? <EmptyState icon={<Users className="size-5" />} title="Nobody here" description="No one you can see matches this card on this day." /> : (
          <>
            <Table>
              <THead><TR><TH>Employee</TH><TH>Level</TH><TH>Department</TH><TH>Where</TH><TH>Check-in</TH><TH>Check-out</TH><TH className="text-right">Office</TH><TH className="text-right">Away</TH></TR></THead>
              <TBody>
                {list.rows.map((r) => (
                  <TR key={r.employeeId}>
                    <TD><Link className="font-medium hover:underline" href={`/attendance/day/${r.employeeId}/${d.date}`}>{r.name}</Link><div className="text-xs text-fg-subtle">{[r.code, r.designation].filter(Boolean).join(' · ')}</div></TD>
                    <TD className="text-xs">{LEVEL[r.level]}</TD>
                    <TD className="text-fg-muted">{r.department ?? '-'}</TD>
                    <TD>{r.mode ? <ModeBadge mode={r.mode} labels={L} provisional={r.provisional} /> : <span className="text-xs text-fg-subtle">{r.status.replace(/_/g, ' ')}</span>}</TD>
                    <TD className="tabular">{r.checkIn ?? '-'}{r.checkInPlace && <div className="text-xs text-fg-subtle">{r.checkInPlace}</div>}</TD>
                    <TD className="tabular">{r.checkOut ?? '-'}{r.checkOutPlace && <div className="text-xs text-fg-subtle">{r.checkOutPlace}</div>}</TD>
                    <TD className="tabular text-right">{hoursLabel(r.officeMinutes)}</TD>
                    <TD className="tabular text-right">{hoursLabel(r.remoteMinutes)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pager page={list.page} pageSize={list.pageSize} total={list.total} href={(n) => `/attendance/work-mode${toQs({ ...keep, category: category!, page: String(n) })}#people`} />
          </>
        )}
      </Card>
    </>
  );
}

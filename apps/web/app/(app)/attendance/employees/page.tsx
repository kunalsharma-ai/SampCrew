import { ATTENDANCE_BUCKETS, ATTENDANCE_BUCKET_LABEL, type AttendanceHrWorkspaceRow, type AttendanceOverview, type AttendancePersonRow, type AttendanceRecordRow, type AttendanceTotals, type Paged } from '@crew/contracts';
import { Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { UsersRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { dateLabel, resolvePeriod } from '@/lib/attendance-period';
import { hm } from '@/lib/time';
import type { Me } from '@/lib/types';
import { BucketBadge, ExportButton, Pager, PercentBar, PeriodBar, pct, periodQuery, qs } from '../overview-parts';

export const metadata: Metadata = { title: 'Employee Workspace attendance' };

type Search = { period?: string; from?: string; to?: string; month?: string; q?: string; hrWorkspaceId?: string; status?: string; level?: string; sort?: string; view?: string; page?: string };
const LEVEL: Record<string, string> = { super: 'Super Workspace', hr: 'HR Workspace', employee: 'Employee Workspace' };
const valid = <T extends string>(v: string | undefined, list: readonly T[]) => (v && (list as readonly string[]).includes(v) ? (v as T) : undefined);

export default async function EmployeeAttendancePage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const period = resolvePeriod(sp, me.tenant.timezone);
  const o = await load<AttendanceOverview>(`/attendance/overview?from=${period.to}&to=${period.to}`);
  // Employee Workspace has only its own attendance: there is no list to show.
  if (!o.capabilities.employees) redirect('/attendance');
  const caps = o.capabilities;
  const view = sp.view === 'records' ? 'records' : 'people';
  const filters = {
    q: sp.q?.trim() || undefined,
    hrWorkspaceId: sp.hrWorkspaceId || undefined,
    status: valid(sp.status, ATTENDANCE_BUCKETS),
    level: valid(sp.level, ['super', 'hr', 'employee'] as const),
  };
  const sort = valid(sp.sort, ['name', 'percent', 'absent', 'present'] as const) ?? 'name';
  const page = Math.max(1, Number(sp.page) || 1);
  const base = { from: period.from, to: period.to, ...filters, page: String(page) };
  const spaces = caps.hrWorkspaces ? (await load<{ rows: AttendanceHrWorkspaceRow[] }>(`/attendance/overview/hr-workspaces?from=${period.to}&to=${period.to}`)).rows : [];
  const people = view === 'people' ? await load<Paged<AttendancePersonRow> & { totals: AttendanceTotals }>(`/attendance/overview/people${qs({ ...base, sort, pageSize: '25' })}`) : null;
  const records = view === 'records' ? await load<Paged<AttendanceRecordRow>>(`/attendance/overview/records${qs({ ...base, pageSize: '50' })}`) : null;
  const keep = { ...periodQuery(period), ...filters, sort: sort === 'name' ? undefined : sort, view: view === 'people' ? undefined : view };
  const link = (patch: Record<string, string | undefined>) => `/attendance/employees${qs({ ...keep, ...patch })}`;
  const spaceName = filters.hrWorkspaceId ? spaces.find((s) => s.id === filters.hrWorkspaceId)?.name : undefined;
  return (
    <>
      <PageHeader
        eyebrow={<Link href={`/attendance${qs(periodQuery(period))}`} className="hover:underline">Attendance</Link>}
        title="Employee Workspace attendance"
        description={`${period.label}. ${caps.level === 'super' ? 'Everyone in the company' : 'The people your HR Workspace access covers'}${spaceName ? `, in ${spaceName}` : ''}.`}
        actions={caps.export && <ExportButton period={period} filters={filters} />}
      />
      <PeriodBar period={period} path="/attendance/employees" keep={{ ...filters, view: keep.view }} />
      <form action="/attendance/employees" className="mb-4 flex flex-wrap items-end gap-3 text-sm" data-testid="attendance-filters">
        {Object.entries({ ...periodQuery(period), view: keep.view }).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
        <label className="grid gap-1"><span className="text-xs text-fg-muted">Name or employee ID</span>
          <input className="h-9 w-52 rounded-md border border-border bg-surface px-2" type="search" name="q" defaultValue={filters.q ?? ''} />
        </label>
        {spaces.length > 0 && (
          <label className="grid gap-1"><span className="text-xs text-fg-muted">HR Workspace</span>
            <select className="h-9 rounded-md border border-border bg-surface px-2" name="hrWorkspaceId" defaultValue={filters.hrWorkspaceId ?? ''}>
              <option value="">All</option>{spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="grid gap-1"><span className="text-xs text-fg-muted">Attendance status</span>
          <select className="h-9 rounded-md border border-border bg-surface px-2" name="status" defaultValue={filters.status ?? ''}>
            <option value="">All</option>{ATTENDANCE_BUCKETS.map((b) => <option key={b} value={b}>{ATTENDANCE_BUCKET_LABEL[b]}</option>)}
          </select>
        </label>
        {caps.level === 'super' && (
          <label className="grid gap-1"><span className="text-xs text-fg-muted">Level</span>
            <select className="h-9 rounded-md border border-border bg-surface px-2" name="level" defaultValue={filters.level ?? ''}>
              <option value="">All</option><option value="super">Super Workspace</option><option value="hr">HR Workspace</option><option value="employee">Employee Workspace</option>
            </select>
          </label>
        )}
        {view === 'people' && (
          <label className="grid gap-1"><span className="text-xs text-fg-muted">Sort by</span>
            <select className="h-9 rounded-md border border-border bg-surface px-2" name="sort" defaultValue={sort}>
              <option value="name">Name</option><option value="percent">Lowest attendance first</option><option value="absent">Most absent days</option><option value="present">Most present days</option>
            </select>
          </label>
        )}
        <button className="h-9 rounded-md border border-border px-3 font-medium hover:bg-bg-subtle" type="submit">Apply</button>
        {(filters.q || filters.hrWorkspaceId || filters.status || filters.level) && <Link className="h-9 px-1 leading-9 text-accent hover:underline" href={`/attendance/employees${qs({ ...periodQuery(period), view: keep.view })}`}>Clear filters</Link>}
      </form>
      <nav aria-label="View" className="mb-3 flex gap-1 text-sm">
        <Link href={link({ view: undefined, page: undefined })} aria-current={view === 'people' ? 'page' : undefined} className={`rounded-md px-3 py-1.5 font-medium ${view === 'people' ? 'bg-bg-subtle text-fg' : 'text-fg-muted hover:bg-bg-subtle'}`}>Employee-wise</Link>
        <Link href={link({ view: 'records', page: undefined, sort: undefined })} aria-current={view === 'records' ? 'page' : undefined} className={`rounded-md px-3 py-1.5 font-medium ${view === 'records' ? 'bg-bg-subtle text-fg' : 'text-fg-muted hover:bg-bg-subtle'}`}>Date-wise</Link>
      </nav>
      {people && (
        <Card>
          <CardHeader title="Employee-wise attendance" description={`${people.total} ${people.total === 1 ? 'person' : 'people'}. Overall ${pct(people.totals.percent)}: ${people.totals.present} present, ${people.totals.absent} absent and ${people.totals.leave} leave days out of ${people.totals.workingDays} working days.`} />
          {people.rows.length === 0 ? (
            <EmptyState icon={<UsersRound className="size-5" />} title="No one to show" description="Nobody you can see matches these filters in this period." />
          ) : (
            <Table aria-label="Employee-wise attendance">
              <THead><TR><TH>Employee</TH><TH>HR Workspace</TH><TH>Today</TH><TH className="text-right">Working days</TH><TH className="text-right">Present</TH><TH className="text-right">Absent</TH><TH className="text-right">Leave</TH><TH className="text-right">Late</TH><TH className="text-right">Attendance</TH></TR></THead>
              <TBody>
                {people.rows.map((r) => (
                  <TR key={r.employeeId}>
                    <TD>
                      <Link className="font-medium hover:underline" href={`/attendance?employeeId=${r.employeeId}${period.month ? `&month=${period.month}` : ''}`}>{r.name}</Link>
                      <div className="text-xs text-fg-subtle">{r.code}{r.department ? ` · ${r.department}` : ''} · {LEVEL[r.level]}</div>
                    </TD>
                    <TD className="text-fg-muted">{r.hrWorkspaceName}</TD>
                    <TD><BucketBadge bucket={r.today} /></TD>
                    <TD className="tabular text-right">{r.totals.workingDays}</TD>
                    <TD className="tabular text-right">{r.totals.present}</TD>
                    <TD className="tabular text-right">{r.totals.absent}</TD>
                    <TD className="tabular text-right">{r.totals.leave}</TD>
                    <TD className="tabular text-right">{r.totals.late}</TD>
                    <TD className="text-right"><PercentBar value={r.totals.percent} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
          <Pager page={people.page} pageSize={people.pageSize} total={people.total} href={(n) => link({ page: String(n) })} />
        </Card>
      )}
      {records && (
        <Card>
          <CardHeader title="Date-wise attendance" description={`${records.total} ${records.total === 1 ? 'day' : 'days'}, newest first. Times are in each person's own time zone.`} />
          {records.rows.length === 0 ? (
            <EmptyState icon={<UsersRound className="size-5" />} title="No days to show" description="No attendance days match these filters in this period." />
          ) : (
            <Table aria-label="Date-wise attendance">
              <THead><TR><TH>Date</TH><TH>Employee</TH><TH>HR Workspace</TH><TH>Status</TH><TH>Check-in</TH><TH>Check-out</TH><TH className="text-right">Worked</TH><TH className="text-right">Late</TH></TR></THead>
              <TBody>
                {records.rows.map((r) => (
                  <TR key={`${r.employeeId}-${r.date}`}>
                    <TD><Link className="hover:underline" href={`/attendance/day/${r.employeeId}/${r.date}`}>{dateLabel(r.date)}</Link></TD>
                    <TD><span className="font-medium">{r.name}</span> <span className="text-xs text-fg-subtle">{r.code}</span></TD>
                    <TD className="text-fg-muted">{r.hrWorkspaceName}</TD>
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
          <Pager page={records.page} pageSize={records.pageSize} total={records.total} href={(n) => link({ page: String(n) })} />
        </Card>
      )}
    </>
  );
}


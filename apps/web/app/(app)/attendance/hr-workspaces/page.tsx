import type { AttendanceHrWorkspaceRow, AttendanceOverview } from '@crew/contracts';
import { Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Building2 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { resolvePeriod } from '@/lib/attendance-period';
import type { Me } from '@/lib/types';
import { ExportButton, PercentBar, PeriodBar, periodQuery, qs, Tile } from '../overview-parts';

export const metadata: Metadata = { title: 'HR Workspace attendance' };

export default async function HrWorkspaceAttendancePage({ searchParams }: { searchParams: Promise<{ period?: string; from?: string; to?: string; month?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const period = resolvePeriod(sp, me.tenant.timezone);
  const o = await load<AttendanceOverview>(`/attendance/overview?from=${period.to}&to=${period.to}`);
  // HR Workspace without "View other HR Workspace attendance", and Employee Workspace, have no such section.
  if (!o.capabilities.hrWorkspaces) redirect('/attendance');
  const data = await load<{ rows: AttendanceHrWorkspaceRow[]; today: string }>(`/attendance/overview/hr-workspaces?from=${period.from}&to=${period.to}`);
  const sum = (k: 'hrPeople' | 'employees' | 'presentToday' | 'absentToday' | 'onLeaveToday') => data.rows.reduce((n, r) => n + r[k], 0);
  const keep = periodQuery(period);
  return (
    <>
      <PageHeader
        eyebrow={<Link href={`/attendance${qs(keep)}`} className="hover:underline">Attendance</Link>}
        title="HR Workspace attendance"
        description={`${period.label}. ${o.capabilities.level === 'super' ? 'Every HR Workspace, and the central group the company runs itself.' : 'Your HR Workspace and the ones the Super Workspace opened to you.'} Open one for its people.`}
        actions={o.capabilities.export && <ExportButton period={period} filters={{ include: 'hr_workspaces' }} />}
      />
      <PeriodBar period={period} path="/attendance/hr-workspaces" />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Tile label="HR Workspaces" value={data.rows.filter((r) => r.id !== 'central').length} />
        <Tile label="HR Workspace people" value={sum('hrPeople')} />
        <Tile label="Employees" value={sum('employees')} />
        <Tile label="Present today" value={sum('presentToday')} tone="success" />
        <Tile label="Absent today" value={sum('absentToday')} tone="danger" />
      </div>
      <Card>
        <CardHeader title="HR Workspaces" description="Today's numbers are for today; working days and attendance % are for the period. A person who looks after an HR Workspace is counted in it." />
        {data.rows.length === 0 ? (
          <EmptyState icon={<Building2 className="size-5" />} title="No HR Workspaces" description="There are no HR Workspaces you can see yet." />
        ) : (
          <Table aria-label="HR Workspace attendance">
            <THead><TR><TH>HR Workspace</TH><TH className="text-right">HR people</TH><TH className="text-right">Employees</TH><TH className="text-right">Present today</TH><TH className="text-right">Absent today</TH><TH className="text-right">On leave today</TH><TH className="text-right">Working days</TH><TH className="text-right">Attendance</TH></TR></THead>
            <TBody>
              {data.rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link className="font-medium hover:underline" href={`/attendance/hr-workspaces/${r.id}${qs(keep)}`}>{r.name}</Link>
                    <div className="text-xs text-fg-subtle">{r.id === 'central' ? 'People in no HR Workspace' : `${r.code ? `${r.code} · ` : ''}${r.status === 'active' ? 'Active' : 'Suspended'}`}</div>
                  </TD>
                  <TD className="tabular text-right">{r.hrPeople}</TD>
                  <TD className="tabular text-right">{r.employees}</TD>
                  <TD className="tabular text-right">{r.presentToday}</TD>
                  <TD className="tabular text-right">{r.absentToday}</TD>
                  <TD className="tabular text-right">{r.onLeaveToday}</TD>
                  <TD className="tabular text-right">{r.totals.workingDays}</TD>
                  <TD className="text-right"><PercentBar value={r.totals.percent} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}

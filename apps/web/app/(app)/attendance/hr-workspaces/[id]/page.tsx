import type { AttendanceHrWorkspaceRow, AttendancePersonRow, AttendanceTrendPoint } from '@crew/contracts';
import { Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { UsersRound } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { resolvePeriod } from '@/lib/attendance-period';
import type { Me } from '@/lib/types';
import { BucketBadge, ExportButton, PercentBar, PercentRing, PeriodBar, periodQuery, qs, Tile, TotalsTiles, TrendChart } from '../../overview-parts';

export const metadata: Metadata = { title: 'HR Workspace attendance' };

const LEVEL: Record<string, string> = { super: 'Super Workspace', hr: 'HR Workspace', employee: 'Employee Workspace' };

export default async function OneHrWorkspaceAttendancePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string; from?: string; to?: string; month?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const me = await load<Me>('/me');
  const period = resolvePeriod(sp, me.tenant.timezone);
  // The API answers 404 for an HR Workspace this person may not see, the same as one that does not exist.
  const data = await load<{ workspace: AttendanceHrWorkspaceRow; trend: AttendanceTrendPoint[]; people: AttendancePersonRow[] }>(`/attendance/overview/hr-workspaces/${encodeURIComponent(id)}?from=${period.from}&to=${period.to}`);
  const w = data.workspace;
  const canExport = (await load<{ capabilities: { export: boolean } }>(`/attendance/overview?from=${period.to}&to=${period.to}`)).capabilities.export;
  const keep = periodQuery(period);
  const admins = data.people.filter((p) => p.level === 'hr');
  const rest = data.people.filter((p) => p.level !== 'hr');
  const table = (rows: AttendancePersonRow[]) => (
    <Table>
      <THead><TR><TH>Person</TH><TH>Today</TH><TH className="text-right">Working days</TH><TH className="text-right">Present</TH><TH className="text-right">Absent</TH><TH className="text-right">Leave</TH><TH className="text-right">Late</TH><TH className="text-right">Attendance</TH></TR></THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.employeeId}>
            <TD>
              <Link className="font-medium hover:underline" href={`/attendance?employeeId=${r.employeeId}${period.month ? `&month=${period.month}` : ''}`}>{r.name}</Link>
              <div className="text-xs text-fg-subtle">{r.code}{r.department ? ` · ${r.department}` : ''} · {LEVEL[r.level]}</div>
            </TD>
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
  );
  return (
    <>
      <PageHeader
        eyebrow={<Link href={`/attendance/hr-workspaces${qs(keep)}`} className="hover:underline">HR Workspace attendance</Link>}
        title={w.name}
        description={`${period.label}. ${w.id === 'central' ? 'The people in no HR Workspace, and HR people for the whole company.' : `${w.code ? `${w.code}. ` : ''}Its HR Workspace people and its employees.`}`}
        actions={canExport && <ExportButton period={period} filters={{ hrWorkspaceId: w.id }} label="Export this HR Workspace" />}
      />
      <PeriodBar period={period} path={`/attendance/hr-workspaces/${w.id}`} />
      <Card className="mb-6">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-center">
          <PercentRing value={w.totals.percent} label={`${w.name} attendance`} />
          <div className="grid flex-1 gap-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Tile label="HR Workspace people" value={w.hrPeople} />
              <Tile label="Employees" value={w.employees} />
              <Tile label="Present today" value={w.presentToday} tone="success" />
              <Tile label="Absent today" value={w.absentToday} tone="danger" />
            </div>
            <TotalsTiles totals={w.totals} />
          </div>
        </div>
      </Card>
      <div className="grid gap-6">
        <Card>
          <CardHeader title="Attendance trend" description="Each bar is one day's attendance percentage for everyone you can see." />
          <TrendChart points={data.trend} />
        </Card>
        {admins.length > 0 && (
          <Card data-testid="hr-workspace-admins">
            <CardHeader title="HR Workspace people" description="The people who look after this HR Workspace." />
            {table(admins)}
          </Card>
        )}
        <Card data-testid="hr-workspace-employees">
          <CardHeader title="Employees" description="Everyone placed in this HR Workspace that you can see." />
          {rest.length ? table(rest) : <EmptyState icon={<UsersRound className="size-5" />} title="No employees" description="No one you can see is placed in this HR Workspace in this period." />}
        </Card>
      </div>
    </>
  );
}

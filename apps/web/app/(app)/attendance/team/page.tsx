import { Card, CardHeader, EmptyState, PageHeader, Stat, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Users } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { addDays, dayLabel, hm, STATUS_LABEL } from '@/lib/time';
import type { AttendanceDay, Department, Location } from '@/lib/types';

export const metadata: Metadata = { title: 'Team attendance' };

const time = (iso: string | null, tz = 'UTC') => (iso ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso)) : '—');

export default async function TeamAttendancePage({ searchParams }: { searchParams: Promise<{ date?: string; status?: string; departmentId?: string; locationId?: string }> }) {
  const sp = await searchParams;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : new Date().toISOString().slice(0, 10);
  const qs = new URLSearchParams({ date });
  for (const k of ['status', 'departmentId', 'locationId'] as const) if (sp[k]) qs.set(k, sp[k]!);
  const [data, departments, locations] = await Promise.all([
    load<{ date: string; summary: Record<string, number>; rows: AttendanceDay[] }>(`/attendance/team?${qs}`),
    loadOptional<Department[]>('/org/departments'),
    loadOptional<Location[]>('/org/locations'),
  ]);
  const tzOf = new Map((locations ?? []).map((l) => [l.name, l.timezone]));
  const s = data.summary;
  const link = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams({ date, ...(sp.departmentId ? { departmentId: sp.departmentId } : {}), ...(sp.locationId ? { locationId: sp.locationId } : {}), ...(sp.status ? { status: sp.status } : {}) });
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    return `?${p}`;
  };
  return (
    <>
      <PageHeader title="Team attendance" description={`${dayLabel(date)}. Everyone you can see, with how each day was counted.`} actions={
        <div className="flex items-center gap-3 text-sm">
          <Link className="hover:underline" href={link({ date: addDays(date, -1) })}>Previous day</Link>
          <Link className="hover:underline" href={link({ date: addDays(date, 1) })}>Next day</Link>
        </div>
      } />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="People" value={s.total ?? 0} />
        <Stat label="On site now" value={s.onSiteNow ?? 0} hint="Punched in, not out" />
        <Stat label="Present" value={(s.present ?? 0) + (s.half_day ?? 0) + (s.half_day_leave ?? 0)} />
        <Stat label="Absent or missing punch" value={(s.absent ?? 0) + (s.missing_punch ?? 0)} />
        <Stat label="Late" value={s.late ?? 0} />
      </div>
      <form className="mb-4 flex flex-wrap items-end gap-3 text-sm" action="/attendance/team">
        <label className="grid gap-1"><span className="text-fg-muted">Date</span><input className="h-9 rounded-md border border-border bg-surface px-2" type="date" name="date" defaultValue={date} /></label>
        <label className="grid gap-1"><span className="text-fg-muted">Status</span>
          <select className="h-9 rounded-md border border-border bg-surface px-2" name="status" defaultValue={sp.status ?? ''}>
            <option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {departments && departments.length > 0 && (
          <label className="grid gap-1"><span className="text-fg-muted">Department</span>
            <select className="h-9 rounded-md border border-border bg-surface px-2" name="departmentId" defaultValue={sp.departmentId ?? ''}>
              <option value="">All</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        {locations && locations.length > 0 && (
          <label className="grid gap-1"><span className="text-fg-muted">Location</span>
            <select className="h-9 rounded-md border border-border bg-surface px-2" name="locationId" defaultValue={sp.locationId ?? ''}>
              <option value="">All</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        <button className="h-9 rounded-md border border-border px-3 font-medium hover:bg-bg-subtle" type="submit">Show</button>
      </form>
      <Card>
        <CardHeader title={`${data.rows.length} ${data.rows.length === 1 ? 'person' : 'people'}`} />
        {data.rows.length === 0 ? (
          <EmptyState icon={<Users className="size-5" />} title="No one to show" description="Nobody you can see matches these filters on this date." />
        ) : (
          <Table>
            <THead><TR><TH>Employee</TH><TH>Department</TH><TH>Shift</TH><TH>Status</TH><TH>In</TH><TH>Out</TH><TH>Worked</TH><TH>Late</TH></TR></THead>
            <TBody>
              {data.rows.map((r) => {
                const tz = tzOf.get(r.location ?? '') ?? 'UTC';
                return (
                  <TR key={r.employeeId}>
                    <TD><Link className="font-medium hover:underline" href={`/attendance/day/${r.employeeId}/${date}`}>{r.employeeName}</Link><div className="text-xs text-fg-subtle">{r.employeeCode}</div></TD>
                    <TD className="text-fg-muted">{r.department ?? '—'}</TD>
                    <TD className="text-fg-muted">{r.shiftCode ?? '—'}</TD>
                    <TD><StatusPill status={r.status} /></TD>
                    <TD className="tabular">{time(r.firstIn, tz)}</TD>
                    <TD className="tabular">{time(r.lastOut, tz)}</TD>
                    <TD className="tabular">{hm(r.workedMinutes)}</TD>
                    <TD className="tabular">{r.lateMinutes ? `${r.lateMinutes}m` : '—'}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
    </>
  );
}

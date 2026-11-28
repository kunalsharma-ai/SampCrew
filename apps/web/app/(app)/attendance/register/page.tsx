import { Card, CardHeader, EmptyState, PageHeader, Stat } from '@crew/ui';
import { CalendarRange } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { STATUS_LABEL, todayIn } from '@/lib/time';
import type { Department, Location, Me } from '@/lib/types';

export const metadata: Metadata = { title: 'All employees attendance' };

interface RegisterRow {
  employeeId: string; employeeName: string; employeeCode: string; department: string | null;
  cells: ({ status: string; late: boolean } | null)[];
  totals: { present: number; absent: number; leave: number; late: number; off: number };
}

/** One letter per status so a month fits on one screen; the legend and each cell's title spell it out. */
const CODE: Record<string, { code: string; tone: string }> = {
  present: { code: 'P', tone: 'bg-success-subtle text-success' },
  in_progress: { code: 'P', tone: 'bg-success-subtle text-success' },
  half_day: { code: 'H', tone: 'bg-warning-subtle text-warning' },
  half_day_leave: { code: 'HL', tone: 'bg-info-subtle text-info' },
  absent: { code: 'A', tone: 'bg-danger-subtle text-danger' },
  missing_punch: { code: 'M', tone: 'bg-danger-subtle text-danger' },
  on_leave: { code: 'L', tone: 'bg-info-subtle text-info' },
  holiday: { code: 'HO', tone: 'bg-bg-subtle text-fg-subtle' },
  weekly_off: { code: 'W', tone: 'bg-bg-subtle text-fg-subtle' },
  not_joined: { code: '', tone: '' },
};

const monthLabel = (month: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

export default async function AttendanceRegisterPage({ searchParams }: { searchParams: Promise<{ month?: string; departmentId?: string; locationId?: string; q?: string }> }) {
  const sp = await searchParams;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month ?? '') ? sp.month! : todayIn((await load<Me>('/me')).tenant.timezone).slice(0, 7);
  const qs = new URLSearchParams({ month });
  for (const k of ['departmentId', 'locationId', 'q'] as const) if (sp[k]) qs.set(k, sp[k]!);
  const [data, departments, locations] = await Promise.all([
    load<{ month: string; dates: string[]; rows: RegisterRow[] }>(`/attendance/register?${qs}`),
    loadOptional<Department[]>('/org/departments'),
    loadOptional<Location[]>('/org/locations'),
  ]);
  const link = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    return `?${p}`;
  };
  const sum = (k: keyof RegisterRow['totals']) => data.rows.reduce((n, r) => n + r.totals[k], 0);
  const weekday = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  return (
    <>
      <PageHeader
        title="All employees attendance"
        description={`${monthLabel(month)}. Every employee you can see, one column per day. Open a name for that person's month, or a cell for the day in detail.`}
        actions={
          <div className="flex items-center gap-3 text-sm">
            <Link className="hover:underline" href={link({ month: shiftMonth(month, -1) })}>Previous month</Link>
            <Link className="hover:underline" href={link({ month: shiftMonth(month, 1) })}>Next month</Link>
            <Link className="font-medium text-accent hover:underline" href="/attendance/team">One day</Link>
          </div>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="People" value={data.rows.length} />
        <Stat label="Present days" value={sum('present')} />
        <Stat label="Absent or missing punch" value={sum('absent')} />
        <Stat label="Leave days" value={sum('leave')} />
        <Stat label="Late arrivals" value={sum('late')} />
      </div>
      <form className="mb-4 flex flex-wrap items-end gap-3 text-sm" action="/attendance/register">
        <label className="grid gap-1"><span className="text-fg-muted">Month</span><input className="h-9 rounded-md border border-border bg-surface px-2" type="month" name="month" defaultValue={month} /></label>
        <label className="grid gap-1"><span className="text-fg-muted">Name or code</span><input className="h-9 w-48 rounded-md border border-border bg-surface px-2" type="search" name="q" defaultValue={sp.q ?? ''} /></label>
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
        <CardHeader title={`${data.rows.length} ${data.rows.length === 1 ? 'person' : 'people'}`} description="Blank cells are days not counted yet or outside the person's employment." />
        {data.rows.length === 0 ? (
          <EmptyState icon={<CalendarRange className="size-5" />} title="No one to show" description="Nobody you can see matches these filters in this month." />
        ) : (
          <div className="relative overflow-x-auto" data-testid="attendance-register">
            <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-10 min-w-52 border-b border-border bg-surface px-3 py-2 text-left font-medium text-fg-muted">Employee</th>
                  {data.dates.map((d) => (
                    <th key={d} scope="col" className="w-8 border-b border-border px-0.5 py-1 text-center font-medium text-fg-subtle">
                      <div>{weekday(d)}</div><div className="tabular text-fg-muted">{Number(d.slice(8))}</div>
                    </th>
                  ))}
                  {(['P', 'A', 'L', 'Late'] as const).map((h) => <th key={h} scope="col" className="border-b border-border px-2 py-2 text-right font-medium text-fg-muted">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.employeeId} className="hover:bg-bg-subtle/60">
                    <th scope="row" className="sticky left-0 z-10 border-b border-border bg-surface px-3 py-1.5 text-left font-normal">
                      <Link className="font-medium hover:underline" href={`/attendance?employeeId=${r.employeeId}&month=${month}`}>{r.employeeName}</Link>
                      <div className="text-fg-subtle">{r.employeeCode}{r.department ? ` · ${r.department}` : ''}</div>
                    </th>
                    {r.cells.map((c, i) => {
                      const d = data.dates[i]!;
                      const look = c ? CODE[c.status] : undefined;
                      return (
                        <td key={d} className="border-b border-border p-0.5 text-center">
                          {c && look?.code ? (
                            <Link href={`/attendance/day/${r.employeeId}/${d}`} title={`${d}: ${STATUS_LABEL[c.status] ?? c.status}${c.late ? ', late' : ''}`}
                              className={`relative grid h-7 w-7 place-items-center rounded-md font-semibold ${look.tone}`}>
                              {look.code}
                              {c.late && <span aria-hidden className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-warning" />}
                            </Link>
                          ) : <span className="text-fg-subtle" aria-label="Not counted">·</span>}
                        </td>
                      );
                    })}
                    <td className="tabular border-b border-border px-2 text-right">{r.totals.present}</td>
                    <td className="tabular border-b border-border px-2 text-right">{r.totals.absent}</td>
                    <td className="tabular border-b border-border px-2 text-right">{r.totals.leave}</td>
                    <td className="tabular border-b border-border px-2 text-right">{r.totals.late}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ul className="flex flex-wrap gap-3 border-t border-border px-4 py-3 text-xs text-fg-muted" aria-label="Legend">
          {[['P', 'present'], ['H', 'half_day'], ['A', 'absent'], ['M', 'missing_punch'], ['L', 'on_leave'], ['HL', 'half_day_leave'], ['W', 'weekly_off'], ['HO', 'holiday']].map(([code, s]) => (
            <li key={s} className="flex items-center gap-1.5"><span className={`grid h-5 min-w-5 place-items-center rounded px-1 font-semibold ${CODE[s!]!.tone}`}>{code}</span>{STATUS_LABEL[s!]}</li>
          ))}
          <li className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-warning" />Late</li>
        </ul>
      </Card>
    </>
  );
}

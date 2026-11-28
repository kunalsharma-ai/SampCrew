'use client';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select } from '@crew/ui';
import { ATTENDANCE_REPORT_ABOUT, ATTENDANCE_REPORT_KINDS, ATTENDANCE_REPORT_LABEL, type AttendanceReportKind } from '@crew/contracts';
import { Download } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { monthBounds, plusDays } from '@/lib/attendance-period';
import { exportPeopleAction } from './actions';

type Format = 'xlsx' | 'csv' | 'docx' | 'pdf';
type Range = 'current' | 'day' | 'week' | 'month' | 'year' | 'custom';

const FORMATS: { key: Format; label: string }[] = [
  { key: 'xlsx', label: 'Excel (.xlsx)' }, { key: 'csv', label: 'CSV (.csv)' }, { key: 'docx', label: 'Word (.docx)' }, { key: 'pdf', label: 'PDF (.pdf)' },
];

/** Monday to Sunday around a date. */
const weekOf = (d: string) => {
  const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
  const from = plusDays(d, -dow);
  return { from, to: plusDays(from, 6) };
};

/**
 * "Export": the attendance report as Excel, CSV, Word or PDF, for a day, a week, a month, a year or any range, for
 * everyone the person may see or the employees they pick (issue #83). The API applies the same visibility, checks the
 * export permission and audits every download.
 */
export function ExportDialogButton({ period, filters = {}, label = 'Export', own = false }: { period: { from: string; to: string; today: string; label: string }; filters?: Record<string, string | undefined>; label?: string; own?: boolean }) {
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<Format>('xlsx');
  const [range, setRange] = useState<Range>('current');
  const [dayV, setDay] = useState(period.today);
  const [monthV, setMonth] = useState(period.today.slice(0, 7));
  const [yearV, setYear] = useState(period.today.slice(0, 4));
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  // A report template (27 Nov feedback): the standard export or a classic monthly report.
  const [report, setReport] = useState<AttendanceReportKind>('standard');
  const [include, setInclude] = useState<'all' | 'people' | 'records'>(filters.include === 'people' || filters.include === 'records' ? filters.include : 'all');
  const [who, setWho] = useState<'all' | 'chosen'>('all');
  const [chosen, setChosen] = useState<string[]>([]);
  const [find, setFind] = useState('');
  const [people, setPeople] = useState<{ employeeId: string; name: string; code: string; department: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, start] = useTransition();
  const fixedPerson = own || Boolean(filters.employeeId);

  const span = (() => {
    if (range === 'day') return { from: dayV, to: dayV };
    if (range === 'week') return weekOf(dayV);
    if (range === 'month') return monthBounds(monthV);
    if (range === 'year') return { from: `${yearV}-01-01`, to: `${yearV}-12-31` };
    if (range === 'custom') return { from, to };
    return { from: period.from, to: period.to };
  })();

  useEffect(() => {
    if (!open || fixedPerson || who !== 'chosen') return;
    const id = window.setTimeout(() => start(async () => {
      const r = await exportPeopleAction(span.from, span.to, find.trim());
      if (r.ok && r.data) setPeople(r.data.rows); else if (!r.ok) setError(r.message);
    }), 250);
    return () => window.clearTimeout(id);
  }, [open, who, find, span.from, span.to, fixedPerson]);

  const bad = !span.from || !span.to || span.to < span.from ? 'Choose a start and an end date.'
    : (Date.parse(span.to) - Date.parse(span.from)) / 86_400_000 > 366 ? 'Export at most a year at a time.'
      : who === 'chosen' && !fixedPerson && !chosen.length ? 'Choose at least one employee.' : null;
  const href = (() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    p.set('from', span.from); p.set('to', span.to); p.set('format', format);
    if (!filters.include || filters.include !== 'hr_workspaces') p.set('include', include);
    if (report !== 'standard') p.set('report', report);
    if (who === 'chosen' && !fixedPerson && chosen.length) p.set('employeeIds', chosen.join(','));
    return `/attendance-export?${p}`;
  })();

  return (
    <>
      <Button size="sm" onClick={() => { setError(null); setOpen(true); }} data-testid="attendance-export"><Download className="size-4" aria-hidden /> {label}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Export attendance" description="Download the attendance report. Only what you may see is included, and every export is recorded." size="lg">
        <div className="grid gap-4" data-testid="attendance-export-dialog">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Format">{(p) => (
              <Select {...p} value={format} onChange={(e) => setFormat(e.target.value as Format)} data-testid="export-format">
                {FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              </Select>
            )}</Field>
            <Field label="Period">{(p) => (
              <Select {...p} value={range} onChange={(e) => setRange(e.target.value as Range)} data-testid="export-range">
                <option value="current">As on screen ({period.label})</option>
                <option value="day">One day</option>
                <option value="week">One week</option>
                <option value="month">One month</option>
                <option value="year">One year</option>
                <option value="custom">From and to dates</option>
              </Select>
            )}</Field>
          </div>
          {(range === 'day' || range === 'week') && <Field label={range === 'day' ? 'Day' : 'Any day in the week'} hint={range === 'week' ? `${span.from} to ${span.to}` : undefined}>{(p) => <Input {...p} type="date" value={dayV} onChange={(e) => setDay(e.target.value)} data-testid="export-day" />}</Field>}
          {range === 'month' && <Field label="Month">{(p) => <Input {...p} type="month" value={monthV} onChange={(e) => setMonth(e.target.value)} data-testid="export-month" />}</Field>}
          {range === 'year' && <Field label="Year">{(p) => (
            <Select {...p} value={yearV} onChange={(e) => setYear(e.target.value)} data-testid="export-year">
              {Array.from({ length: 6 }, (_, i) => String(Number(period.today.slice(0, 4)) - i)).map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          )}</Field>}
          {range === 'custom' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="From">{(p) => <Input {...p} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field label="To">{(p) => <Input {...p} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            </div>
          )}
          {filters.include !== 'hr_workspaces' && (
            <Field label="Report" hint={ATTENDANCE_REPORT_ABOUT[report]}>{(p) => (
              <Select {...p} value={report} onChange={(e) => setReport(e.target.value as AttendanceReportKind)} data-testid="export-report">
                {ATTENDANCE_REPORT_KINDS.map((k) => <option key={k} value={k}>{ATTENDANCE_REPORT_LABEL[k]}</option>)}
              </Select>
            )}</Field>
          )}
          {filters.include !== 'hr_workspaces' && report === 'standard' && (
            <Field label="What to include" hint={format === 'csv' || format === 'pdf' ? 'A CSV or PDF holds one table: the day-by-day rows when they are included, else the totals.' : undefined}>{(p) => (
              <Select {...p} value={include} onChange={(e) => setInclude(e.target.value as 'all')} data-testid="export-include">
                <option value="all">Totals per person and every day</option>
                <option value="people">Totals per person</option>
                <option value="records">Every day (date-wise)</option>
              </Select>
            )}</Field>
          )}
          {!fixedPerson && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-[0.8125rem] font-medium">Employees</legend>
              <div className="flex flex-wrap gap-4 text-[0.8125rem]">
                <label className="flex items-center gap-2"><input type="radio" name="export-who" checked={who === 'all'} onChange={() => setWho('all')} /> Everyone I can see</label>
                <label className="flex items-center gap-2"><input type="radio" name="export-who" checked={who === 'chosen'} onChange={() => setWho('chosen')} data-testid="export-who-chosen" /> Choose employees</label>
              </div>
              {who === 'chosen' && (
                <div className="grid gap-2">
                  <Input placeholder="Search by name or employee ID" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Search employees" />
                  <div className="flex items-center justify-between text-xs text-fg-subtle">
                    <span>{chosen.length} chosen</span>
                    <span className="flex gap-2">
                      <button type="button" className="font-medium text-accent hover:underline" onClick={() => setChosen((c) => [...new Set([...c, ...people.map((x) => x.employeeId)])])}>Select all shown</button>
                      <button type="button" className="font-medium text-accent hover:underline" onClick={() => setChosen([])}>Clear</button>
                    </span>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-lg border border-border p-2" data-testid="export-people">
                    {people.map((x) => (
                      <Checkbox key={x.employeeId} label={`${x.name}${x.code ? ` (${x.code})` : ''}`} description={x.department ?? undefined} checked={chosen.includes(x.employeeId)}
                        onChange={(e) => setChosen((c) => (e.target.checked ? [...c, x.employeeId] : c.filter((y) => y !== x.employeeId)))} />
                    ))}
                    {!people.length && <p className="text-xs text-fg-subtle">{loading ? 'Loading…' : 'Nobody matches.'}</p>}
                  </div>
                </div>
              )}
            </fieldset>
          )}
          {bad && <p className="text-[0.8125rem] text-danger" role="alert">{bad}</p>}
          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
            {bad ? <Button disabled>Download</Button> : (
              <a href={href} download onClick={() => window.setTimeout(() => setOpen(false), 300)} data-testid="export-download"
                className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90">
                <Download className="size-4" aria-hidden /> Download {FORMATS.find((f) => f.key === format)!.label.split(' ')[0]}
              </a>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}

import { ATTENDANCE_BUCKET_LABEL, type AttendanceBucket, type AttendanceTotals, type AttendanceTrendPoint } from '@crew/contracts';
import { Badge, Card } from '@crew/ui';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import Link from 'next/link';
import { dateLabel, type Period, periodQuery } from '@/lib/attendance-period';

/** Building blocks shared by the Attendance pages of every level (server components: no state, links only). */

const BUCKET_TONE: Record<AttendanceBucket, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  present: 'success', half_day: 'warning', absent: 'danger', leave: 'info', holiday: 'neutral', weekend: 'neutral', unmarked: 'neutral',
};

export function BucketBadge({ bucket }: { bucket: AttendanceBucket | null | undefined }) {
  if (!bucket) return <span className="text-fg-subtle">-</span>;
  return <Badge tone={BUCKET_TONE[bucket]} dot>{ATTENDANCE_BUCKET_LABEL[bucket]}</Badge>;
}

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${n}%`);

/** The attendance percentage as a ring: green from 90%, amber from 75%, red below. */
export function PercentRing({ value, size = 88, label }: { value: number | null; size?: number; label?: string }) {
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  const tone = value === null ? 'text-fg-subtle' : v >= 90 ? 'text-success' : v >= 75 ? 'text-warning' : 'text-danger';
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }} role="img" aria-label={`${label ?? 'Attendance'} ${value === null ? 'not available' : `${value}%`}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={7} className="stroke-bg-subtle" stroke="currentColor" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={7} strokeLinecap="round" stroke="currentColor" className={tone}
          strokeDasharray={`${(Math.min(100, v) / 100) * c} ${c}`} />
      </svg>
      <span className="absolute text-lg font-semibold tabular text-fg">{pct(value)}</span>
    </div>
  );
}

/** Small numbered tile, consistent across the overview. */
export function Tile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'success' | 'danger' | 'info' | 'warning' }) {
  const bar = tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : tone === 'info' ? 'bg-info' : tone === 'warning' ? 'bg-warning' : 'bg-accent';
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-surface px-4 py-3">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${bar}`} />
      <div className="text-[0.8125rem] text-fg-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular text-fg">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-fg-subtle">{hint}</div>}
    </div>
  );
}

/** Working days, present, absent, leave and the rest for one person or group. */
export function TotalsTiles({ totals }: { totals: AttendanceTotals }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      <Tile label="Working days" value={totals.workingDays} hint={`${totals.weekends} weekend, ${totals.holidays} holiday`} />
      <Tile label="Present" value={totals.present} tone="success" hint={totals.halfDays ? `${totals.halfDays} half days` : undefined} />
      <Tile label="Absent" value={totals.absent} tone="danger" />
      <Tile label="Leave" value={totals.leave} tone="info" />
      <Tile label="Late days" value={totals.late} tone="warning" />
      <Tile label="Not counted yet" value={totals.unmarked} hint="Not in the percentage" />
    </div>
  );
}

/**
 * Daily attendance as bars: each bar is that day's attendance percentage, coloured the same way as the ring. The
 * numbers are also in a table for screen readers.
 */
export function TrendChart({ points, title = 'Daily attendance' }: { points: AttendanceTrendPoint[]; title?: string }) {
  const shown = points.filter((p) => p.percent !== null);
  if (!shown.length) return <p className="px-5 pb-5 text-sm text-fg-muted">No working days counted in this period yet.</p>;
  const w = 640;
  const h = 160;
  const pad = { l: 32, r: 8, t: 8, b: 22 };
  const step = (w - pad.l - pad.r) / points.length;
  const bw = Math.max(2, Math.min(22, step * 0.7));
  const y = (v: number) => pad.t + (1 - v / 100) * (h - pad.t - pad.b);
  const every = Math.max(1, Math.ceil(points.length / 10));
  return (
    <figure className="px-5 pb-5">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-44 w-full" role="img" aria-label={`${title}, ${points[0]!.date} to ${points.at(-1)!.date}`}>
        {[0, 50, 100].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={w - pad.r} y1={y(g)} y2={y(g)} className="stroke-border" stroke="currentColor" strokeDasharray={g === 0 ? undefined : '3 4'} />
            <text x={pad.l - 6} y={y(g) + 4} textAnchor="end" className="fill-fg-subtle text-[10px]">{g}%</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = pad.l + i * step + (step - bw) / 2;
          const v = p.percent;
          const tone = v === null ? '' : v >= 90 ? 'fill-success' : v >= 75 ? 'fill-warning' : 'fill-danger';
          return (
            <g key={p.date}>
              {v !== null && <rect x={x} y={y(v)} width={bw} height={Math.max(1, y(0) - y(v))} rx={2} className={tone}><title>{`${dateLabel(p.date)}: ${v}% (present ${p.present}, absent ${p.absent}, leave ${p.leave})`}</title></rect>}
              {i % every === 0 && <text x={x + bw / 2} y={h - 6} textAnchor="middle" className="fill-fg-subtle text-[10px]">{Number(p.date.slice(8))}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">
        <table>
          <thead><tr><th>Date</th><th>Attendance</th><th>Present</th><th>Absent</th><th>Leave</th></tr></thead>
          <tbody>{points.map((p) => <tr key={p.date}><td>{p.date}</td><td>{pct(p.percent)}</td><td>{p.present}</td><td>{p.absent}</td><td>{p.leave}</td></tr>)}</tbody>
        </table>
      </figcaption>
    </figure>
  );
}

const PERIODS: { key: string; label: string }[] = [
  { key: 'today', label: 'Today' }, { key: 'week', label: 'This week' }, { key: 'month', label: 'This month' }, { key: 'previous_month', label: 'Previous month' },
];

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  return `?${p}`;
};

/** The period picker: quick periods as links, then a month and a custom range (plain GET forms, so links can be shared). */
export function PeriodBar({ period, path, keep = {} }: { period: Period; path: string; keep?: Record<string, string | undefined> }) {
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3 text-sm" data-testid="period-bar">
      <nav aria-label="Period" className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
        {PERIODS.map((p) => (
          <Link key={p.key} href={`${path}${qs({ ...keep, period: p.key })}`} aria-current={period.key === p.key ? 'true' : undefined}
            className={`rounded-md px-3 py-1.5 font-medium ${period.key === p.key ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-bg-subtle'}`}>{p.label}</Link>
        ))}
      </nav>
      <form action={path} className="flex flex-wrap items-end gap-2">
        {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
        <label className="grid gap-1"><span className="text-xs text-fg-muted">Month</span>
          <input className="h-9 rounded-md border border-border bg-surface px-2" type="month" name="month" defaultValue={period.month ?? ''} aria-label="Month" />
        </label>
        <button className="h-9 rounded-md border border-border px-3 font-medium hover:bg-bg-subtle" type="submit">Show month</button>
      </form>
      <form action={path} className="flex flex-wrap items-end gap-2">
        {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
        <input type="hidden" name="period" value="custom" />
        <label className="grid gap-1"><span className="text-xs text-fg-muted">From</span>
          <input className="h-9 min-w-0 max-w-[10.5rem] rounded-md border border-border bg-surface px-2" type="date" name="from" defaultValue={period.from} aria-label="From date" />
        </label>
        <label className="grid gap-1"><span className="text-xs text-fg-muted">To</span>
          <input className="h-9 min-w-0 max-w-[10.5rem] rounded-md border border-border bg-surface px-2" type="date" name="to" defaultValue={period.to} aria-label="To date" />
        </label>
        <button className="h-9 rounded-md border border-border px-3 font-medium hover:bg-bg-subtle" type="submit">Show range</button>
      </form>
    </div>
  );
}

/** "Export to Excel": downloads the .xlsx the API builds for exactly these filters. */
export function ExportButton({ period, filters = {}, label = 'Export to Excel' }: { period: Period; filters?: Record<string, string | undefined>; label?: string }) {
  return (
    <a href={`/attendance-export${qs({ from: period.from, to: period.to, ...filters })}`} download
      className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90">
      <Download className="size-4" aria-hidden /> {label}
    </a>
  );
}

export function Pager({ page, pageSize, total, href }: { page: number; pageSize: number; total: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <div className="border-t border-border px-5 py-3 text-xs text-fg-muted">{total} {total === 1 ? 'row' : 'rows'}</div>;
  return (
    <nav aria-label="Pages" className="flex items-center justify-between border-t border-border px-5 py-3 text-sm">
      <span className="text-fg-muted">{(page - 1) * pageSize + 1} to {Math.min(total, page * pageSize)} of {total}</span>
      <span className="flex items-center gap-1">
        {page > 1 ? <Link className="rounded-md p-1.5 hover:bg-bg-subtle" aria-label="Previous page" href={href(page - 1)}><ChevronLeft className="size-4" /></Link> : <span className="p-1.5 text-fg-subtle"><ChevronLeft className="size-4" /></span>}
        <span className="tabular px-2">Page {page} of {pages}</span>
        {page < pages ? <Link className="rounded-md p-1.5 hover:bg-bg-subtle" aria-label="Next page" href={href(page + 1)}><ChevronRight className="size-4" /></Link> : <span className="p-1.5 text-fg-subtle"><ChevronRight className="size-4" /></span>}
      </span>
    </nav>
  );
}

export { periodQuery, qs };

/** The section cards on the overview: a big clickable card leading to a section page. */
export function SectionCard({ href, title, description, stats, testId }: { href: string; title: string; description: string; stats: { label: string; value: React.ReactNode }[]; testId?: string }) {
  return (
    <Link href={href} data-testid={testId} className="group block focus-visible:outline-none">
      <Card className="h-full p-5 transition group-hover:border-accent group-focus-visible:ring-2 group-focus-visible:ring-accent">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[0.9375rem] font-semibold text-fg">{title}</h2>
            <p className="mt-1 text-[0.8125rem] text-fg-muted">{description}</p>
          </div>
          <ChevronRight className="mt-0.5 size-5 shrink-0 text-fg-subtle group-hover:text-accent" aria-hidden />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3">
          {stats.map((s) => (
            <div key={s.label}><dt className="text-xs text-fg-muted">{s.label}</dt><dd className="text-lg font-semibold tabular text-fg">{s.value}</dd></div>
          ))}
        </dl>
      </Card>
    </Link>
  );
}

/** The attendance percentage in a table cell: a short bar and the number. */
export function PercentBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-fg-subtle">-</span>;
  const tone = value >= 90 ? 'bg-success' : value >= 75 ? 'bg-warning' : 'bg-danger';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-bg-subtle sm:block" aria-hidden><span className={`block h-full ${tone}`} style={{ width: `${Math.min(100, value)}%` }} /></span>
      <span className="tabular font-medium">{value}%</span>
    </span>
  );
}

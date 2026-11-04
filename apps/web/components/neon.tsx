import type { ListItem, OverviewChart, OverviewTile, SeriesPoint, Slice } from '@crew/contracts';
import { Card, cn } from '@crew/ui';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Circle } from 'lucide-react';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { ICONS } from '@/lib/icons';

/*
 * Shared pieces of the neon dashboard design: KPI tiles, chart panels and the quick action bar. They are plain
 * server-renderable components (no state), styled by @crew/ui/styles.css so the Classic style and every theme
 * preset restyle them without code changes. Every chart has a text alternative for screen readers.
 */

const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--fg-subtle)'];

export function formatValue(value: number | null, unit?: string, currency?: string, compact = true): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  if (unit === 'percent') return `${Math.round(value * 10) / 10}%`;
  if (unit === 'days') return `${value}d`;
  if (unit === 'rating') return value.toFixed(1);
  if (unit === 'money' && currency) {
    // Lakh and crore for rupees, as Indian payroll teams read them.
    const locale = currency === 'INR' ? 'en-IN' : 'en-GB';
    return new Intl.NumberFormat(locale, { style: 'currency', currency, notation: compact && Math.abs(value) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: compact && Math.abs(value) >= 100000 ? 2 : 0 }).format(value);
  }
  return new Intl.NumberFormat('en-GB', { notation: compact && Math.abs(value) >= 100000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

// ---------------------------------------------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------------------------------------------

export function KpiTile({ tile }: { tile: OverviewTile }) {
  const Icon = ICONS[tile.icon] ?? Circle;
  const delta = tile.delta ?? null;
  const good = delta === null || delta === 0 ? null : tile.invert ? delta < 0 : delta > 0;
  const deltaText = delta === null ? null : `${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${formatValue(Math.abs(delta), tile.unit === 'percent' ? undefined : tile.unit, tile.currency)}${tile.unit === 'percent' ? ' pts' : ''}`;
  const body = (
    <>
      <div className="relative flex items-start gap-3">
        <span className="crew-tile-icon flex size-10 shrink-0 items-center justify-center rounded-xl"><Icon className="size-5" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[1.6rem] font-bold leading-tight tabular-nums" data-testid={`tile-${tile.key}`}>{formatValue(tile.value, tile.unit, tile.currency)}</div>
          <div className="crew-tile-muted truncate text-[0.8125rem] font-medium">{tile.label}</div>
        </div>
      </div>
      <div className="relative mt-2 flex min-h-5 items-center justify-between gap-2 text-[0.6875rem]">
        <span className="crew-tile-muted truncate">{tile.hint}</span>
        {deltaText && (
          <span className="crew-tile-chip inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold tabular-nums" aria-label={`Change ${deltaText}${good === null ? '' : good ? ', better' : ', worse'}`}>
            {delta! > 0 ? <ArrowUpRight className="size-3" aria-hidden /> : delta! < 0 ? <ArrowDownRight className="size-3" aria-hidden /> : null}{deltaText}
          </span>
        )}
      </div>
    </>
  );
  const cls = cn('crew-tile block p-4 transition-transform duration-150', `crew-tile-${tile.tone}`, tile.href && 'hover:-translate-y-0.5 focus-visible:-translate-y-0.5');
  return tile.href ? <Link href={tile.href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function KpiRow({ tiles }: { tiles: OverviewTile[] }) {
  if (!tiles.length) return null;
  return (
    <ul className={cn('grid gap-3 sm:grid-cols-2', tiles.length >= 5 ? 'lg:grid-cols-3 xl:grid-cols-5' : 'xl:grid-cols-4')} aria-label="Key figures">
      {tiles.map((t) => <li key={t.key}><KpiTile tile={t} /></li>)}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------------------------------------------

function SrTable({ rows }: { rows: [string, string][] }) {
  return <ul className="sr-only">{rows.map(([k, v], i) => <li key={i}>{k}: {v}</li>)}</ul>;
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
};

export function LineChart({ points, unit, currency, height = 180 }: { points: SeriesPoint[]; unit?: string; currency?: string; height?: number }) {
  const id = useId().replace(/:/g, '');
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const W = 600;
  const H = 200;
  const x = (i: number) => (points.length <= 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (v: number) => H - (v / max) * (H - 10) - 5;
  // A gentle curve through the points (Catmull-Rom converted to cubic Béziers).
  const at = (i: number) => {
    const k = Math.max(0, Math.min(points.length - 1, i));
    return [x(k), y(points[k]!.value)] as const;
  };
  const d = points.map((_, i) => {
    const [px, py] = at(i);
    if (i === 0) return `M${px},${py}`;
    const p0 = at(i - 2), p1 = at(i - 1), p3 = at(i + 1);
    // Control points are kept between the two ends of the segment, so the curve never dips below a real value.
    const lo = Math.min(p1[1], py), hi = Math.max(p1[1], py);
    const clamp = (v: number) => Math.max(lo, Math.min(hi, v));
    return `C${p1[0] + (px - p0[0]) / 6},${clamp(p1[1] + (py - p0[1]) / 6)} ${px - (p3[0] - p1[0]) / 6},${clamp(py - (p3[1] - p1[1]) / 6)} ${px},${py}`;
  }).join(' ');
  const last = points[points.length - 1];
  const ticks = [max, max / 2, 0];
  return (
    <figure className="m-0">
      <div className="flex gap-2">
        <div className="flex flex-col justify-between py-0.5 text-right text-[0.6875rem] text-fg-subtle tabular-nums" style={{ height }} aria-hidden>
          {ticks.map((t) => <span key={t}>{formatValue(t, unit, currency)}</span>)}
        </div>
        <div className="relative min-w-0 flex-1" style={{ height }}>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
            <defs>
              <linearGradient id={`a${id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.35" />
                <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`s${id}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset="0%" stopColor="var(--chart-1)" />
                <stop offset="100%" stopColor="var(--chart-2)" />
              </linearGradient>
            </defs>
            {[0.5, 1].map((f) => <line key={f} x1="0" x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />)}
            {points.length > 1 && <path d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#a${id})`} />}
            <path d={d} fill="none" stroke={`url(#s${id})`} strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {last && (
            <span className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-chart-2 shadow-[0_0_0_4px_color-mix(in_srgb,var(--chart-2)_30%,transparent)]" style={{ left: `${(x(points.length - 1) / W) * 100}%`, top: `${(y(last.value) / H) * 100}%` }} aria-hidden />
          )}
        </div>
      </div>
      <div className="ml-8 mt-1.5 flex justify-between text-[0.6875rem] text-fg-subtle" aria-hidden>{points.map((p, i) => <span key={i}>{p.label}</span>)}</div>
      <SrTable rows={points.map((p) => [p.label, formatValue(p.value, unit, currency, false)])} />
    </figure>
  );
}

export function BarChart({ points, unit, currency, height = 180 }: { points: SeriesPoint[]; unit?: string; currency?: string; height?: number }) {
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  return (
    <figure className="m-0">
      <div className="flex items-end gap-2 sm:gap-3" style={{ height }} aria-hidden>
        {points.map((p, i) => (
          <div key={i} className="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[0.6875rem] font-semibold tabular-nums text-fg-muted">{formatValue(p.value, unit, currency)}</span>
            <span
              className="w-full max-w-12 rounded-t-lg rounded-b-sm transition-[height] duration-500"
              style={{ height: `${Math.max(2, (p.value / max) * 100 * 0.85)}%`, background: `linear-gradient(180deg, ${SERIES[i % 5]}, color-mix(in srgb, ${SERIES[i % 5]} 55%, transparent))`, boxShadow: `0 8px 20px -10px ${SERIES[i % 5]}` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-2 sm:gap-3 text-[0.6875rem] text-fg-subtle" aria-hidden>{points.map((p, i) => <span key={i} className="min-w-0 flex-1 truncate text-center" title={p.label}>{p.label}</span>)}</div>
      <SrTable rows={points.map((p) => [p.label, formatValue(p.value, unit, currency, false)])} />
    </figure>
  );
}

export function DonutChart({ slices, centerValue, centerLabel, unit, currency }: { slices: Slice[]; centerValue: string; centerLabel: string; unit?: string; currency?: string }) {
  const total = slices.reduce((t, s) => t + s.value, 0);
  const R = 42;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const center = unit === 'money' ? formatValue(Number(centerValue), unit, currency) : centerValue;
  return (
    <figure className="m-0 flex flex-col items-center gap-5 sm:flex-row">
      <div className="relative size-40 shrink-0">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--bg-subtle)" strokeWidth="12" />
          {total > 0 && slices.map((s, i) => {
            const len = (s.value / total) * C;
            const el = <circle key={i} cx="50" cy="50" r={R} fill="none" stroke={s.color ?? SERIES[i % SERIES.length]} strokeWidth="12" strokeDasharray={`${Math.max(0, len - 0.8)} ${C}`} strokeDashoffset={-offset} />;
            offset += len;
            return el;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-xl font-bold tabular-nums">{center}</span>
          <span className="text-[0.6875rem] text-fg-subtle">{centerLabel}</span>
        </div>
      </div>
      <ul className="grid w-full min-w-0 gap-1.5 text-[0.8125rem]">
        {slices.map((s, i) => {
          const label = <><span className="size-2.5 shrink-0 rounded-full" style={{ background: s.color ?? SERIES[i % SERIES.length] }} aria-hidden /><span className="min-w-0 flex-1 truncate">{s.label}</span></>;
          return (
            <li key={i} className="flex items-center gap-2">
              {s.href ? <Link href={s.href} className="flex min-w-0 flex-1 items-center gap-2 hover:text-accent">{label}</Link> : label}
              <span className="tabular-nums text-fg-muted">{total ? `${Math.round((s.value / total) * 100)}%` : '–'}</span>
              <span className="sr-only">, {formatValue(s.value, unit, currency, false)}</span>
            </li>
          );
        })}
        {!slices.length && <li className="text-fg-subtle">Nothing to show yet</li>}
      </ul>
    </figure>
  );
}

export function RingGauge({ value, label, caption }: { value: number | null; label: string; caption?: string }) {
  const id = useId().replace(/:/g, '');
  const R = 42;
  const C = 2 * Math.PI * R;
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <figure className="m-0 flex flex-col items-center gap-2">
      <div className="relative size-40">
        <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden>
          <defs>
            <linearGradient id={`r${id}`} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" />
              <stop offset="100%" stopColor="var(--chart-2)" />
            </linearGradient>
          </defs>
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--bg-subtle)" strokeWidth="10" />
          <circle cx="50" cy="50" r={R} fill="none" stroke={`url(#r${id})`} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(v / 100) * C} ${C}`} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-2xl font-bold tabular-nums">{value === null ? '–' : `${Math.round(v * 10) / 10}%`}</span>
          <span className="text-[0.6875rem] text-fg-subtle">{label}</span>
        </div>
      </div>
      {caption && <figcaption className="text-center text-[0.75rem] text-fg-muted">{caption}</figcaption>}
    </figure>
  );
}

export function MeterRows({ rows, caption }: { rows: { label: string; value: number; count: number }[]; caption?: string }) {
  return (
    <figure className="m-0">
      <ul className="grid gap-3">
        {rows.map((r, i) => (
          <li key={r.label} className="grid grid-cols-[minmax(0,10rem)_1fr_2.75rem] items-center gap-3 text-[0.8125rem]">
            <span className="truncate">{r.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-bg-subtle" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${r.value}%`, background: `linear-gradient(90deg, ${SERIES[i % 5]}, color-mix(in srgb, ${SERIES[i % 5]} 60%, var(--chart-2)))` }} />
            </span>
            <span className="text-right tabular-nums text-fg-muted">{r.value}%<span className="sr-only"> ({r.count})</span></span>
          </li>
        ))}
      </ul>
      {caption && <figcaption className="mt-3 text-[0.75rem] text-fg-subtle">{caption}</figcaption>}
    </figure>
  );
}

const DOT = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info', neutral: 'bg-fg-subtle' } as const;

export function ItemList({ items, empty }: { items: ListItem[]; empty: string }) {
  if (!items.length) return <p className="py-6 text-center text-[0.8125rem] text-fg-subtle">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.map((it, i) => {
        const inner = (
          <>
            <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[it.tone ?? 'neutral'])} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.8125rem] font-medium">{it.label}</span>
              {it.detail && <span className="block truncate text-[0.75rem] text-fg-subtle">{it.detail}</span>}
            </span>
            {it.value && <span className="shrink-0 text-[0.75rem] tabular-nums text-fg-muted">{/^\d{4}-\d{2}-\d{2}T/.test(it.value) ? new Date(it.value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : it.value}</span>}
          </>
        );
        return <li key={i}>{it.href ? <Link href={it.href} className="flex items-start gap-3 py-2.5 hover:text-accent">{inner}</Link> : <div className="flex items-start gap-3 py-2.5">{inner}</div>}</li>;
      })}
    </ul>
  );
}

export function ChartPanel({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('flex min-w-0 flex-col p-5', className)}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
        {action}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </Card>
  );
}

export function OverviewChartView({ chart }: { chart: OverviewChart }) {
  const more = 'href' in chart && chart.href ? <Link href={chart.href} className="inline-flex items-center gap-1 text-[0.75rem] font-medium text-accent hover:underline">View all <ArrowRight className="size-3" aria-hidden /></Link> : undefined;
  let body: ReactNode;
  switch (chart.kind) {
    case 'line': body = <><LineChart points={chart.points} unit={chart.unit} currency={chart.currency} />{chart.caption && <p className="mt-2 text-[0.75rem] text-fg-subtle">{chart.caption}</p>}</>; break;
    case 'bar': body = <><BarChart points={chart.points} unit={chart.unit} currency={chart.currency} />{chart.caption && <p className="mt-2 text-[0.75rem] text-fg-subtle">{chart.caption}</p>}</>; break;
    case 'donut': body = <DonutChart slices={chart.slices} centerValue={chart.centerValue} centerLabel={chart.centerLabel} unit={chart.unit} currency={chart.currency} />; break;
    case 'ring': body = <RingGauge value={chart.value} label={chart.label} caption={chart.caption} />; break;
    case 'meter': body = <MeterRows rows={chart.rows} caption={chart.caption} />; break;
    case 'list': body = <ItemList items={chart.items} empty={chart.empty} />; break;
  }
  return <ChartPanel title={chart.title} action={more}>{body}</ChartPanel>;
}

// ---------------------------------------------------------------------------------------------------------------
// Quick action bar
// ---------------------------------------------------------------------------------------------------------------

export interface BarAction { label: string; href: string; icon: string }

export function QuickBar({ actions, label = 'Quick actions' }: { actions: BarAction[]; label?: string }) {
  if (!actions.length) return null;
  return (
    <nav aria-label={label} className="crew-card crew-quickbar flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-2 shadow-card">
      {actions.map((a) => {
        const Icon = ICONS[a.icon] ?? ArrowRight;
        return (
          <Link key={a.href + a.label} href={a.href} className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[0.8125rem] font-medium text-fg-muted transition-colors hover:bg-accent-subtle hover:text-accent">
            <span className="flex size-6 items-center justify-center rounded-lg bg-accent-subtle text-accent"><Icon className="size-3.5" aria-hidden /></span>
            {a.label}
          </Link>
        );
      })}
    </nav>
  );
}

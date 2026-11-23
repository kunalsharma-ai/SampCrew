'use client';
import { cn } from '@crew/ui';
import { useId, useMemo, useState } from 'react';

/*
 * Small SVG charts for the Console (no chart library): a line/area chart for trends, a bar chart for amounts per
 * period, a donut for shares and a sparkline for tiles. Each takes plain points and draws with the --chart-* colours,
 * so light and dark mode both work. Every chart has a text table for screen readers.
 */

export interface Point { label: string; values: Record<string, number> }
export interface SeriesKey { key: string; label: string }
const COLOR = (i: number) => `var(--chart-${(i % 6) + 1})`;

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
/** Axis and tooltip numbers: compact counts, or compact money when a currency is given (props stay serialisable). */
const formatter = (currency?: string) => (currency ? (n: number) => { try { return new Intl.NumberFormat('en', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(n); } catch { return compact(n); } } : compact);

function Legend({ keys, hidden, toggle }: { keys: SeriesKey[]; hidden: Set<string>; toggle: (k: string) => void }) {
  if (keys.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 pb-2 text-[11.5px]">
      {keys.map((k, i) => (
        <button key={k.key} type="button" onClick={() => toggle(k.key)} aria-pressed={!hidden.has(k.key)} className={cn('inline-flex items-center gap-1.5', hidden.has(k.key) ? 'text-fg-subtle line-through' : 'text-fg-muted')}>
          <span aria-hidden className="size-2.5 rounded-sm" style={{ background: COLOR(i) }} />{k.label}
        </button>
      ))}
    </div>
  );
}

function SrTable({ points, keys, format }: { points: Point[]; keys: SeriesKey[]; format: (n: number) => string }) {
  return (
    <table className="sr-only">
      <thead><tr><th>Period</th>{keys.map((k) => <th key={k.key}>{k.label}</th>)}</tr></thead>
      <tbody>{points.map((p) => <tr key={p.label}><td>{p.label}</td>{keys.map((k) => <td key={k.key}>{format(p.values[k.key] ?? 0)}</td>)}</tr>)}</tbody>
    </table>
  );
}

/** A line chart (with a soft area under the first series) for counts or money over time. */
export function TrendChart({ points, keys, height = 220, currency, area = true, testId }: { points: Point[]; keys: SeriesKey[]; height?: number; currency?: string; area?: boolean; testId?: string }) {
  const format = formatter(currency);
  const id = useId();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const shown = keys.filter((k) => !hidden.has(k.key));
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 10, t: 10, b: 24 };
  const max = niceMax(Math.max(0, ...points.flatMap((p) => shown.map((k) => p.values[k.key] ?? 0))));
  const x = (i: number) => pad.l + (points.length <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (points.length - 1));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const every = Math.max(1, Math.ceil(points.length / 8));
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else if (shown.length > 1) n.add(k); return n; });
  if (!points.length) return <EmptyChart height={height} />;
  return (
    <div data-testid={testId}>
      <Legend keys={keys} hidden={hidden} toggle={toggle} />
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Chart of ${keys.map((k) => k.label).join(', ')}`} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id={`${id}-g`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={COLOR(keys.indexOf(shown[0]!))} stopOpacity="0.22" /><stop offset="1" stopColor={COLOR(keys.indexOf(shown[0]!))} stopOpacity="0" /></linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--chart-grid)" />
              <text x={pad.l - 6} y={y(max * f) + 3} textAnchor="end" className="fill-fg-subtle text-[10px]">{format(max * f)}</text>
            </g>
          ))}
          {points.map((p, i) => (i % every === 0 || i === points.length - 1 ? <text key={p.label + i} x={x(i)} y={H - 6} textAnchor="middle" className="fill-fg-subtle text-[10px]">{p.label}</text> : null))}
          {shown.map((k, si) => {
            const ci = keys.indexOf(k);
            const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.values[k.key] ?? 0).toFixed(1)}`).join('');
            return (
              <g key={k.key}>
                {area && si === 0 && <path d={`${d}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={`url(#${id}-g)`} />}
                <path d={d} fill="none" stroke={COLOR(ci)} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                {points.length <= 40 && points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.values[k.key] ?? 0)} r={hover === i ? 3.5 : 2} fill={COLOR(ci)} />)}
              </g>
            );
          })}
          {points.map((_, i) => <rect key={i} x={x(i) - (W - pad.l - pad.r) / Math.max(1, points.length - 1) / 2} y={pad.t} width={(W - pad.l - pad.r) / Math.max(1, points.length - 1)} height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} />)}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--border-strong)" strokeDasharray="3 3" />}
        </svg>
        {hover !== null && points[hover] && (
          <div className="pointer-events-none absolute top-1 z-10 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-[11.5px] shadow-pop" style={{ left: `clamp(0px, calc(${(x(hover) / W) * 100}% - 70px), calc(100% - 150px))` }}>
            <div className="font-semibold">{points[hover]!.label}</div>
            {shown.map((k) => <div key={k.key} className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-sm" style={{ background: COLOR(keys.indexOf(k)) }} />{k.label}: <span className="tabular font-medium">{format(points[hover]!.values[k.key] ?? 0)}</span></div>)}
          </div>
        )}
      </div>
      <SrTable points={points} keys={keys} format={format} />
    </div>
  );
}

/** Bars per period (grouped when there are several series). */
export function BarChart({ points, keys, height = 200, currency, testId }: { points: Point[]; keys: SeriesKey[]; height?: number; currency?: string; testId?: string }) {
  const format = formatter(currency);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<number | null>(null);
  const shown = keys.filter((k) => !hidden.has(k.key));
  const W = 640;
  const H = height;
  const pad = { l: 40, r: 6, t: 10, b: 24 };
  const max = niceMax(Math.max(0, ...points.flatMap((p) => shown.map((k) => p.values[k.key] ?? 0))));
  const slot = (W - pad.l - pad.r) / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(28, (slot * 0.7) / Math.max(1, shown.length)));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const every = Math.max(1, Math.ceil(points.length / 8));
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else if (shown.length > 1) n.add(k); return n; });
  if (!points.length) return <EmptyChart height={height} />;
  return (
    <div data-testid={testId}>
      <Legend keys={keys} hidden={hidden} toggle={toggle} />
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Bar chart of ${keys.map((k) => k.label).join(', ')}`} onMouseLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--chart-grid)" />
              <text x={pad.l - 6} y={y(max * f) + 3} textAnchor="end" className="fill-fg-subtle text-[10px]">{format(max * f)}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const x0 = pad.l + i * slot + (slot - bw * shown.length) / 2;
            return (
              <g key={p.label + i} onMouseEnter={() => setHover(i)}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={H - pad.t - pad.b} fill={hover === i ? 'var(--chart-grid)' : 'transparent'} />
                {shown.map((k, si) => {
                  const v = p.values[k.key] ?? 0;
                  return <rect key={k.key} x={x0 + si * bw} y={y(v)} width={bw - 1} height={Math.max(0, y(0) - y(v))} rx="2" fill={COLOR(keys.indexOf(k))} />;
                })}
                {(i % every === 0 || i === points.length - 1) && <text x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor="middle" className="fill-fg-subtle text-[10px]">{p.label}</text>}
              </g>
            );
          })}
        </svg>
        {hover !== null && points[hover] && (
          <div className="pointer-events-none absolute top-1 z-10 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-[11.5px] shadow-pop" style={{ left: `clamp(0px, calc(${((pad.l + hover * slot) / W) * 100}% - 40px), calc(100% - 150px))` }}>
            <div className="font-semibold">{points[hover]!.label}</div>
            {shown.map((k) => <div key={k.key}>{k.label}: <span className="tabular font-medium">{format(points[hover]!.values[k.key] ?? 0)}</span></div>)}
          </div>
        )}
      </div>
      <SrTable points={points} keys={keys} format={format} />
    </div>
  );
}

/** Shares of a whole (plans, statuses) as a ring with a legend. */
export function Donut({ items, size = 150, centre, testId }: { items: { label: string; value: number; href?: string }[]; size?: number; centre?: { value: string; label: string }; testId?: string }) {
  const total = items.reduce((a, i) => a + i.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  const arcs = useMemo(() => {
    let at = 0;
    return items.map((it, i) => {
      const len = total ? (it.value / total) * c : 0;
      const a = { ...it, i, dash: `${Math.max(0, len - (items.length > 1 ? 1.5 : 0))} ${c}`, offset: -at };
      at += len;
      return a;
    });
  }, [items, total, c]);
  return (
    <div className="flex flex-wrap items-center gap-5" data-testid={testId}>
      <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={items.map((i) => `${i.label} ${i.value}`).join(', ')} className="shrink-0 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--chart-grid)" strokeWidth="12" />
        {arcs.map((a) => <circle key={a.label} cx="50" cy="50" r={r} fill="none" stroke={COLOR(a.i)} strokeWidth="12" strokeDasharray={a.dash} strokeDashoffset={a.offset} />)}
        {centre && (
          <g className="rotate-90" style={{ transformOrigin: '50px 50px' }}>
            <text x="50" y="49" textAnchor="middle" className="fill-fg text-[15px] font-semibold">{centre.value}</text>
            <text x="50" y="61" textAnchor="middle" className="fill-fg-subtle text-[7px]">{centre.label}</text>
          </g>
        )}
      </svg>
      <ul className="min-w-[10rem] flex-1 space-y-1 text-[12.5px]">
        {items.map((it, i) => (
          <li key={it.label} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: COLOR(i) }} />
            {it.href ? <a href={it.href} className="min-w-0 flex-1 truncate hover:underline">{it.label}</a> : <span className="min-w-0 flex-1 truncate">{it.label}</span>}
            <span className="tabular font-medium">{it.value}</span>
            <span className="w-10 text-right tabular text-fg-subtle">{total ? Math.round((it.value / total) * 100) : 0}%</span>
          </li>
        ))}
        {!items.length && <li className="text-fg-subtle">No data yet</li>}
      </ul>
    </div>
  );
}

/** A tiny trend line for KPI tiles. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / (max - min || 1)) * 26).toFixed(1)}`).join('');
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn('h-7 w-full', className)} aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>;
}

function EmptyChart({ height }: { height: number }) {
  return <div className="flex items-center justify-center rounded-lg border border-dashed border-border text-[12.5px] text-fg-subtle" style={{ height }}>No data for this range yet</div>;
}

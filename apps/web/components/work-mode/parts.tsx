import { Badge } from '@crew/ui';
import { Building2, Home, Repeat, ShieldQuestion } from 'lucide-react';
import type { WorkModeLabels, WorkModeStateKey } from '@/lib/types';

/** Office / home / hybrid attendance building blocks shared by the employee, dashboard and register pages. */

export const DEFAULT_LABELS: WorkModeLabels = { office: 'Work From Office', remote: 'Work From Home', hybrid: 'Work From Office + Home' };

export const MODE_TONE: Record<WorkModeStateKey, 'accent' | 'success' | 'ember' | 'warning'> = {
  office: 'accent', remote: 'success', hybrid: 'ember', pending_verification: 'warning',
};
/** Fill classes for charts, in the same order everywhere: office, home, hybrid, pending. */
export const MODE_FILL: Record<WorkModeStateKey, string> = {
  office: 'fill-accent', remote: 'fill-success', hybrid: 'fill-ember', pending_verification: 'fill-warning',
};
export const MODE_STROKE: Record<WorkModeStateKey, string> = {
  office: 'stroke-accent', remote: 'stroke-success', hybrid: 'stroke-ember', pending_verification: 'stroke-warning',
};
export const MODE_BG: Record<WorkModeStateKey, string> = {
  office: 'bg-accent', remote: 'bg-success', hybrid: 'bg-ember', pending_verification: 'bg-warning',
};
export const MODE_ICON = { office: Building2, remote: Home, hybrid: Repeat, pending_verification: ShieldQuestion } as const;
export const MODES: WorkModeStateKey[] = ['office', 'remote', 'hybrid', 'pending_verification'];

export function modeLabel(mode: string | null | undefined, labels: WorkModeLabels = DEFAULT_LABELS) {
  if (mode === 'office' || mode === 'remote' || mode === 'hybrid') return labels[mode];
  if (mode === 'pending_verification') return 'Pending verification';
  return 'Not classified';
}

export function ModeBadge({ mode, labels, provisional, corrected }: { mode: string | null | undefined; labels?: WorkModeLabels; provisional?: boolean; corrected?: boolean }) {
  if (!mode) return <span className="text-fg-subtle">-</span>;
  const m = mode as WorkModeStateKey;
  const Icon = MODE_ICON[m] ?? ShieldQuestion;
  return (
    <Badge tone={MODE_TONE[m] ?? 'neutral'}>
      <Icon className="size-3" aria-hidden /> {modeLabel(mode, labels)}{provisional ? ' (so far)' : ''}{corrected ? ' · corrected' : ''}
    </Badge>
  );
}

export const hoursLabel = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

/** Office and away time as one bar that grows in. */
export function HoursSplit({ office, remote, unverified = 0, labels = DEFAULT_LABELS }: { office: number; remote: number; unverified?: number; labels?: WorkModeLabels }) {
  const total = office + remote + unverified;
  const part = (n: number) => (total ? `${(n / total) * 100}%` : '0%');
  return (
    <div className="grid gap-2" data-testid="hours-split">
      <div className="flex h-2.5 overflow-hidden rounded-full bg-bg-subtle" role="img" aria-label={`${hoursLabel(office)} at the office, ${hoursLabel(remote)} away${unverified ? `, ${hoursLabel(unverified)} not verified` : ''}`}>
        <span className="wm-grow-x block h-full bg-accent" style={{ width: part(office) }} />
        <span className="wm-grow-x block h-full bg-success" style={{ width: part(remote), animationDelay: '120ms' }} />
        <span className="wm-grow-x block h-full bg-warning" style={{ width: part(unverified), animationDelay: '240ms' }} />
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[0.8125rem]">
        <div className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" aria-hidden /><dt className="text-fg-muted">Office hours</dt><dd className="tabular font-medium text-fg">{hoursLabel(office)}</dd></div>
        <div className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-success" aria-hidden /><dt className="text-fg-muted">{labels.remote} hours</dt><dd className="tabular font-medium text-fg">{hoursLabel(remote)}</dd></div>
        {unverified > 0 && <div className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" aria-hidden /><dt className="text-fg-muted">Not verified</dt><dd className="tabular font-medium text-fg">{hoursLabel(unverified)}</dd></div>}
      </dl>
    </div>
  );
}

/** A donut of office, home, hybrid and pending that draws in; the numbers are in the legend and for screen readers. */
export function ModeDonut({ values, labels = DEFAULT_LABELS, size = 168, center }: { values: Record<WorkModeStateKey, number>; labels?: WorkModeLabels; size?: number; center?: { value: React.ReactNode; label: string } }) {
  const total = MODES.reduce((t, m) => t + values[m], 0);
  const r = size / 2 - 14;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex flex-wrap items-center gap-6" data-testid="mode-donut">
      <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" role="img" aria-label={MODES.map((m) => `${modeLabel(m, labels)} ${values[m]}`).join(', ')}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={18} className="stroke-bg-subtle" stroke="currentColor" />
          {total > 0 && MODES.map((m, i) => {
            const len = (values[m] / total) * c;
            const el = values[m] ? (
              <circle key={m} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={18} stroke="currentColor" className={`wm-draw ${MODE_STROKE[m]}`}
                strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-offset} style={{ animationDelay: `${i * 120}ms` }}>
                <title>{`${modeLabel(m, labels)}: ${values[m]}`}</title>
              </circle>
            ) : null;
            offset += len;
            return el;
          })}
        </svg>
        <div className="absolute grid place-items-center text-center">
          <span className="text-3xl font-semibold tabular tracking-tight text-fg">{center?.value ?? total}</span>
          <span className="text-xs text-fg-muted">{center?.label ?? 'classified'}</span>
        </div>
      </div>
      <ul className="grid gap-2 text-sm">
        {MODES.map((m) => (
          <li key={m} className="flex items-center gap-2">
            <span className={`size-2.5 rounded-sm ${MODE_BG[m]}`} aria-hidden />
            <span className="text-fg-muted">{modeLabel(m, labels)}</span>
            <span className="ml-auto pl-4 tabular font-semibold text-fg">{values[m]}</span>
            <span className="w-12 text-right tabular text-xs text-fg-subtle">{total ? `${Math.round((values[m] / total) * 100)}%` : '-'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Daily office / home / hybrid / pending as stacked bars that grow in. */
export function ModeTrend({ points, labels = DEFAULT_LABELS }: { points: { date: string; office: number; remote: number; hybrid: number; pending: number }[]; labels?: WorkModeLabels }) {
  const max = Math.max(1, ...points.map((p) => p.office + p.remote + p.hybrid + p.pending));
  if (!points.length || max === 1 && points.every((p) => p.office + p.remote + p.hybrid + p.pending === 0)) {
    return <p className="px-5 pb-5 text-sm text-fg-muted">No classified days in this range yet.</p>;
  }
  const w = 640;
  const h = 170;
  const pad = { l: 28, r: 8, t: 8, b: 22 };
  const step = (w - pad.l - pad.r) / points.length;
  const bw = Math.max(3, Math.min(26, step * 0.66));
  const y = (v: number) => (v / max) * (h - pad.t - pad.b);
  const every = Math.max(1, Math.ceil(points.length / 12));
  const keys: [keyof (typeof points)[number], WorkModeStateKey][] = [['office', 'office'], ['remote', 'remote'], ['hybrid', 'hybrid'], ['pending', 'pending_verification']];
  return (
    <figure className="px-5 pb-5" data-testid="mode-trend">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-48 w-full" role="img" aria-label={`Daily ${labels.office}, ${labels.remote} and ${labels.hybrid}`}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={w - pad.r} y1={h - pad.b - g * (h - pad.t - pad.b)} y2={h - pad.b - g * (h - pad.t - pad.b)} className="stroke-border" stroke="currentColor" strokeDasharray={g ? '3 4' : undefined} />
            <text x={pad.l - 6} y={h - pad.b - g * (h - pad.t - pad.b) + 4} textAnchor="end" className="fill-fg-subtle text-[10px]">{Math.round(g * max)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = pad.l + i * step + (step - bw) / 2;
          let base = h - pad.b;
          return (
            <g key={p.date} className="wm-grow" style={{ animationDelay: `${i * 18}ms` }}>
              <title>{`${p.date}: ${labels.office} ${p.office}, ${labels.remote} ${p.remote}, ${labels.hybrid} ${p.hybrid}, pending ${p.pending}`}</title>
              {keys.map(([k, m]) => {
                const v = p[k] as number;
                if (!v) return null;
                const hh = y(v);
                base -= hh;
                return <rect key={k} x={x} y={base} width={bw} height={Math.max(1, hh - 1)} rx={2} className={MODE_FILL[m]} />;
              })}
              {i % every === 0 && <text x={x + bw / 2} y={h - 6} textAnchor="middle" className="fill-fg-subtle text-[10px]">{Number(p.date.slice(8))}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-4 text-xs text-fg-muted">
        {MODES.map((m) => <span key={m} className="flex items-center gap-1.5"><span className={`size-2 rounded-sm ${MODE_BG[m]}`} aria-hidden />{modeLabel(m, labels)}</span>)}
      </figcaption>
    </figure>
  );
}

import { Badge, cn, type Tone } from '@crew/ui';
import type { AppraisalStageKey } from '@/lib/types';

export const STAGE_LABEL: Record<AppraisalStageKey, string> = { self: 'Self-appraisal', manager: 'Manager evaluation', hr: 'HR review', finalized: 'Finalised', published: 'Result shared' };
const STAGE_TONE: Record<AppraisalStageKey, Tone> = { self: 'info', manager: 'accent', hr: 'warning', finalized: 'success', published: 'success' };
const ORDER: AppraisalStageKey[] = ['self', 'manager', 'hr', 'finalized', 'published'];

export const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${Number.isInteger(n) ? n : n.toFixed(1)}%`);
export const day = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(d.length === 10 ? `${d}T00:00:00Z` : d)) : '—');

export function StageBadge({ stage }: { stage: AppraisalStageKey }) {
  return <Badge tone={STAGE_TONE[stage]} dot>{STAGE_LABEL[stage]}</Badge>;
}

/** The three stages and where this appraisal is, as a stepper. */
export function StageStepper({ stage }: { stage: AppraisalStageKey }) {
  const at = ORDER.indexOf(stage);
  const steps: [AppraisalStageKey, string][] = [['self', 'Self-appraisal'], ['manager', 'Manager evaluation'], ['hr', 'HR review'], ['published', 'Result']];
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Appraisal stages">
      {steps.map(([key, label], i) => {
        const idx = ORDER.indexOf(key);
        const done = at > idx || (key === 'published' && stage === 'published');
        const current = !done && (at === idx || (key === 'hr' && stage === 'finalized'));
        return (
          <li key={key} className="flex items-center gap-2" aria-current={current ? 'step' : undefined}>
            <span className={cn('grid size-6 place-items-center rounded-full text-xs font-semibold', done ? 'bg-success text-white' : current ? 'bg-accent text-accent-fg ring-4 ring-accent/20' : 'bg-bg-subtle text-fg-subtle')}>{done ? '✓' : i + 1}</span>
            <span className={cn('text-sm', current ? 'font-semibold text-fg' : 'text-fg-muted')}>{label}</span>
            {i < steps.length - 1 && <span className="mx-1 hidden h-px w-8 bg-border sm:block" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/** A ring that fills to a percentage (completion or score). */
export function Ring({ value, label, size = 96 }: { value: number | null; label: string; size?: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <figure className="flex flex-col items-center gap-1.5">
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${label}: ${pct(value)}`}>
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-border, #e5e7eb)" strokeWidth="9" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--accent)" strokeWidth="9" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (c * v) / 100} transform="rotate(-90 50 50)" className="transition-[stroke-dashoffset] duration-700 motion-reduce:transition-none" />
        <text x="50" y="55" textAnchor="middle" className="fill-[var(--fg)] text-[1.15rem] font-semibold">{value === null ? '—' : `${Math.round(v)}%`}</text>
      </svg>
      <figcaption className="text-xs text-fg-muted">{label}</figcaption>
    </figure>
  );
}

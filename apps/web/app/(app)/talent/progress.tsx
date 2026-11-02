import { cn } from '@crew/ui';

/** A labelled progress bar. The value is a percentage from 0 to 100. */
export function Progress({ value, className, tone = 'accent', label = 'Progress' }: { value: number; className?: string; tone?: 'accent' | 'success' | 'warning' | 'danger'; label?: string }) {
  const v = Math.max(0, Math.min(100, value));
  const bar = { accent: 'bg-accent', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' }[tone];
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-subtle" role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn('h-full rounded-full', bar)} style={{ width: `${v}%` }} />
      </div>
      <span className="w-12 text-right text-xs tabular-nums text-fg-muted">{Number.isInteger(v) ? v : v.toFixed(1)}%</span>
    </div>
  );
}

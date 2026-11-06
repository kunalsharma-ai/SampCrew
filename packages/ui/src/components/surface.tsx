import { type HTMLAttributes, type ReactNode, useId } from 'react';
import { cn } from '../cn';
import { AutoHelp, type HelpProp } from './help';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('crew-card rounded-xl border border-border bg-surface shadow-card', className)} {...props} />;
}

/** A card heading. An "i" icon follows the title when the app's help content has an entry for it (or `help` gives one). */
export function CardHeader({ title, description, action, className, help }: { title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string; help?: HelpProp }) {
  const id = useId();
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-5 pb-3', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <h3 id={id} className="text-[0.9375rem] font-semibold text-fg">{title}</h3>
          <AutoHelp kind="section" text={title} help={help} describedBy={id} />
        </div>
        {description && <p className="mt-0.5 text-[0.8125rem] text-fg-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />;
}

/** A page heading. An "i" icon explains the page when the app's help content has an entry for this route. */
export function PageHeader({ title, description, actions, eyebrow, help }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; help?: HelpProp }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between mb-6 animate-fade-in">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-accent">{eyebrow}</div>}
        <div className="flex items-center gap-1.5">
          <h1 id={id} className="crew-page-title text-2xl font-semibold tracking-tight text-fg">{title}</h1>
          <AutoHelp kind="page" text={typeof title === 'string' ? title : undefined} help={help} describedBy={id} />
        </div>
        {description && <p className="mt-1 text-sm text-fg-muted max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const tones = {
  neutral: 'bg-bg-subtle text-fg-muted',
  accent: 'bg-accent-subtle text-accent',
  success: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  info: 'bg-info-subtle text-info',
  ember: 'bg-ember-subtle text-ember',
} as const;
export type Tone = keyof typeof tones;

export function Badge({ tone = 'neutral', className, children, dot }: { tone?: Tone; className?: string; children: ReactNode; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  active: 'success', trialing: 'info', invited: 'warning', pending: 'warning', suspended: 'danger', past_due: 'danger', cancelled: 'neutral',
  approved: 'success', rejected: 'danger', revoked: 'neutral', expired: 'neutral', closed: 'neutral', paid: 'success', open: 'info', draft: 'neutral',
  present: 'success', half_day: 'warning', absent: 'danger', missing_punch: 'warning', on_leave: 'info', half_day_leave: 'info', holiday: 'neutral',
  weekly_off: 'neutral', in_progress: 'info', not_joined: 'neutral', awaiting_colleague: 'warning', declined: 'neutral', published: 'success',
  online: 'success', delayed: 'warning', offline: 'danger', waiting: 'neutral', error: 'danger', simulated: 'ember',
  succeeded: 'success', failed: 'danger', sending: 'info', paused: 'warning', disabled: 'danger', owner_inactive: 'warning',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} dot>
      {status.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())}
    </Badge>
  );
}

/** A person's photo when they have one (src), otherwise their initials on a colour picked from the name. */
export function Avatar({ name, size = 32, className, src }: { name: string; size?: number; className?: string; src?: string | null }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" aria-hidden width={size} height={size} loading="lazy" className={cn('inline-block shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />
    );
  }
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${hue} 65% 55%), hsl(${(hue + 40) % 360} 70% 45%))` }}
    >
      {initials}
    </span>
  );
}

export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between text-[0.8125rem] text-fg-muted">
        <span>{label}</span>
        {icon && <span className="text-fg-subtle">{icon}</span>}
      </div>
      <div className="mt-2 text-[1.75rem] font-semibold tracking-tight tabular text-fg">{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-subtle">{hint}</div>}
    </Card>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-accent-subtle text-accent">{icon}</div>}
      <h3 className="text-[0.9375rem] font-semibold text-fg">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-[0.8125rem] text-fg-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-bg-subtle', className)} aria-hidden />;
}

export function Alert({ tone = 'info', title, children, className }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('rounded-md border px-4 py-3 text-[0.8125rem]', tones[tone], 'border-current/15', className)}>
      {title && <div className="font-semibold">{title}</div>}
      {children && <div className={cn(title && 'mt-0.5', 'opacity-90')}>{children}</div>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[0.6875rem] text-fg-muted">{children}</kbd>;
}

'use client';
import { ATTENTION_LABEL, type AttentionLevel, type HomeAction } from '@crew/contracts';
import { Card, CardHeader, Skeleton, cn } from '@crew/ui';
import { AlertOctagon, AlertTriangle, ArrowRight, BellRing, CheckCircle2, Info, PartyPopper, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

/**
 * Building blocks shared by every level's Home: attention levels shown with an icon and a word (never colour alone),
 * number cards that open the filtered list behind them, the action centre, progress bars and section states.
 */

export const LEVEL_STYLE: Record<AttentionLevel, { icon: typeof Info; text: string; bg: string; bar: string }> = {
  normal: { icon: CheckCircle2, text: 'text-fg-muted', bg: 'bg-bg-subtle', bar: 'bg-fg-subtle' },
  info: { icon: Info, text: 'text-info', bg: 'bg-info-subtle', bar: 'bg-info' },
  attention: { icon: BellRing, text: 'text-accent', bg: 'bg-accent-subtle', bar: 'bg-accent' },
  warning: { icon: AlertTriangle, text: 'text-warning', bg: 'bg-warning-subtle', bar: 'bg-warning' },
  critical: { icon: AlertOctagon, text: 'text-danger', bg: 'bg-danger-subtle', bar: 'bg-danger' },
};

export function LevelIcon({ level, className }: { level: AttentionLevel; className?: string }) {
  const s = LEVEL_STYLE[level];
  const Icon = s.icon;
  return (
    <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', s.bg, s.text, className)} title={ATTENTION_LABEL[level]}>
      <Icon className="size-4" aria-hidden />
      <span className="sr-only">{ATTENTION_LABEL[level]}</span>
    </span>
  );
}

/** A number on a card. With `href` the whole card opens the list behind it, already filtered. */
export function StatCard({ label, value, hint, href, icon, level = 'normal', unit, testId, tone }: {
  label: string; value: number | null; hint?: string; href?: string; icon?: ReactNode; level?: AttentionLevel; unit?: 'percent'; testId?: string;
  /** Colour of the icon tile; defaults to the attention level's. */
  tone?: string;
}) {
  const s = LEVEL_STYLE[level];
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[0.75rem] font-medium text-fg-muted">{label}</span>
        {icon && <span className={cn('grid size-7 place-items-center rounded-lg', tone ?? cn(s.bg, s.text))} aria-hidden>{icon}</span>}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tabular tracking-tight" data-testid={testId ? `${testId}-value` : undefined}>{value === null ? '—' : unit === 'percent' ? `${value}%` : value.toLocaleString()}</span>
        {level !== 'normal' && value ? <span className={cn('inline-flex items-center gap-0.5 text-[0.6875rem] font-medium', s.text)}><s.icon className="size-3" aria-hidden />{ATTENTION_LABEL[level]}</span> : null}
      </div>
      {hint && <div className="mt-0.5 truncate text-[0.6875rem] text-fg-subtle" title={hint}>{hint}</div>}
    </>
  );
  const cls = 'crew-card block rounded-xl border border-border bg-surface p-3.5 transition-[border-color,transform,box-shadow] duration-200 motion-reduce:transition-none';
  return href ? (
    <Link href={href} className={cn(cls, 'hover:-translate-y-0.5 hover:border-accent hover:shadow-md focus-visible:border-accent')} data-testid={testId} title={hint ? `${label}: ${hint}` : label}>{body}</Link>
  ) : <div className={cls} data-testid={testId}>{body}</div>;
}

export function Progress({ value, label, className, barClass }: { value: number | null; label: string; className?: string; barClass?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-bg-subtle', className)} role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full bg-accent transition-[width] duration-700 motion-reduce:transition-none', barClass)} style={{ width: `${v}%` }} />
    </div>
  );
}

/** What needs the person, most urgent first; each row opens the page that resolves it. */
export function ActionCenter({ actions, title = 'Action required', description, limit = 8, testId = 'action-center' }: { actions: HomeAction[]; title?: string; description?: string; limit?: number; testId?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? actions : actions.slice(0, limit);
  return (
    <Card data-testid={testId}>
      <CardHeader title={title} description={description ?? (actions.length ? `${actions.length} item${actions.length === 1 ? '' : 's'} for you` : undefined)} />
      {actions.length === 0 ? (
        <Empty icon={<PartyPopper className="size-5" />} title="No pending actions" text="You're all caught up." />
      ) : (
        <ul className="grid grid-cols-1 gap-1.5 px-3 pb-3">
          {shown.map((a) => (
            <li key={a.key}>
              <Link href={a.href} className="group flex items-center gap-3 rounded-lg p-2 transition-colors hover:bg-bg-subtle" data-testid={`action-${a.key}`}>
                <LevelIcon level={a.level} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] font-medium">{a.title}</span>
                  {a.detail && <span className="block truncate text-[0.6875rem] text-fg-subtle">{a.detail}</span>}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 text-[0.75rem] font-medium text-accent">{a.cta}<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden /></span>
              </Link>
            </li>
          ))}
          {actions.length > limit && (
            <li><button type="button" className="px-2 py-1 text-[0.75rem] font-medium text-accent hover:underline" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${actions.length}`}</button></li>
          )}
        </ul>
      )}
    </Card>
  );
}

export function Empty({ icon, title, text, action }: { icon?: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="grid grid-cols-1 place-items-center gap-1 px-5 pb-6 pt-2 text-center">
      {icon && <span className="mb-1 grid size-10 place-items-center rounded-full bg-success-subtle text-success" aria-hidden>{icon}</span>}
      <div className="text-[0.8125rem] font-medium">{title}</div>
      {text && <div className="text-[0.75rem] text-fg-subtle">{text}</div>}
      {action}
    </div>
  );
}

/** A section whose data did not load: a plain sentence and a retry, never a raw error. */
export function SectionError({ title, what }: { title: string; what: string }) {
  const router = useRouter();
  return (
    <Card role="alert">
      <CardHeader title={title} />
      <div className="flex flex-wrap items-center gap-3 px-5 pb-5 text-[0.8125rem] text-fg-muted">
        <AlertTriangle className="size-4 text-warning" aria-hidden />
        <span className="flex-1">{what} couldn&apos;t be loaded.</span>
        <button type="button" className="inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => router.refresh()}><RefreshCw className="size-3.5" aria-hidden />Try again</button>
      </div>
    </Card>
  );
}

export function SectionSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <Card className={cn('p-5', className)} aria-busy="true" aria-label="Loading">
      <Skeleton className="mb-4 h-4 w-40" />
      <div className="grid grid-cols-1 gap-3">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
    </Card>
  );
}

export function StatSkeletonRow({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <Skeleton key={i} className="h-[5.5rem] rounded-xl" />)}
    </div>
  );
}

/** Daily bars with a hover tooltip per day, for attendance trends. */
export function DailyBars({ days, label, height = 120, onPick }: {
  days: { date: string; value: number | null; detail: string }[]; label: string; height?: number; onPick?: (date: string) => void;
}) {
  const max = Math.max(100, ...days.map((d) => d.value ?? 0));
  return (
    <figure className="m-0">
      <div className="flex items-end gap-[3px]" style={{ height }} role="img" aria-label={label}>
        {days.map((d) => {
          const h = d.value === null ? 4 : Math.max(4, (d.value / max) * height);
          const tone = d.value === null ? 'bg-bg-subtle' : d.value >= 90 ? 'bg-success' : d.value >= 75 ? 'bg-accent' : 'bg-warning';
          return (
            <button
              key={d.date}
              type="button"
              title={`${d.date}: ${d.detail}`}
              aria-label={`${d.date}: ${d.detail}`}
              onClick={() => onPick?.(d.date)}
              className={cn('group relative flex-1 rounded-t transition-opacity hover:opacity-80', tone)}
              style={{ height: h }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[0.625rem] text-fg-subtle tabular"><span>{days[0]?.date.slice(5)}</span><span>{days.at(-1)?.date.slice(5)}</span></div>
    </figure>
  );
}

/** Greeting for the time of day, the date and a clock that ticks (rendered from the server's time first). */
export function HomeHeader({ name, level, workspace, timeZone, renderedAt, children }: {
  name: string; level: string; workspace: string; timeZone: string; renderedAt: number; children?: ReactNode;
}) {
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)));
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(now));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(now));
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between animate-fade-in" data-testid="home-header">
      <div className="min-w-0">
        <h1 id="home-title" className="crew-hero-title text-2xl font-semibold tracking-tight text-fg"><span aria-hidden>👋 </span>{greeting}, <span className="crew-gradient-text">{name}</span></h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-fg-muted">
          <span className="font-medium text-fg" data-testid="home-level">{level}</span>
          <span aria-hidden>•</span><span>{workspace}</span>
          <span aria-hidden>•</span><span suppressHydrationWarning>{date}</span>
          <span aria-hidden>•</span><span className="tabular" suppressHydrationWarning>{time}</span>
        </p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Tabs between a level's views (Organisation, Workforce, My day), kept in the URL. */
export function ViewTabs({ tabs, current }: { tabs: { key: string; label: string; href: string }[]; current: string }) {
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Home views" className="mb-5 inline-flex rounded-xl border border-border bg-surface p-1 shadow-sm">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} scroll={false} aria-current={t.key === current ? 'page' : undefined}
          className={cn('rounded-lg px-3 py-1.5 text-[0.8125rem] font-medium transition-colors', t.key === current ? 'bg-accent text-accent-fg shadow-sm' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export const relative = (iso: string | null, now = Date.now()) => {
  if (!iso) return '';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

export const shortDate = (d: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));

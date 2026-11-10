import { cn } from '@crew/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

/*
 * The neon dashboard pieces the Console shares with the Web Portal: gradient KPI tiles and the workspace tab bar.
 * Styled by @crew/ui/styles.css (crew-tile, crew-card), so the classic look and dark mode restyle them unchanged.
 */

export type TileTone = 'violet' | 'teal' | 'orange' | 'blue' | 'pink' | 'green';

export function Tile({ label, value, hint, tone, icon, href, testId }: { label: string; value: ReactNode; hint?: ReactNode; tone: TileTone; icon: ReactNode; href?: string; testId?: string }) {
  const body = (
    <>
      <div className="relative flex items-start gap-3">
        <span className="crew-tile-icon flex size-10 shrink-0 items-center justify-center rounded-xl" aria-hidden>{icon}</span>
        {/* Label first in the DOM so the link's name starts with what is visible; shown under the value. */}
        <div className="flex min-w-0 flex-1 flex-col-reverse">
          <div className="crew-tile-muted truncate text-[0.8125rem] font-medium">{label}</div>
          <div className="truncate text-[1.6rem] font-bold leading-tight tabular-nums" data-testid={testId}>{value}</div>
        </div>
      </div>
      {hint && <div className="crew-tile-muted relative mt-2 truncate text-[0.6875rem]">{hint}</div>}
    </>
  );
  const cls = cn('crew-tile block p-4 transition-transform duration-150', `crew-tile-${tone}`, href && 'hover:-translate-y-0.5 focus-visible:-translate-y-0.5');
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls} role="group">{body}</div>;
}

export function TileRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{children}</div>;
}

export type WorkspaceTab = 'overview' | 'billing' | 'access' | 'users' | 'activity' | 'devices';
const TABS: { key: WorkspaceTab; label: string; path: string; cap?: string }[] = [
  { key: 'overview', label: 'Overview & subscription', path: '' },
  { key: 'billing', label: 'Billing', path: '/billing', cap: 'billing:read' },
  { key: 'access', label: 'Features & permissions', path: '/access' },
  { key: 'users', label: 'Users', path: '/users', cap: 'access:manage' },
  { key: 'activity', label: 'Activity', path: '/activity', cap: 'access:manage' },
  { key: 'devices', label: 'Attendance machines', path: '/devices' },
];

/** The sections of one workspace. Tabs the admin's role cannot open are left out. */
export function WorkspaceTabs({ tenantId, current, caps }: { tenantId: string; current: WorkspaceTab; caps: string[] }) {
  return (
    <nav aria-label="Workspace sections" className="crew-card mb-6 flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface p-1">
      {TABS.filter((t) => !t.cap || caps.includes(t.cap)).map((t) => (
        <Link key={t.key} href={`/tenants/${tenantId}${t.path}`} aria-current={t.key === current ? 'page' : undefined} data-testid={`ws-tab-${t.key}`}
          className={cn('crew-nav-link whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px]', t.key === current ? 'crew-tab-active bg-accent font-medium text-accent-fg' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

import { Avatar, Badge, cn } from '@crew/ui';
import Link from 'next/link';
import { CLIENT_TONE } from '../clients-view';
import type { ClientDetail } from '../client-types';

export type ClientTab = 'overview' | 'workspaces' | 'users' | 'billing' | 'activity';

/** The Company 360 header and its tabs (tabs the admin's role cannot open are left out). */
export function ClientHeader({ c, current, caps, actions }: { c: ClientDetail; current: ClientTab; caps: string[]; actions?: React.ReactNode }) {
  const p = c.profile;
  const tabs: { key: ClientTab; label: string; href: string; cap?: string }[] = [
    { key: 'overview', label: 'Overview', href: `/clients/${p.id}` },
    { key: 'workspaces', label: `Workspaces (${c.totals.superWorkspaces})`, href: `/clients/${p.id}/workspaces` },
    { key: 'users', label: `Users (${c.totals.users})`, href: `/clients/${p.id}/users`, cap: 'users:read' },
    { key: 'billing', label: 'Billing', href: `/clients/${p.id}/billing`, cap: 'billing:read' },
    { key: 'activity', label: 'Activity', href: `/clients/${p.id}/activity`, cap: 'audit:read' },
  ];
  return (
    <div className="mb-5 grid gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <Avatar name={p.name} src={p.logoUrl} size={56} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-tight">{p.name}</h1>
            <Badge tone={CLIENT_TONE[c.status]} dot>{c.statusLabel}</Badge>
            {p.isDemo && <Badge tone="ember">Demo</Badge>}
            {p.tags.map((t) => <Badge key={t}>{t}</Badge>)}
          </div>
          <p className="mt-0.5 text-[13px] text-fg-muted">
            {[p.legalName && p.legalName !== p.name ? p.legalName : null, p.website?.replace(/^https?:\/\//, ''), c.accountManager ? `Account manager: ${c.accountManager.name}` : null].filter(Boolean).join(' · ') || 'Profile not filled in yet'}
          </p>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <nav aria-label="Company sections" className="flex gap-1 overflow-x-auto border-b border-border" data-testid="client-tabs">
        {tabs.filter((t) => !t.cap || caps.includes(t.cap)).map((t) => (
          <Link key={t.key} href={t.href} aria-current={current === t.key ? 'page' : undefined} className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px]', current === t.key ? 'border-accent font-medium text-accent' : 'border-transparent text-fg-muted hover:text-fg')}>{t.label}</Link>
        ))}
      </nav>
    </div>
  );
}

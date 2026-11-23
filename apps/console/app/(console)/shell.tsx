'use client';
import type { ConsoleAlerts, ConsoleNotificationSummary, ConsoleSettings } from '@crew/contracts';
import { Avatar, Badge, CrewLogo, HelpProvider, cn } from '@crew/ui';
import {
  Activity, Bell, BookOpen, Briefcase, Building2, ChartColumn, ChevronRight, Fingerprint, Gauge, Globe, Headset, KeyRound, LifeBuoy, Lock, LogOut, Menu, Moon, Palette, Plug, Receipt,
  ScrollText, Settings, Shield, ShieldCheck, Sun, Tag, Ticket, ToggleRight, Users, X, type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useEffect, useMemo, useState, useTransition } from 'react';
import { CommandSearch } from '@/components/command-search';
import { NotificationBell, useConsoleFeed } from '@/components/console-notifications';
import { CONSOLE_HELP } from '@/lib/help-content';
import type { Admin } from '@/lib/types';
import { logoutAction } from '../auth-actions';

export interface NavItem { href: string; label: string; icon: string; badge?: number }
export interface NavGroup { label: string; items: NavItem[] }
const ICONS: Record<string, LucideIcon> = {
  gauge: Gauge, bell: Bell, chart: ChartColumn, briefcase: Briefcase, building: Building2, tag: Tag, activity: Activity, scroll: ScrollText, shield: Shield, shieldCheck: ShieldCheck,
  plug: Plug, users: Users, fingerprint: Fingerprint, receipt: Receipt, globe: Globe, toggle: ToggleRight, key: KeyRound, headset: Headset, ticket: Ticket, book: BookOpen, lifebuoy: LifeBuoy,
  lock: Lock, settings: Settings,
};

/** Path parts that are not pages of their own, named for the breadcrumb. */
const CRUMB: Record<string, string> = { new: 'New', edit: 'Edit', access: 'Features & permissions', activity: 'Activity', billing: 'Billing', users: 'Users', devices: 'Attendance machines', 'view-as': 'View as', workspaces: 'Workspaces' };

export function Shell({ me, nav, alerts, summary, live, branding, children }: { me: Admin; nav: NavGroup[]; alerts: ConsoleAlerts | null; summary: ConsoleNotificationSummary | null; live?: boolean; branding?: ConsoleSettings['branding'] | null; children: React.ReactNode }) {
  const consoleName = branding?.consoleName?.trim() || 'Console';
  const pathname = usePathname();
  const feed = useConsoleFeed(summary, alerts, !!live);
  const { byTab, refresh } = feed;
  // Opening a page refreshes the bell, so something fixed or read elsewhere leaves it at once.
  useEffect(() => { void refresh(); }, [pathname, refresh]);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [dark, setDark] = useState(false);
  const [neon, setNeon] = useState(true);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    setDark(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches));
    setNeon(document.documentElement.dataset.style !== 'classic');
  }, []);
  const toggleStyle = () => {
    const next = neon ? 'classic' : 'neon';
    document.documentElement.dataset.style = next;
    try { localStorage.setItem('crew-console-style', next); } catch {}
    setNeon(!neon);
  };
  const toggleTheme = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('crew-theme', next); } catch {}
    setDark(!dark);
  };

  const flat = useMemo(() => nav.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))), [nav]);
  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));
  // Breadcrumbs: the menu group, the page, then each deeper part (an id shows as "Details").
  const crumbs = useMemo(() => {
    const page = [...flat].sort((a, b) => b.href.length - a.href.length).find((i) => isActive(i.href));
    if (!page) return [];
    const out: { label: string; href?: string }[] = [{ label: page.group }, { label: page.label, href: page.href }];
    const rest = pathname.slice(page.href.length).split('/').filter(Boolean);
    let at = page.href;
    for (const part of rest) {
      at = `${at.replace(/\/$/, '')}/${part}`;
      out.push({ label: CRUMB[part] ?? (/^[0-9a-f-]{20,}$/i.test(part) ? 'Details' : decodeURIComponent(part).replace(/[-_]/g, ' ')), href: at });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, pathname]);

  const sidebar = (
    <nav aria-label="Console" className="flex h-full flex-col gap-4 overflow-y-auto px-3 py-4">
      <div className="px-2"><CrewLogo subtitle={consoleName} /></div>
      <div className="mx-2 rounded-md bg-bg-subtle px-2.5 py-1.5 text-[11px] font-medium text-fg-muted">SAMPLEDGE internal · {me.roleName ?? me.role}{branding?.supportEmail && <span className="block truncate font-normal text-fg-subtle">Help: {branding.supportEmail}</span>}</div>
      <div className="flex flex-1 flex-col gap-3">
        {nav.map((g) => (
          <div key={g.label}>
            <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">{g.label}</div>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const Icon = ICONS[item.icon] ?? Gauge;
                const active = isActive(item.href);
                const n = byTab[item.href];
                return (
                  <li key={item.href}>
                    <Link href={item.href} aria-current={active ? 'page' : undefined} className={cn('crew-nav-link flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px]', active ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
                      <Icon className="size-4" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {n ? <span data-testid={`console-nav-alert-${item.href.slice(1) || 'home'}`} className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger tabular" aria-label={`${n} new`}><span aria-hidden className="size-1.5 rounded-full bg-danger" />{n}</span> : null}
                      {!!item.badge && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-fg" data-testid="nav-badge">{item.badge}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar name={me.fullName} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{me.fullName}</div>
            <div className="truncate text-[11px] text-fg-subtle">{me.roleName ?? me.role}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 border-t border-border pt-2">
          <Link href="/change-password" aria-label="Change your password" title="Change password" className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><KeyRound className="size-4" /></Link>
          <button onClick={toggleStyle} aria-label={neon ? 'Switch to the classic look' : 'Switch to the neon look'} title={neon ? 'Classic look' : 'Neon look'} className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><Palette className="size-4" /></button>
          <button onClick={() => start(() => logoutAction())} disabled={pending} aria-label="Sign out" className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><LogOut className="size-4" /></button>
        </div>
      </div>
    </nav>
  );

  return (
    <HelpProvider content={CONSOLE_HELP} pathname={pathname}>
    <div className="flex min-h-dvh" style={branding?.accent ? ({ '--accent': branding.accent, '--accent-hover': branding.accent } as React.CSSProperties) : undefined}>
      <aside className="crew-glass crew-sidebar sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="crew-sidebar absolute inset-y-0 left-0 w-72 bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
            <button className="absolute right-3 top-3 rounded p-1" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="crew-glass crew-topbar sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border px-3 sm:gap-3 sm:px-6">
          <button className="rounded p-1.5 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <span className="lg:hidden"><CrewLogo subtitle={consoleName} height={26} /></span>
          <div className="hidden min-w-0 flex-1 md:block"><CommandSearch pages={flat.map((i) => ({ href: i.href, label: i.label, group: i.group }))} /></div>
          <div className="ml-auto flex items-center gap-1 md:ml-0">
            <span className="md:hidden"><CommandSearch compact hotkey={false} pages={flat.map((i) => ({ href: i.href, label: i.label, group: i.group }))} /></span>
            <NotificationBell feed={feed} />
            <button onClick={toggleTheme} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'} className="rounded-lg p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg">{dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}</button>
            <Badge tone="ember" className="hidden sm:inline-flex">Internal</Badge>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1360px] flex-1 px-4 py-5 sm:px-8 sm:py-7">
          {crumbs.length > 1 && (
            <nav aria-label="Breadcrumb" data-testid="breadcrumbs" className="mb-3 flex flex-wrap items-center gap-1 text-[12px] text-fg-subtle">
              {crumbs.map((c, i) => (
                <Fragment key={`${c.label}${i}`}>
                  {i > 0 && <ChevronRight className="size-3" aria-hidden />}
                  {c.href && i < crumbs.length - 1 ? <Link href={c.href} className="hover:text-fg hover:underline">{c.label}</Link> : <span aria-current={i === crumbs.length - 1 ? 'page' : undefined} className={cn(i === crumbs.length - 1 && 'text-fg-muted')}>{c.label}</span>}
                </Fragment>
              ))}
            </nav>
          )}
          <div key={pathname} className="crew-page">{children}</div>
        </main>
      </div>
    </div>
    </HelpProvider>
  );
}

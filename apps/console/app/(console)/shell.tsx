'use client';
import { Avatar, Badge, CrewLogo, HelpProvider, cn } from '@crew/ui';
import { Activity, Building2, Fingerprint, Gauge, Globe, Headset, KeyRound, LogOut, Menu, Moon, Palette, Plug, Receipt, ScrollText, Shield, Sun, Tag, Users, X, type LucideIcon, ToggleRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { CONSOLE_HELP } from '@/lib/help-content';
import type { Admin } from '@/lib/types';
import { logoutAction } from '../auth-actions';
import type { ConsoleAlerts } from '@crew/contracts';
import { ConsoleBell, useConsoleAlerts } from '@/components/console-alerts';
import { LiveRefresh } from '@/components/live-refresh';

export interface NavItem { href: string; label: string; icon: string; badge?: number }
const ICONS: Record<string, LucideIcon> = { gauge: Gauge, building: Building2, tag: Tag, activity: Activity, scroll: ScrollText, shield: Shield, plug: Plug, users: Users, fingerprint: Fingerprint, receipt: Receipt, globe: Globe, toggle: ToggleRight, key: KeyRound, headset: Headset };
const ROLE_LABEL: Record<Admin['role'], string> = { super_admin: 'Super admin', support: 'Support', billing_ops: 'Billing operations', viewer: 'Viewer' };

export function Shell({ me, nav, alerts: initialAlerts, live, children }: { me: Admin; nav: NavItem[]; alerts: ConsoleAlerts | null; live?: boolean; children: React.ReactNode }) {
  const pathname = usePathname();
  const { alerts, byTab, refresh, markSeen } = useConsoleAlerts(initialAlerts);
  // Opening a page refreshes the alerts, so a fixed problem leaves the bell at once.
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

  const sidebar = (
    <nav aria-label="Console" className="flex h-full flex-col gap-6 px-3 py-4">
      <div className="flex items-center justify-between px-2">
        <CrewLogo subtitle="Console" />
        {initialAlerts && <ConsoleBell alerts={alerts} markSeen={markSeen} />}
      </div>
      <div className="mx-2 rounded-md bg-bg-subtle px-2.5 py-1.5 text-[11px] font-medium text-fg-muted">SAMPLEDGE internal · Super Admin</div>
      <ul className="flex flex-1 flex-col gap-0.5">
        {nav.map((item) => {
          const Icon = ICONS[item.icon] ?? Gauge;
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={active ? 'page' : undefined} className={cn('crew-nav-link flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px]', active ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
                <Icon className="size-4" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {byTab[item.href] ? <span data-testid={`console-nav-alert-${item.href.slice(1) || 'home'}`} className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger tabular" aria-label={`${byTab[item.href]} new alert${byTab[item.href] === 1 ? '' : 's'}`}><span aria-hidden className="size-1.5 rounded-full bg-danger" />{byTab[item.href]}</span> : null}
                {item.href === '/' && alerts?.unseen ? <span data-testid="console-nav-alert-home" className="inline-flex items-center gap-1 text-[11px] font-semibold text-danger tabular" aria-label={`${alerts.unseen} new alerts`}><span aria-hidden className="size-1.5 rounded-full bg-danger" />{alerts.unseen}</span> : null}
                {!!item.badge && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-fg" data-testid="nav-badge">{item.badge}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar name={me.fullName} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{me.fullName}</div>
            <div className="truncate text-[11px] text-fg-subtle">{ROLE_LABEL[me.role]}</div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-1 border-t border-border pt-2">
        <Link href="/change-password" aria-label="Change your password" title="Change password" className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><KeyRound className="size-4" /></Link>
        <button onClick={toggleStyle} aria-label={neon ? 'Switch to the classic look' : 'Switch to the neon look'} title={neon ? 'Classic look' : 'Neon look'} className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><Palette className="size-4" /></button>
        <button onClick={toggleTheme} aria-label="Toggle dark mode" className="rounded p-1 text-fg-muted hover:bg-bg-subtle">{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
        <button onClick={() => start(() => logoutAction())} disabled={pending} aria-label="Sign out" className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><LogOut className="size-4" /></button>
        </div>
      </div>
    </nav>
  );

  return (
    <HelpProvider content={CONSOLE_HELP} pathname={pathname}>
    {live && <LiveRefresh />}
    <div className="flex min-h-dvh">
      <aside className="crew-glass crew-sidebar sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-border lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="crew-sidebar absolute inset-y-0 left-0 w-72 bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
            <button className="absolute right-3 top-3 rounded p-1" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="crew-glass crew-topbar flex h-14 items-center gap-3 border-b border-border px-4 lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <CrewLogo subtitle="Console" height={30} />
          <Badge tone="ember" className="ml-auto">Internal</Badge>
        </header>
        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-8 sm:py-8"><div key={pathname} className="crew-page">{children}</div></main>
      </div>
    </div>
    </HelpProvider>
  );
}

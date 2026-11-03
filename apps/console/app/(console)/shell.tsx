'use client';
import { Avatar, Badge, CrewLogo, cn } from '@crew/ui';
import { Activity, Building2, Gauge, LogOut, Menu, Moon, Plug, ScrollText, Shield, Sun, Tag, X, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { Admin } from '@/lib/types';
import { logoutAction } from '../auth-actions';

export interface NavItem { href: string; label: string; icon: string }
const ICONS: Record<string, LucideIcon> = { gauge: Gauge, building: Building2, tag: Tag, activity: Activity, scroll: ScrollText, shield: Shield, plug: Plug };
const ROLE_LABEL: Record<Admin['role'], string> = { super_admin: 'Super admin', support: 'Support', billing_ops: 'Billing operations', viewer: 'Viewer' };

export function Shell({ me, nav, children }: { me: Admin; nav: NavItem[]; children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [dark, setDark] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => setDark(document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches)), []);
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
      </div>
      <div className="mx-2 rounded-md bg-ember-subtle px-2.5 py-1.5 text-[11px] font-medium text-ember">SAMPLEDGE internal</div>
      <ul className="flex flex-1 flex-col gap-0.5">
        {nav.map((item) => {
          const Icon = ICONS[item.icon] ?? Gauge;
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px]', active ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
                <Icon className="size-4" aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2.5 rounded-lg border border-border p-2.5">
        <Avatar name={me.fullName} size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{me.fullName}</div>
          <div className="truncate text-[11px] text-fg-subtle">{ROLE_LABEL[me.role]}</div>
        </div>
        <button onClick={toggleTheme} aria-label="Toggle dark mode" className="rounded p-1 text-fg-muted hover:bg-bg-subtle">{dark ? <Sun className="size-4" /> : <Moon className="size-4" />}</button>
        <button onClick={() => start(() => logoutAction())} disabled={pending} aria-label="Sign out" className="rounded p-1 text-fg-muted hover:bg-bg-subtle"><LogOut className="size-4" /></button>
      </div>
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-border bg-surface lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)}>
          <aside className="absolute inset-y-0 left-0 w-72 bg-surface shadow-pop" onClick={(e) => e.stopPropagation()}>
            <button className="absolute right-3 top-3 rounded p-1" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-4 lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <CrewLogo subtitle="Console" />
          <Badge tone="ember" className="ml-auto">Internal</Badge>
        </header>
        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </div>
    </div>
  );
}

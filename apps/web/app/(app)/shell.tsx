'use client';
import { Avatar, Badge, CrewLogo, Dialog, Kbd, cn } from '@crew/ui';
import {
  Bell, Building2, CalendarDays, Check, ChevronsUpDown, Contact, CreditCard, Home, Inbox, KeyRound, LifeBuoy, ListChecks, LogOut, Menu, Monitor, Moon, ScrollText, Search,
  Settings, Shield, SlidersHorizontal, Sun, Users, X, Clock, CalendarClock, UsersRound, Timer, Fingerprint, Briefcase, UserSearch, MessageSquare,
  type LucideIcon,
  Banknote, FileText, Landmark, Receipt, Wallet,
  BarChart3, BookOpen, CalendarRange, ClipboardList, GraduationCap, Heart, MessagesSquare, Target,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import type { NavGroup } from '@/lib/nav';
import type { Me, Notification } from '@/lib/types';
import { logoutAction, markAllNotificationsReadAction, markNotificationReadAction, switchTenantAction } from './shell-actions';

const ICONS: Record<string, LucideIcon> = {
  home: Home, users: Users, building: Building2, shield: Shield, scroll: ScrollText, 'credit-card': CreditCard, settings: Settings, 'life-buoy': LifeBuoy, key: KeyRound,
  inbox: Inbox, calendar: CalendarDays, 'list-checks': ListChecks, contact: Contact, sliders: SlidersHorizontal,
  clock: Clock, 'calendar-clock': CalendarClock, 'users-round': UsersRound, timer: Timer, fingerprint: Fingerprint,
  briefcase: Briefcase, 'user-search': UserSearch, 'message-square': MessageSquare,
  'file-text': FileText, receipt: Receipt, wallet: Wallet, banknote: Banknote, landmark: Landmark,
  target: Target, 'messages-square': MessagesSquare, 'graduation-cap': GraduationCap, 'clipboard-list': ClipboardList, heart: Heart,
  'calendar-range': CalendarRange, 'book-open': BookOpen, chart: BarChart3,
};

export interface Notifications { unread: number; items: Notification[] }

export function Shell({ me, nav, notifications, children }: { me: Me; nav: NavGroup[]; notifications: Notifications | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allHrefs = nav.flatMap((g) => g.items.map((i) => i.href));
  const sidebar = (
    <nav aria-label="Main" className="flex h-full flex-col gap-6 px-3 py-4">
      <div className="px-2"><CrewLogo subtitle="by Sampledge" /></div>
      <TenantSwitcher me={me} />
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto">
        {nav.map((g) => (
          <div key={g.label}>
            <div className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">{g.label}</div>
            <ul className="flex flex-col gap-0.5">
              {g.items.map((item) => {
                const Icon = ICONS[item.icon] ?? Home;
                const active = item.href === '/' ? pathname === '/' : (pathname === item.href || pathname.startsWith(`${item.href}/`)) && !allHrefs.some((h) => h.length > item.href.length && h.startsWith(`${item.href}/`) && (pathname === h || pathname.startsWith(`${h}/`)));
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13.5px] transition-colors',
                        active ? 'bg-accent-subtle font-medium text-accent' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg',
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <UserMenu me={me} />
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 border-r border-border bg-surface lg:block">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-surface shadow-pop animate-slide-up">
            <button className="absolute right-3 top-4 rounded-md p-1 text-fg-subtle hover:bg-bg-subtle" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X className="size-4" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-bg/80 px-4 backdrop-blur sm:px-6">
          <button className="rounded-md p-1.5 text-fg-muted hover:bg-bg-subtle lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="size-5" /></button>
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border border-border bg-surface px-3 text-[13px] text-fg-subtle shadow-card hover:border-border-strong"
          >
            <Search className="size-4" aria-hidden />
            <span className="flex-1 text-left">Jump to…</span>
            <span className="hidden sm:inline"><Kbd>Ctrl</Kbd> <Kbd>K</Kbd></span>
          </button>
          <div className="ml-auto flex items-center gap-2">
            {me.subscription?.status === 'trialing' && me.subscription.trialEndsOn && (
              <Badge tone="info" className="hidden sm:inline-flex">Trial until {new Date(me.subscription.trialEndsOn).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Badge>
            )}
            {notifications && <NotificationBell data={notifications} />}
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} nav={nav} />
    </div>
  );
}

function TenantSwitcher({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const multiple = me.tenants.length > 1;
  return (
    <div className="relative px-1">
      <button
        disabled={!multiple}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-bg-subtle/60 px-2.5 py-2 text-left disabled:cursor-default"
        aria-haspopup={multiple ? 'listbox' : undefined}
        aria-expanded={multiple ? open : undefined}
      >
        <span className="flex size-7 items-center justify-center rounded-md bg-accent text-[11px] font-bold text-accent-fg">{me.tenant.name.slice(0, 2).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{me.tenant.name}</span>
          <span className="block truncate text-[11px] text-fg-subtle">{me.subscription ? `${me.subscription.plan[0]!.toUpperCase()}${me.subscription.plan.slice(1)} plan` : 'No subscription'}</span>
        </span>
        {multiple && <ChevronsUpDown className="size-4 text-fg-subtle" />}
      </button>
      {open && (
        <ul role="listbox" className="absolute inset-x-1 top-full z-50 mt-1 rounded-lg border border-border bg-surface-raised p-1 shadow-pop animate-fade-in">
          {me.tenants.map((t) => (
            <li key={t.id}>
              <button
                role="option"
                aria-selected={t.id === me.tenant.id}
                disabled={pending}
                onClick={() => (t.id === me.tenant.id ? setOpen(false) : start(async () => void (await switchTenantAction(t.id))))}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-bg-subtle"
              >
                <span className="flex-1 truncate">{t.name}</span>
                {t.id === me.tenant.id && <Check className="size-4 text-accent" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UserMenu({ me }: { me: Me }) {
  const [pending, start] = useTransition();
  const primaryRole = me.membership.roles.find((r) => r.key !== 'employee') ?? me.membership.roles[0];
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2">
      <Avatar name={me.user.fullName} size={30} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{me.user.fullName}</div>
        <div className="truncate text-[11px] text-fg-subtle">{primaryRole?.name}</div>
      </div>
      <button onClick={() => start(() => logoutAction())} disabled={pending} className="rounded-md p-1.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="Sign out" title="Sign out">
        <LogOut className="size-4" />
      </button>
    </div>
  );
}

function NotificationBell({ data }: { data: Notifications }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => {
    // Keep the count fresh while the tab is open.
    const t = setInterval(() => router.refresh(), 60_000);
    return () => clearInterval(t);
  }, [router]);
  const go = (n: Notification) => {
    setOpen(false);
    start(async () => {
      if (!n.readAt) await markNotificationReadAction(n.id);
      if (n.link) router.push(n.link);
      else router.refresh();
    });
  };
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg"
        aria-label={data.unread ? `Notifications, ${data.unread} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell className="size-4" />
        {data.unread > 0 && (
          <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">{data.unread > 99 ? '99+' : data.unread}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface-raised shadow-pop animate-fade-in">
            <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
              <span className="text-[13px] font-semibold">Notifications</span>
              {data.unread > 0 && (
                <button className="text-xs font-medium text-accent hover:underline" disabled={pending} onClick={() => start(async () => { await markAllNotificationsReadAction(); router.refresh(); })}>
                  Mark all read
                </button>
              )}
            </div>
            <ul className="max-h-96 overflow-y-auto">
              {data.items.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-fg-subtle">Nothing yet</li>}
              {data.items.map((n) => (
                <li key={n.id}>
                  <button onClick={() => go(n)} className={cn('flex w-full gap-3 px-4 py-2.5 text-left hover:bg-bg-subtle', !n.readAt && 'bg-accent-subtle/40')}>
                    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-accent')} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-fg">{n.title}</span>
                      {n.body && <span className="line-clamp-2 block text-xs text-fg-muted">{n.body}</span>}
                      <span className="block text-[11px] text-fg-subtle">{new Date(n.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system');
  useEffect(() => {
    try {
      const t = localStorage.getItem('crew-theme');
      if (t === 'light' || t === 'dark') setTheme(t);
    } catch {}
  }, []);
  const cycle = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
    try {
      if (next === 'system') localStorage.removeItem('crew-theme');
      else localStorage.setItem('crew-theme', next);
    } catch {}
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  };
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  return (
    <button onClick={cycle} className="rounded-md p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg" aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
      <Icon className="size-4" />
    </button>
  );
}

function CommandPalette({ open, onClose, nav }: { open: boolean; onClose: () => void; nav: NavGroup[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const items = useMemo(() => nav.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))).filter((i) => i.label.toLowerCase().includes(q.toLowerCase())), [nav, q]);
  useEffect(() => {
    if (open) {
      setQ('');
      setIndex(0);
    }
  }, [open]);
  const go = (href: string) => {
    onClose();
    router.push(href);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Jump to" size="md">
      <input
        autoFocus
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, items.length - 1));
          if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
          if (e.key === 'Enter' && items[index]) go(items[index].href);
        }}
        placeholder="Type a page name…"
        aria-label="Search pages"
        className="mb-3 h-10 w-full rounded-md border border-border bg-surface px-3 text-sm focus:border-accent focus:outline-none"
      />
      <ul className="flex max-h-80 flex-col gap-0.5 overflow-y-auto" role="listbox">
        {items.map((i, n) => {
          const Icon = ICONS[i.icon] ?? Home;
          return (
            <li key={i.href}>
              <button
                role="option"
                aria-selected={n === index}
                onMouseEnter={() => setIndex(n)}
                onClick={() => go(i.href)}
                className={cn('flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm', n === index ? 'bg-accent-subtle text-accent' : 'text-fg-muted')}
              >
                <Icon className="size-4" />
                <span className="flex-1">{i.label}</span>
                <span className="text-xs text-fg-subtle">{i.group}</span>
              </button>
            </li>
          );
        })}
        {!items.length && <li className="px-2.5 py-6 text-center text-sm text-fg-subtle">No matching pages</li>}
      </ul>
    </Dialog>
  );
}

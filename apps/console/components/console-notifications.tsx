'use client';
import { ATTENTION_LABEL, CONSOLE_NOTIFICATION_CATEGORY_LABEL, type ConsoleAlerts, type ConsoleNotification, type ConsoleNotificationSummary } from '@crew/contracts';
import { cn } from '@crew/ui';
import { AlertOctagon, AlertTriangle, Bell, CheckCheck, Info, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { consoleAlertsAction, markConsoleAlertsSeenAction } from '@/app/(console)/alerts-actions';
import { markAllNotificationsReadAction, markNotificationsReadAction, notificationSummaryAction } from '@/app/(console)/console-actions';
import { ALERT_TAB } from './console-alerts';
import { LocalTime } from './local-time';

/** The menu entry each notification category marks with its unread count. */
export const CATEGORY_TAB: Record<string, string> = {
  clients: '/clients', workspaces: '/tenants', users: '/users', subscriptions: '/billing', payments: '/billing', support: '/support', security: '/security', system: '/health', admin: '/audit',
};
const SUPPORT_EVENTS = ['support.message', 'support.read', 'support.changed', 'help.query'];

/** A short, quiet chime (only when the admin switched sound on, for high and urgent notifications). */
function chime(urgent: boolean) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = urgent ? 784 : 659;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.32);
  } catch {
    // No audio: the bell still shows it.
  }
}

/**
 * The Console's live feed: notifications (by permission) and system alerts. One connection to /live per tab; a new
 * notification refreshes the bell, the menu badges and the dashboard panel. Support events refresh the inbox pages.
 * Sound and desktop notifications only when the admin turned them on in Notifications > Preferences (both off by default).
 */
export function useConsoleFeed(initial: ConsoleNotificationSummary | null, initialAlerts: ConsoleAlerts | null, supportLive: boolean) {
  const router = useRouter();
  const [summary, setSummary] = useState(initial);
  const [alerts, setAlerts] = useState(initialAlerts);
  const prefs = useRef(initial?.prefs);
  prefs.current = summary?.prefs ?? prefs.current;
  const refresh = useCallback(async () => {
    const [s, a] = await Promise.all([notificationSummaryAction().catch(() => null), initialAlerts ? consoleAlertsAction().catch(() => null) : Promise.resolve(null)]);
    if (s) setSummary(s);
    if (a) setAlerts(a);
    return s;
  }, [initialAlerts]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let failures = 0;
    let closed = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let t: ReturnType<typeof setTimeout> | null = null;
    const refreshPage = () => { if (t) return; t = setTimeout(() => { t = null; router.refresh(); }, 400); };
    const onNotice = (e: MessageEvent) => {
      let data: { priority?: string; title?: string } = {};
      try { data = JSON.parse(e.data); } catch {}
      void refresh();
      const p = prefs.current;
      const loud = data.priority === 'high' || data.priority === 'urgent';
      if (p?.sound && loud) chime(data.priority === 'urgent');
      if (p?.desktop && data.priority === 'urgent' && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try { new Notification(`SampCrew Console: ${data.title ?? 'New notification'}`); } catch {}
      }
    };
    const open = () => {
      es = new EventSource('/live');
      es.addEventListener('ready', () => { failures = 0; document.documentElement.dataset.consoleLive = 'on'; });
      es.addEventListener('console.notification', onNotice as EventListener);
      if (supportLive) for (const type of SUPPORT_EVENTS) es.addEventListener(type, refreshPage);
      es.onerror = () => {
        failures++;
        delete document.documentElement.dataset.consoleLive;
        if (es?.readyState === EventSource.CLOSED && !closed) {
          if (failures > 3) { poll ??= setInterval(() => { void refresh(); if (supportLive) router.refresh(); }, 60_000); return; }
          setTimeout(open, 3000);
        }
      };
    };
    open();
    return () => {
      closed = true;
      es?.close();
      if (poll) clearInterval(poll);
      if (t) clearTimeout(t);
    };
  }, [refresh, router, supportLive]);

  const byTab: Record<string, number> = {};
  for (const [cat, n] of Object.entries(summary?.byCategory ?? {})) {
    const tab = CATEGORY_TAB[cat];
    if (tab && n) byTab[tab] = (byTab[tab] ?? 0) + n;
  }
  for (const a of alerts?.items ?? []) {
    const tab = ALERT_TAB[a.key];
    if (tab && !a.seen) byTab[tab] = (byTab[tab] ?? 0) + 1;
  }
  const markSeen = useCallback(async () => {
    const next = await markConsoleAlertsSeenAction().catch(() => null);
    if (next) setAlerts(next);
  }, []);
  const markAll = useCallback(async () => {
    await markAllNotificationsReadAction();
    await refresh();
  }, [refresh]);
  const markOne = useCallback(async (id: string) => {
    await markNotificationsReadAction([id]);
    await refresh();
  }, [refresh]);
  return { summary, alerts, byTab, refresh, markSeen, markAll, markOne };
}

const PRIORITY_DOT: Record<string, string> = { urgent: 'bg-danger', high: 'bg-warning', normal: 'bg-accent', low: 'bg-fg-subtle' };
const ALERT_ICON = { critical: AlertOctagon, warning: AlertTriangle, attention: AlertTriangle, info: Info, normal: Info } as const;
const ALERT_TONE: Record<string, string> = { critical: 'text-danger', warning: 'text-warning', attention: 'text-warning', info: 'text-info', normal: 'text-fg-subtle' };

export function NotificationRow({ n, onOpen, compact }: { n: ConsoleNotification; onOpen?: () => void; compact?: boolean }) {
  const body = (
    <span className="flex items-start gap-2.5">
      <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-border-strong' : PRIORITY_DOT[n.priority])} />
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[13px]', !n.read && 'font-semibold')}>{n.title}</span>
        {n.body && !compact && <span className="block text-[12px] text-fg-muted">{n.body}</span>}
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-fg-subtle">
          <span>{CONSOLE_NOTIFICATION_CATEGORY_LABEL[n.category]}</span>
          {n.companyName && <span>{n.companyName}</span>}
          <LocalTime value={n.createdAt} relative />
          {(n.priority === 'urgent' || n.priority === 'high') && <span className={n.priority === 'urgent' ? 'font-semibold text-danger' : 'font-medium text-warning'}>{n.priority === 'urgent' ? 'Urgent' : 'High'}</span>}
        </span>
      </span>
    </span>
  );
  const cls = cn('block px-3 py-2.5 hover:bg-bg-subtle', !n.read && 'bg-accent-subtle/30');
  return n.href ? <Link href={n.href} onClick={onOpen} className={cls} data-testid="notification-row">{body}</Link> : <button type="button" onClick={onOpen} className={cn(cls, 'w-full text-left')} data-testid="notification-row">{body}</button>;
}

/** The bell in the top bar: notifications (newest first) and system alerts, with mark-all and a link to the history. */
export function NotificationBell({ feed }: { feed: ReturnType<typeof useConsoleFeed> }) {
  const { summary, alerts, markAll, markSeen, markOne } = feed;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'notifications' | 'alerts'>('notifications');
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const unread = summary?.unread ?? 0;
  const unseen = alerts?.unseen ?? 0;
  const total = unread + unseen;
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={total ? `Notifications, ${total} new` : 'Notifications'} title="Notifications" data-testid="console-bell" className="relative rounded-lg p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg">
        <Bell className="size-[18px]" aria-hidden />
        {total > 0 && <span data-testid="console-bell-count" className="absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">{total > 99 ? '99+' : total}</span>}
      </button>
      {open && createPortal(
        <div ref={panel} role="dialog" aria-label="Notifications" data-testid="console-bell-panel" className="fixed right-4 top-14 z-[70] w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-pop">
          <div className="flex items-center gap-1 border-b border-border px-2 pt-2">
            {(['notifications', 'alerts'] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTab(t)} aria-pressed={tab === t} className={cn('rounded-t-md px-2.5 py-1.5 text-[12.5px]', tab === t ? 'border-b-2 border-accent font-semibold text-fg' : 'text-fg-muted hover:text-fg')}>
                {t === 'notifications' ? 'Notifications' : 'System alerts'}
                {(t === 'notifications' ? unread : unseen) > 0 && <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">{t === 'notifications' ? unread : unseen}</span>}
              </button>
            ))}
            <span className="ml-auto pb-1">
              {tab === 'notifications' && unread > 0 && <button type="button" onClick={() => void markAll()} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12px] font-medium text-accent hover:bg-bg-subtle"><CheckCheck className="size-3.5" aria-hidden />Mark all as read</button>}
              {tab === 'alerts' && unseen > 0 && <button type="button" onClick={() => void markSeen()} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12px] font-medium text-accent hover:bg-bg-subtle"><CheckCheck className="size-3.5" aria-hidden />Mark all seen</button>}
            </span>
          </div>
          {tab === 'notifications' ? (
            !summary?.latest.length ? <p className="px-3 py-6 text-center text-[13px] text-fg-muted">No notifications yet.</p> : (
              <ul className="max-h-96 divide-y divide-border overflow-y-auto">
                {summary.latest.map((n) => <li key={n.id}><NotificationRow n={n} compact onOpen={() => { setOpen(false); if (!n.read) void markOne(n.id); }} /></li>)}
              </ul>
            )
          ) : !alerts?.items.length ? <p className="px-3 py-6 text-center text-[13px] text-fg-muted">No alerts. Everything looks fine.</p> : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {alerts.items.map((a) => {
                const I = ALERT_ICON[a.level] ?? Info;
                return (
                  <li key={a.key} className={cn(!a.seen && 'bg-accent-subtle/40')}>
                    <Link href={a.href.replace(/^\/tenants$/, '/clients')} onClick={() => setOpen(false)} className="flex items-start gap-2.5 px-3 py-2.5 text-[13px] hover:bg-bg-subtle">
                      <I className={cn('mt-0.5 size-4 shrink-0', ALERT_TONE[a.level])} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{a.title}{!a.seen && <span className="ml-1.5 rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">New</span>}</span>
                        {a.detail && <span className="block text-[12px] text-fg-muted">{a.detail}</span>}
                        <span className="text-[11px] text-fg-subtle">{ATTENTION_LABEL[a.level]}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[12px]">
            <Link href="/notifications" onClick={() => setOpen(false)} className="font-medium text-accent hover:underline">See all notifications</Link>
            <Link href="/notifications?tab=preferences" onClick={() => setOpen(false)} className="inline-flex items-center gap-1 text-fg-muted hover:text-fg"><Settings2 className="size-3.5" aria-hidden />Preferences</Link>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

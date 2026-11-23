'use client';
import { ATTENTION_LABEL, type ConsoleAlerts } from '@crew/contracts';
import { cn } from '@crew/ui';
import { AlertOctagon, AlertTriangle, Bell, BellOff, CheckCheck, Info, Volume2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { consoleAlertsAction, markConsoleAlertsSeenAction } from '@/app/(console)/alerts-actions';

/** The Console menu tab each system alert belongs to. */
export const ALERT_TAB: Record<string, string> = {
  migrations: '/health', 'audit-chain': '/health', outbox: '/health', backups: '/health', scanner: '/health',
  integrations: '/integrations', 'plan-requests': '/plans', support: '/tenants', 'new-workspaces': '/tenants',
};
const LOUD = new Set(['critical', 'warning']);
const MUTE_KEY = 'crew-console-alert-sound';

function tone(level: string) {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = level === 'critical' ? 880 : 660;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch {
    // No audio in this browser: the bell still shows the alert.
  }
}

/**
 * The Console's notifications: system alerts, refreshed every minute while the Console is open. A new warning or
 * critical alert rings (unless muted) and shows a desktop notification when the tab is in the background.
 */
export function useConsoleAlerts(initial: ConsoleAlerts | null) {
  const [alerts, setAlerts] = useState(initial);
  const known = useRef(new Set((initial?.items ?? []).map((a) => `${a.key}:${a.count ?? ''}`)));
  const refresh = useCallback(async () => {
    const next = await consoleAlertsAction().catch(() => null);
    if (!next) return;
    const fresh = next.items.filter((a) => !a.seen && LOUD.has(a.level) && !known.current.has(`${a.key}:${a.count ?? ''}`));
    known.current = new Set(next.items.map((a) => `${a.key}:${a.count ?? ''}`));
    setAlerts(next);
    if (!fresh.length) return;
    let muted = false;
    try { muted = localStorage.getItem(MUTE_KEY) === 'off'; } catch {}
    if (!muted) tone(fresh[0]!.level);
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      try { new Notification(`SampCrew Console: ${fresh[0]!.title}`, { body: fresh[0]!.detail ?? undefined, tag: fresh[0]!.key }); } catch {}
    }
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => { if (document.visibilityState === 'visible' || Notification?.permission === 'granted') void refresh(); }, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);
  const markSeen = useCallback(async () => {
    const next = await markConsoleAlertsSeenAction().catch(() => null);
    if (next) setAlerts(next);
  }, []);
  const byTab: Record<string, number> = {};
  for (const a of alerts?.items ?? []) {
    const tab = ALERT_TAB[a.key];
    if (tab && !a.seen) byTab[tab] = (byTab[tab] ?? 0) + 1;
  }
  return { alerts, byTab, refresh, markSeen };
}

const ICON = { critical: AlertOctagon, warning: AlertTriangle, attention: AlertTriangle, info: Info, normal: Info } as const;
const TONE: Record<string, string> = { critical: 'text-danger', warning: 'text-warning', attention: 'text-warning', info: 'text-info', normal: 'text-fg-subtle' };

export function ConsoleBell({ alerts, markSeen }: { alerts: ConsoleAlerts | null; markSeen: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [sound, setSound] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { try { setSound(localStorage.getItem(MUTE_KEY) !== 'off'); } catch {} }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const unseen = alerts?.unseen ?? 0;
  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    try { localStorage.setItem(MUTE_KEY, next ? 'on' : 'off'); } catch {}
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
  };
  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={unseen ? `System alerts, ${unseen} new` : 'System alerts'} title="System alerts" data-testid="console-bell" className="relative rounded p-1.5 text-fg-muted hover:bg-bg-subtle hover:text-fg">
        <Bell className="size-4" aria-hidden />
        {unseen > 0 && <span data-testid="console-bell-count" className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white">{unseen > 99 ? '99+' : unseen}</span>}
      </button>
      {open && createPortal(
        <div ref={panel} role="dialog" aria-label="System alerts" data-testid="console-bell-panel" className="fixed left-4 top-14 z-[70] w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-surface-raised shadow-pop">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-[13px] font-semibold">System alerts</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={toggleSound} aria-label={sound ? 'Turn alert sound off' : 'Turn alert sound on'} title={sound ? 'Sound on' : 'Sound off'} className="rounded p-1 text-fg-muted hover:bg-bg-subtle">{sound ? <Volume2 className="size-3.5" /> : <BellOff className="size-3.5" />}</button>
              {unseen > 0 && <button type="button" onClick={() => void markSeen()} className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12px] font-medium text-accent hover:bg-bg-subtle"><CheckCheck className="size-3.5" aria-hidden />Mark all seen</button>}
            </div>
          </div>
          {!alerts?.items.length ? <p className="px-3 py-4 text-[13px] text-fg-muted">No alerts. Everything looks fine.</p> : (
            <ul className="max-h-96 divide-y divide-border overflow-y-auto">
              {alerts.items.map((a) => {
                const I = ICON[a.level] ?? Info;
                return (
                  <li key={a.key} className={cn(!a.seen && 'bg-accent-subtle/40')}>
                    <Link href={a.href} onClick={() => setOpen(false)} className="flex items-start gap-2.5 px-3 py-2.5 text-[13px] hover:bg-bg-subtle">
                      <I className={cn('mt-0.5 size-4 shrink-0', TONE[a.level])} aria-hidden />
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
          <Link href="/" onClick={() => setOpen(false)} className="block border-t border-border px-3 py-2 text-center text-[12px] font-medium text-accent hover:bg-bg-subtle">Open the platform overview</Link>
        </div>,
        document.body,
      )}
    </div>
  );
}

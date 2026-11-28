'use client';
import { inQuietHours, shouldPlaySound, type NotificationPreferences, type NotificationView } from '@crew/contracts';
import { cn } from '@crew/ui';
import { X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { armAudioUnlock, claimNotice, playNotificationSound } from '@/lib/notification-sound';
import { markNotificationReadAction, notificationLiveCountsAction, notificationPreferencesAction } from '@/app/(app)/shell-actions';
import { deliveredAction } from '@/app/(app)/communication/actions';

type Handler = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Live {
  unread: number;
  /** The latest notices, newest first (the bell shows them). */
  items: NotificationView[];
  /** Whether the live stream is connected (otherwise counts refresh every minute). */
  connected: boolean;
  /** A new notice arrived in the last few seconds (the bell animates). */
  pulse: boolean;
  /** Unread notices per category (the menu marks Leave, Attendance, Learning ... with them). */
  byCategory: Record<string, number>;
  /** Unread notices that ask the person to act (decide, complete, acknowledge). */
  actionNeeded: number;
  /** Refetch the counts now (after marking something read elsewhere). */
  refreshCounts: () => void;
  prefs: NotificationPreferences | null;
  setPrefs: (p: NotificationPreferences) => void;
  setUnread: (n: number) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** Listen to one live event type (chat.message, chat.read, approvals.changed ...). Returns an unsubscribe. */
  on: (type: string, fn: Handler) => () => void;
}

/** Set by the chat in the corner while it is shown: chat messages then pop up there, not as a second notice. */
let chatWidgetOn = false;
export function setChatWidgetOn(on: boolean) { chatWidgetOn = on; }

const LiveContext = createContext<Live | null>(null);

export function useLive(): Live {
  const x = useContext(LiveContext);
  if (!x) throw new Error('useLive outside LiveProvider');
  return x;
}

/** useLive for components that may render outside the signed-in shell. */
export function useOptionalLive(): Live | null {
  return useContext(LiveContext);
}

/** Re-renders server data (router.refresh) when one of the given live events arrives, at most every 1.5 seconds. */
export function useRefreshOn(types: string[]) {
  const live = useOptionalLive();
  const router = useRouter();
  const key = types.join(',');
  useEffect(() => {
    if (!live) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        router.refresh();
      }, 400);
    };
    const offs = key.split(',').map((ty) => live.on(ty, fire));
    return () => {
      offs.forEach((o) => o());
      if (t) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live?.on, router]);
}

interface Toast { id: string; n: NotificationView }

/** Whether the person's quiet hours are on now (urgent notices still sound and show). */
export function quietNow(p: NotificationPreferences | null, priority: NotificationView['priority']): boolean {
  if (!p?.quiet || priority === 'urgent') return false;
  const d = new Date();
  return inQuietHours(p.quiet, d.getHours() * 60 + d.getMinutes());
}

/** A system notification (outside the browser tab) while the tab is in the background, if the person turned them on. */
function desktopNotice(p: NotificationPreferences | null, n: NotificationView, open: (n: NotificationView) => void) {
  if (!p?.desktop || typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try {
    const sys = new Notification(n.title, { body: n.body ?? undefined, tag: n.id, icon: '/icon.svg' });
    sys.onclick = () => {
      window.focus();
      open(n);
      sys.close();
    };
  } catch {
    // Some browsers only allow system notifications from a service worker; the bell still has it.
  }
}

/** Whether a notice's link is the page open now, or a page under it (/approvals/123 while on /approvals). */
function onPage(link: string | null): boolean {
  if (!link || typeof window === 'undefined') return false;
  const here = window.location.pathname.replace(/\/$/, '') || '/';
  const there = link.split(/[?#]/)[0]!.replace(/\/$/, '') || '/';
  return here !== '/' && (there === here || there.startsWith(`${here}/`));
}

/**
 * Keeps one live connection per tab (/live, server-sent events) and shares it: the bell's unread count, the
 * Notification Center, chat and approvals all update from it without reloading. Sounds and pop-ups follow the
 * person's preferences; a sound never plays on page load, only for notices arriving while the page is open.
 */
export function LiveProvider({ initial, byCategory: initialByCategory, actionNeeded: initialAction = 0, prefs: initialPrefs, children }: { initial: { unread: number; items: NotificationView[] } | null; byCategory?: Record<string, number> | null; actionNeeded?: number; prefs: NotificationPreferences | null; children: React.ReactNode }) {
  const router = useRouter();
  const [unread, setUnread] = useState(initial?.unread ?? 0);
  const [items, setItems] = useState<NotificationView[]>(initial?.items ?? []);
  const [connected, setConnected] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(initialPrefs);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [byCategory, setByCategory] = useState<Record<string, number>>(initialByCategory ?? {});
  const [actionNeeded, setActionNeeded] = useState(initialAction);
  useEffect(() => setActionNeeded(initialAction), [initialAction]);
  // The organisation's policy or the person's settings changed on the server (another tab, the phone): follow it.
  useEffect(() => {
    if (initialPrefs) setPrefs(initialPrefs);
  }, [initialPrefs]);
  const openRef = useRef<(n: NotificationView) => void>(() => undefined);
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The per-category counts come from the server, at most once a second however many notices arrive.
  const refreshCounts = useCallback(() => {
    if (countsTimer.current) return;
    countsTimer.current = setTimeout(() => {
      countsTimer.current = null;
      void notificationLiveCountsAction().then((c) => {
        if (!c) return;
        setByCategory(c.byCategory);
        setActionNeeded(c.actionNeeded);
      }).catch(() => undefined);
    }, 1000);
  }, []);
  useEffect(() => {
    if (initialByCategory) setByCategory(initialByCategory);
  }, [initialByCategory]);
  const handlers = useRef(new Map<string, Set<Handler>>());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Server data wins when the layout re-renders (navigation, router.refresh()).
  useEffect(() => {
    if (initial) {
      setUnread(initial.unread);
      setItems(initial.items);
    }
  }, [initial]);

  const on = useCallback((type: string, fn: Handler) => {
    const set = handlers.current.get(type) ?? new Set<Handler>();
    set.add(fn);
    handlers.current.set(type, set);
    return () => {
      set.delete(fn);
    };
  }, []);

  const emit = useCallback((type: string, data: unknown) => {
    for (const fn of handlers.current.get(type) ?? []) fn(data);
  }, []);

  useEffect(() => armAudioUnlock(), []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let fallback: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let lastDelivered = 0;
    let closed = false;
    const connect = () => {
      es = new EventSource('/live');
      es.addEventListener('ready', () => {
        // Messages that arrived while this browser was away are delivered now.
        void deliveredAction().catch(() => undefined);
        failures = 0;
        setConnected(true);
        if (fallback) {
          clearInterval(fallback);
          fallback = null;
        }
      });
      es.addEventListener('notification', (e) => {
        const d = JSON.parse((e as MessageEvent).data) as { notification: NotificationView; unread: number; folded: boolean; self?: boolean };
        setUnread(d.unread);
        setItems((cur) => [d.notification, ...cur.filter((x) => x.id !== d.notification.id)].slice(0, 15));
        setPulse(true);
        setTimeout(() => setPulse(false), 2500);
        const p = prefsRef.current;
        // No sound or pop-up for what you just did yourself, or for news about the page you are looking at (it
        // updates on its own); the bell still counts it.
        // Quiet hours hold back sound, pop-ups and system notifications too (urgent ones still come through).
        const quiet = d.self || onPage(d.notification.link) || quietNow(p, d.notification.priority);
        // The tone still plays on the page the notice is about (issue #89: every new notice should sound); only your
        // own actions and quiet hours stay silent.
        const silent = d.self || quietNow(p, d.notification.priority);
        // One sound per notice across all open tabs, and none again when a folded notice (chat) only counts up.
        if (!silent && p && shouldPlaySound(p.sound, d.notification.priority, d.notification.category, p)) {
          void claimNotice(d.notification.id, d.folded).then((mine) => mine && playNotificationSound(d.notification.priority, p.sound.volume, { queueIfLocked: true }));
        }
        // A chat message shows on the chat button in the corner instead (its own notice), not twice.
        const chatOwned = chatWidgetOn && d.notification.link?.startsWith('/communication/chat');
        if (!quiet && !chatOwned && (!p || p.toasts)) {
          setToasts((cur) => [{ id: `${d.notification.id}:${Date.now()}`, n: d.notification }, ...cur.filter((x) => x.n.id !== d.notification.id)].slice(0, 3));
        }
        if (!quiet) desktopNotice(p, d.notification, openRef.current);
        refreshCounts();
        emit('notification', d);
      });
      // What this person may use changed at a level above them (Console, Super Workspace or HR Workspace): reload the
      // page, so menus and screens follow at once. The API already refuses what was taken away.
      es.addEventListener('access.changed', () => router.refresh());
      // The Super Workspace changed the organisation's notification policy, or this person changed their settings on
      // another device: load the settings again (locked switches, sound).
      es.addEventListener('notifications.policy', () => {
        void notificationPreferencesAction().then((np) => np && setPrefs(np)).catch(() => undefined);
      });
      for (const type of ['notifications.read', 'chat.message', 'chat.read', 'chat.updated', 'approvals.changed', 'announcements.changed', 'leave.changed', 'attendance.changed', 'documents.changed', 'support.message', 'support.read', 'support.changed']) {
        es.addEventListener(type, (e) => {
          const d = JSON.parse((e as MessageEvent).data);
          if (type === 'notifications.read') {
            if (typeof d.unread === 'number') setUnread(d.unread);
            // Notices the server closed itself (a request was decided): read in the bell too.
            if (Array.isArray(d.ids) && d.ids.length) {
              const closed = new Set<string>(d.ids);
              const at = new Date().toISOString();
              setItems((cur) => cur.map((x) => (closed.has(x.id) && !x.readAt ? { ...x, readAt: at } : x)));
              setUnread((u) => Math.max(0, u - d.ids.length));
            }
            refreshCounts();
          }
          // A chat message reached this browser: tell the sender it was delivered (at most every few seconds).
          if (type === 'chat.message' && Date.now() - lastDelivered > 3000) {
            lastDelivered = Date.now();
            void deliveredAction().catch(() => undefined);
          }
          emit(type, d);
        });
      }
      es.onerror = () => {
        setConnected(false);
        failures++;
        // EventSource retries on its own; after repeated failures fall back to refreshing every minute.
        if (failures >= 3 && !fallback) fallback = setInterval(() => router.refresh(), 60_000);
        if (es?.readyState === EventSource.CLOSED && !closed) {
          retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** failures));
        }
      };
    };
    connect();
    return () => {
      closed = true;
      es?.close();
      if (fallback) clearInterval(fallback);
      if (retry) clearTimeout(retry);
    };
  }, [emit, router, refreshCounts]);

  const markRead = useCallback((id: string) => {
    setItems((cur) => cur.map((x) => (x.id === id && !x.readAt ? { ...x, readAt: new Date().toISOString() } : x)));
    refreshCounts();
  }, [refreshCounts]);
  const markAllRead = useCallback(() => {
    setUnread(0);
    setByCategory({});
    setActionNeeded(0);
    setItems((cur) => cur.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })));
  }, []);

  const value = useMemo<Live>(
    () => ({ unread, items, connected, pulse, byCategory, actionNeeded, refreshCounts, prefs, setPrefs, setUnread, markRead, markAllRead, on }),
    [unread, items, connected, pulse, byCategory, actionNeeded, refreshCounts, prefs, markRead, markAllRead, on],
  );

  const openNotice = useCallback((n: NotificationView) => {
    setToasts((cur) => cur.filter((t) => t.n.id !== n.id));
    void markNotificationReadAction(n.id);
    markRead(n.id);
    refreshCounts();
    if (n.link) router.push(n.link);
  }, [markRead, refreshCounts, router]);
  openRef.current = openNotice;

  return (
    <LiveContext.Provider value={value}>
      {children}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((cur) => cur.filter((t) => t.id !== id))} open={openNotice} />
    </LiveContext.Provider>
  );
}

const PRIORITY_BAR: Record<string, string> = { low: 'bg-fg-subtle', normal: 'bg-accent', high: 'bg-warning', urgent: 'bg-danger' };

function Toasts({ toasts, dismiss, open }: { toasts: Toast[]; dismiss: (id: string) => void; open: (n: NotificationView) => void }) {
  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), t.n.priority === 'urgent' ? 12_000 : 6_000));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 top-16 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2" data-testid="notification-toasts">
      {toasts.map((t) => (
        <div key={t.id} role="status" className="pointer-events-auto flex overflow-hidden rounded-xl border border-border bg-surface-raised shadow-lg motion-safe:animate-slide-up">
          <span aria-hidden className={cn('w-1 shrink-0', PRIORITY_BAR[t.n.priority])} />
          <button className="min-w-0 flex-1 px-3 py-2.5 text-left" onClick={() => open(t.n)}>
            <span className="block text-[0.8125rem] font-semibold text-fg">{t.n.title}</span>
            {t.n.body && <span className="line-clamp-2 block text-xs text-fg-muted">{t.n.body}</span>}
          </button>
          <button aria-label="Dismiss" className="self-start p-2 text-fg-subtle hover:text-fg" onClick={() => dismiss(t.id)}><X className="size-3.5" /></button>
        </div>
      ))}
    </div>
  );
}

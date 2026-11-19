'use client';
import { NOTIFICATION_CATEGORIES, type NotificationView } from '@crew/contracts';
import { cn } from '@crew/ui';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { ICONS } from '@/lib/icons';
import { markAllNotificationsReadAction, markNotificationReadAction } from '@/app/(app)/shell-actions';
import { useLive } from './live';
import { Popover } from './popover';

export const CATEGORY_LABEL = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c.key, c.label])) as Record<string, string>;
export const CATEGORY_ICON = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c.key, c.icon])) as Record<string, string>;

export const PRIORITY_TONE: Record<string, string> = {
  low: 'text-fg-subtle',
  normal: 'text-accent',
  high: 'text-warning',
  urgent: 'text-danger',
};

/** "5 min ago", "Yesterday 14:05", "12 Mar". Rendered on the client only, so server and browser never disagree. */
export function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function NotificationIcon({ n, className }: { n: Pick<NotificationView, 'category' | 'priority'>; className?: string }) {
  const Icon = ICONS[CATEGORY_ICON[n.category] ?? 'bell'] ?? Bell;
  return (
    <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-subtle', PRIORITY_TONE[n.priority], className)} aria-hidden>
      <Icon className="size-4" />
    </span>
  );
}

/** The bell in the top bar: live unread count, the latest notices, and a way to the Notification Center. */
export function NotificationBell() {
  const live = useLive();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const close = useCallback(() => setOpen(false), []);
  const go = (n: NotificationView) => {
    setOpen(false);
    start(async () => {
      if (!n.readAt) {
        live.markRead(n.id);
        await markNotificationReadAction(n.id);
      }
      if (n.link) router.push(n.link);
      else router.refresh();
    });
  };
  const count = live.unread > 99 ? '99+' : String(live.unread);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-md p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg"
        aria-label={live.unread ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
        data-testid="notification-bell"
      >
        <Bell className={cn('size-4', live.pulse && 'motion-safe:animate-[bell-ring_0.9s_ease-in-out]')} />
        {live.unread > 0 && (
          <span aria-hidden className="absolute right-0.5 top-0.5 flex">
            {live.pulse && <span className="absolute inline-flex size-full rounded-full bg-danger opacity-60 motion-safe:animate-ping" />}
            <span className="relative flex min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[0.625rem] font-semibold leading-4 text-surface" data-testid="notification-count">{count}</span>
          </span>
        )}
      </button>
      <Popover open={open} onClose={close} className="w-[min(24rem,calc(100vw-2rem))]">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="text-[0.8125rem] font-semibold">Notifications</span>
          {live.unread > 0 && (
            <button className="text-xs font-medium text-accent hover:underline" disabled={pending} onClick={() => start(async () => { live.markAllRead(); await markAllNotificationsReadAction(); router.refresh(); })}>
              Mark all read
            </button>
          )}
        </div>
        <ul className="max-h-96 overflow-y-auto">
          {live.items.length === 0 && <li className="px-4 py-6 text-center text-[0.8125rem] text-fg-subtle">Nothing yet</li>}
          {live.items.map((n) => (
            <li key={n.id}>
              <button onClick={() => go(n)} className={cn('flex w-full gap-3 px-4 py-2.5 text-left hover:bg-bg-subtle', !n.readAt && 'bg-accent-subtle/40')}>
                <NotificationIcon n={n} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    {!n.readAt && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                    <span className="block text-[0.8125rem] font-medium text-fg">{n.title}</span>
                    {n.count > 1 && <span className="rounded-full bg-bg-subtle px-1.5 text-[0.625rem] text-fg-muted">{n.count}</span>}
                  </span>
                  {n.body && <span className="line-clamp-2 block text-xs text-fg-muted">{n.body}</span>}
                  <span className="block text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{CATEGORY_LABEL[n.category]} · {when(n.updatedAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs">
          <Link href="/notifications" onClick={close} className="font-medium text-accent hover:underline">Open Notification Center</Link>
          <Link href="/settings/notifications" onClick={close} className="text-fg-muted hover:text-fg">Settings</Link>
        </div>
      </Popover>
    </div>
  );
}

'use client';
import { NOTIFICATION_CATEGORIES, type NotificationView } from '@crew/contracts';
import { cn } from '@crew/ui';
import { Bell, Check, CheckCheck, Mail, MailOpen, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { ICONS } from '@/lib/icons';
import { markAllNotificationsReadAction, markNotificationReadAction, markNotificationUnreadAction } from '@/app/(app)/shell-actions';
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

/** The section of SampCrew a notice opens, by the first part of its link, so people see where it came from. */
const SECTION_LABEL: Record<string, string> = {
  leave: 'Leave', attendance: 'Attendance', approvals: 'Approvals', recruitment: 'Recruitment & ATS', candidates: 'Recruitment & ATS',
  onboarding: 'Onboarding', tasks: 'Tasks & onboarding', learning: 'Learning & Development', payroll: 'Payroll', payslips: 'Payslips',
  expenses: 'Expenses', documents: 'Documents', announcements: 'Announcements', communication: 'Communication', helpdesk: 'Help desk',
  help: 'Help & Support', appraisal: 'Appraisals', reviews: 'Reviews', goals: 'Goals', assets: 'Assets', verification: 'Background verification',
  employees: 'Employees', profile: 'Profile', settings: 'Settings', support: 'SampCrew Support', 'hr-workspaces': 'HR Workspaces',
};

/** "Leave · opens Leave" style origin: the category, and the section the notice opens when that says more. */
export function originOf(n: Pick<NotificationView, 'category' | 'link'>): string {
  const cat = CATEGORY_LABEL[n.category] ?? 'SampCrew';
  const seg = n.link?.split(/[/?#]/)[1];
  const section = seg ? SECTION_LABEL[seg] : undefined;
  return section && section !== cat ? `${cat} · ${section}` : cat;
}

/** "5 min ago", "Yesterday 14:05", "12 Mar". Rendered on the client only, so server and browser never disagree. */
export function when(iso: string): string {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function NotificationIcon({ n, className }: { n: Pick<NotificationView, 'category' | 'priority'> & { readAt?: string | null }; className?: string }) {
  const Icon = ICONS[CATEGORY_ICON[n.category] ?? 'bell'] ?? Bell;
  const urgent = n.priority === 'urgent' && !n.readAt;
  return (
    <span className={cn('crew-notice-icon flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-subtle', PRIORITY_TONE[n.priority], urgent && 'crew-notice-icon-urgent', className)} aria-hidden>
      <Icon className="size-4" />
    </span>
  );
}

/** The "Action needed" marker: the notice asks the person to decide, complete or acknowledge something. */
export function ActionBadge({ className }: { className?: string }) {
  return <span className={cn('rounded-full bg-ember-subtle px-1.5 py-px text-[0.625rem] font-semibold text-ember', className)} data-testid="action-needed">Action needed</span>;
}

type Tab = 'all' | 'unread' | 'action';

/**
 * The bell in the top bar: live unread count (it swings and the badge pops when a notice arrives), the latest notices
 * with their category, section and time, tabs for unread and action-needed notices, read and unread per notice, mark
 * all read, and the way to the Notification Center and settings. Opening a notice marks it read everywhere (Home, the
 * module's page, other tabs and the phone) and goes to its record.
 */
export function NotificationBell() {
  const live = useLive();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const [pending, start] = useTransition();
  /** The notice just marked read: its row shows a tick for a moment. */
  const [ticked, setTicked] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // The badge pops whenever the count goes up (never on page load).
  const [bump, setBump] = useState(0);
  const last = useRef(live.unread);
  useEffect(() => {
    if (live.unread > last.current) setBump((b) => b + 1);
    last.current = live.unread;
  }, [live.unread]);

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
  const toggleRead = (n: NotificationView) => start(async () => {
    if (n.readAt) await markNotificationUnreadAction(n.id);
    else {
      live.markRead(n.id);
      setTicked(n.id);
      setTimeout(() => setTicked((t) => (t === n.id ? null : t)), 900);
      await markNotificationReadAction(n.id);
    }
    router.refresh();
  });
  const readAll = () => start(async () => {
    live.markAllRead();
    setCleared(true);
    setTimeout(() => setCleared(false), 1400);
    await markAllNotificationsReadAction();
    router.refresh();
  });

  const shown = live.items.filter((n) => (tab === 'unread' ? !n.readAt : tab === 'action' ? n.actionRequired && !n.readAt : true));
  const count = live.unread > 99 ? '99+' : String(live.unread);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn('relative rounded-md p-2 text-fg-muted hover:bg-bg-subtle hover:text-fg', open && 'bg-bg-subtle text-fg')}
        aria-label={live.unread ? `Notifications, ${count} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="notification-bell"
      >
        <Bell className={cn('size-4', live.pulse && 'motion-safe:animate-[bell-ring_0.9s_ease-in-out]')} />
        {live.unread > 0 && (
          <span aria-hidden className="absolute right-0.5 top-0.5 flex">
            {live.pulse && <span className="absolute inline-flex size-full rounded-full bg-danger opacity-60 motion-safe:animate-ping" />}
            <span key={bump} className={cn('crew-badge relative flex min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold leading-4 text-white', bump > 0 && 'crew-badge-pop')} data-testid="notification-count">{count}</span>
          </span>
        )}
      </button>
      <Popover open={open} onClose={close} className="crew-notice-panel w-[min(25rem,calc(100vw-2rem))] overflow-hidden">
        <div role="dialog" aria-label="Notifications" data-testid="notification-panel">
          <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3">
            <span className="text-[0.875rem] font-semibold">Notifications</span>
            {live.unread > 0 ? (
              <button className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-accent hover:bg-bg-subtle" disabled={pending} onClick={readAll} data-testid="mark-all-read">
                <CheckCheck className="size-3.5" aria-hidden /> Mark all read
              </button>
            ) : cleared ? (
              <span className="crew-check-pop inline-flex items-center gap-1 text-xs font-medium text-success" role="status"><Check className="size-3.5" aria-hidden /> All caught up</span>
            ) : null}
          </div>
          <div className="flex gap-1 border-b border-border px-3" role="tablist" aria-label="Show">
            {([['all', 'All', null], ['unread', 'Unread', live.unread], ['action', 'Action needed', live.actionNeeded]] as const).map(([key, label, n]) => (
              <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} data-testid={`bell-tab-${key}`} className={cn('-mb-px border-b-2 px-2 py-1.5 text-xs', tab === key ? 'border-accent font-semibold text-fg' : 'border-transparent text-fg-muted hover:text-fg')}>
                {label}
                {n ? <span className={cn('ml-1 rounded-full px-1.5 text-[0.625rem] font-semibold', key === 'action' ? 'bg-ember-subtle text-ember' : 'bg-accent-subtle text-accent')}>{n > 99 ? '99+' : n}</span> : null}
              </button>
            ))}
          </div>
          <ul className="max-h-[26rem] overflow-y-auto" role="tabpanel">
            {shown.length === 0 && (
              <li className="px-4 py-8 text-center text-[0.8125rem] text-fg-subtle">
                {tab === 'action' ? 'Nothing is waiting for you.' : tab === 'unread' ? 'You are all caught up.' : 'Nothing yet. New notices appear here as they happen.'}
              </li>
            )}
            {shown.map((n) => (
              <li key={n.id} className={cn('crew-notice-row group relative flex', !n.readAt && 'crew-notice-unread', n.priority === 'urgent' && !n.readAt && 'crew-notice-urgent', n.priority === 'high' && !n.readAt && 'crew-notice-high')} data-testid="bell-item">
                <button onClick={() => go(n)} className="flex min-w-0 flex-1 gap-3 py-2.5 pl-4 pr-1 text-left hover:bg-bg-subtle">
                  <NotificationIcon n={n} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {!n.readAt && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                      <span className={cn('text-[0.8125rem] text-fg', !n.readAt ? 'font-semibold' : 'font-medium')}>{n.title}</span>
                      {n.count > 1 && <span className="rounded-full bg-bg-subtle px-1.5 text-[0.625rem] text-fg-muted">{n.count}</span>}
                      {n.priority === 'urgent' && !n.readAt && <span className="rounded-full bg-danger-subtle px-1.5 py-px text-[0.625rem] font-semibold text-danger">Urgent</span>}
                      {n.priority === 'high' && !n.readAt && <span className="rounded-full bg-warning-subtle px-1.5 py-px text-[0.625rem] font-semibold text-warning">Important</span>}
                      {n.actionRequired && !n.readAt && <ActionBadge />}
                    </span>
                    {n.body && <span className="line-clamp-2 block text-xs text-fg-muted">{n.body}</span>}
                    <span className="mt-0.5 block text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{originOf(n)} · {when(n.updatedAt)}{n.link ? ' · Open' : ''}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleRead(n)}
                  aria-label={n.readAt ? `Mark "${n.title}" unread` : `Mark "${n.title}" read`}
                  title={n.readAt ? 'Mark unread' : 'Mark read'}
                  className="m-1 self-start rounded-md p-1.5 text-fg-subtle opacity-70 hover:bg-bg-subtle hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
                  data-testid="bell-toggle-read"
                >
                  {ticked === n.id ? <Check className="crew-check-pop size-3.5 text-success" /> : n.readAt ? <Mail className="size-3.5" /> : <MailOpen className="size-3.5" />}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs">
            <Link href={tab === 'action' ? '/notifications?filter=action' : '/notifications'} onClick={close} className="font-medium text-accent hover:underline">View all notifications</Link>
            <Link href="/settings/notifications" onClick={close} className="inline-flex items-center gap-1 text-fg-muted hover:text-fg"><Settings2 className="size-3.5" aria-hidden />Settings</Link>
          </div>
        </div>
      </Popover>
    </div>
  );
}

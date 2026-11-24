'use client';
import { CONSOLE_NOTIFICATION_CATEGORY_LABEL, type ConsoleNotification, type ConsoleNotificationCategory, type ConsoleNotificationPrefs, type ConsoleNotificationSummary } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, EmptyState, Switch, buttonClass, cn } from '@crew/ui';
import { BellOff, CheckCheck, Mail, MailOpen } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { NotificationRow } from '@/components/console-notifications';
import { markAllNotificationsReadAction, markNotificationsReadAction, markNotificationsUnreadAction, saveNotificationPrefsAction } from '../console-actions';

export function NotificationsView({ tab, page, summary, filters }: {
  tab: 'history' | 'preferences';
  page: { items: ConsoleNotification[]; next: string | null; categories: string[] };
  summary: ConsoleNotificationSummary;
  filters: { category?: string; unread: boolean; before?: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const href = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ category: filters.category, unread: filters.unread ? 'true' : undefined, ...extra }).filter(([, v]) => v) as [string, string][]);
    return `/notifications${p.size ? `?${p}` : ''}`;
  };
  const cats = page.categories as ConsoleNotificationCategory[];
  return (
    <div className="grid gap-4">
      <nav className="flex gap-1 border-b border-border" aria-label="Notifications">
        {(['history', 'preferences'] as const).map((t) => <Link key={t} href={t === 'history' ? '/notifications' : '/notifications?tab=preferences'} aria-current={tab === t ? 'page' : undefined} className={cn('-mb-px border-b-2 px-3 py-2 text-[13px]', tab === t ? 'border-accent font-medium text-accent' : 'border-transparent text-fg-muted hover:text-fg')}>{t === 'history' ? 'History' : 'Preferences'}</Link>)}
      </nav>
      {tab === 'preferences' ? <Preferences prefs={summary.prefs} categories={cats} /> : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Link href={href({ category: undefined })} className={cn('rounded-full border px-3 py-1 text-[12.5px]', !filters.category ? 'border-accent bg-accent-subtle font-medium text-accent' : 'border-border text-fg-muted')}>All <span className="tabular text-fg-subtle">{summary.unread || ''}</span></Link>
            {cats.map((c) => <Link key={c} href={href({ category: c })} className={cn('rounded-full border px-3 py-1 text-[12.5px]', filters.category === c ? 'border-accent bg-accent-subtle font-medium text-accent' : 'border-border text-fg-muted')}>{CONSOLE_NOTIFICATION_CATEGORY_LABEL[c]} {summary.byCategory[c] ? <span className="tabular font-semibold text-danger">{summary.byCategory[c]}</span> : null}{summary.prefs.muted.includes(c) && <BellOff className="ml-1 inline size-3 text-fg-subtle" aria-label="muted" />}</Link>)}
            <Link href={href({ unread: filters.unread ? undefined : 'true' })} className={cn('ml-2 rounded-full border px-3 py-1 text-[12.5px]', filters.unread ? 'border-accent bg-accent-subtle font-medium text-accent' : 'border-border text-fg-muted')}>Unread only</Link>
            {summary.unread > 0 && <Button size="sm" variant="secondary" className="ml-auto" loading={pending} onClick={() => start(async () => { await markAllNotificationsReadAction(); router.refresh(); })} data-testid="notifications-read-all"><CheckCheck className="size-3.5" aria-hidden />Mark all as read</Button>}
          </div>
          <Card>
            {!page.items.length ? <EmptyState title={filters.unread ? 'Nothing unread' : 'No notifications yet'} /> : (
              <ul className="divide-y divide-border" data-testid="notifications-list">
                {page.items.map((n) => (
                  <li key={n.id} className="flex items-center">
                    <div className="min-w-0 flex-1"><NotificationRow n={n} onOpen={() => { if (!n.read) void markNotificationsReadAction([n.id]); }} /></div>
                    <button type="button" className="mr-3 rounded p-1.5 text-fg-muted hover:bg-bg-subtle" title={n.read ? 'Mark as unread' : 'Mark as read'} aria-label={n.read ? 'Mark as unread' : 'Mark as read'}
                      onClick={() => start(async () => { await (n.read ? markNotificationsUnreadAction([n.id]) : markNotificationsReadAction([n.id])); router.refresh(); })}>
                      {n.read ? <Mail className="size-4" /> : <MailOpen className="size-4" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="flex justify-end gap-2">
            {filters.before && <Link href={href({})} className={buttonClass('secondary', 'sm')}>Newest</Link>}
            {page.next && <Link href={href({ before: page.next })} className={buttonClass('secondary', 'sm')}>Older</Link>}
          </div>
        </>
      )}
    </div>
  );
}

function Preferences({ prefs, categories }: { prefs: ConsoleNotificationPrefs; categories: ConsoleNotificationCategory[] }) {
  const router = useRouter();
  const [p, setP] = useState(prefs);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = (next: ConsoleNotificationPrefs) => start(async () => {
    const r = await saveNotificationPrefsAction(next);
    setMsg(r.ok ? { tone: 'success', text: 'Preferences saved.' } : { tone: 'danger', text: r.message ?? 'Not saved' });
    if (r.ok) router.refresh();
  });
  const askDesktop = async (on: boolean) => {
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') await Notification.requestPermission().catch(() => undefined);
    const next = { ...p, desktop: on };
    setP(next);
    save(next);
  };
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="notification-prefs">
      {msg && <Alert tone={msg.tone} className="lg:col-span-2">{msg.text}</Alert>}
      <Card>
        <CardHeader title="Categories" description="A muted category still shows in History, but not in the bell, the menu badges or the dashboard." />
        <CardBody className="grid gap-3">
          {categories.map((c) => (
            <Switch key={c} label={CONSOLE_NOTIFICATION_CATEGORY_LABEL[c]} checked={!p.muted.includes(c)} disabled={pending} testId={`pref-${c}`}
              onChange={(on) => { const next = { ...p, muted: on ? p.muted.filter((m) => m !== c) : [...p.muted, c] }; setP(next); save(next); }} />
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Alerts" description="Both are off unless you turn them on. Only high and urgent notifications make a sound; only urgent ones use desktop notifications, and only when the Console tab is in the background." />
        <CardBody className="grid gap-3">
          <Switch label="Play a short sound" checked={p.sound} disabled={pending} testId="pref-sound" onChange={(on) => { const next = { ...p, sound: on }; setP(next); save(next); }} />
          <Switch label="Desktop notifications for urgent events" checked={p.desktop} disabled={pending} testId="pref-desktop" onChange={(on) => void askDesktop(on)} />
          {p.desktop && typeof Notification !== 'undefined' && Notification.permission === 'denied' && <Alert tone="warning">Your browser blocks notifications for this site. Allow them in the browser settings.</Alert>}
        </CardBody>
      </Card>
    </div>
  );
}

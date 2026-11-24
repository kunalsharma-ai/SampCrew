'use client';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_NAV, type NotificationView } from '@crew/contracts';
import { Badge, Card, CardHeader, cn } from '@crew/ui';
import { BellRing } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { markNotificationReadAction } from '@/app/(app)/shell-actions';
import { useLive } from './live';
import { ActionBadge, NotificationIcon, originOf, when } from './notification-bell';

type View = 'latest' | 'action';

/**
 * Notifications on Home: what needs the person first (action needed, urgent, important), then the latest, updating
 * live, with the categories that have unread notices as shortcuts to their section. Opening one marks it read (the bell
 * and the module's page follow) and goes to its record. Only the signed-in person's own notices are ever shown.
 */
export function RecentNotifications({ limit = 6, className }: { limit?: number; className?: string }) {
  const live = useLive();
  const router = useRouter();
  const [view, setView] = useState<View>('latest');
  // Notices that arrived while Home is open slide in.
  const seen = useRef(new Set(live.items.map((n) => n.id)));
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const added = live.items.filter((n) => !seen.current.has(n.id)).map((n) => n.id);
    for (const id of added) seen.current.add(id);
    if (added.length) setFresh(new Set(added));
  }, [live.items]);
  const rank = (n: NotificationView) => (n.readAt ? 0 : n.actionRequired ? 4 : n.priority === 'urgent' ? 3 : n.priority === 'high' ? 2 : 1);
  const pool = view === 'action' ? live.items.filter((n) => n.actionRequired && !n.readAt) : live.items;
  const shown = [...pool].sort((a, b) => rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  const open = async (n: NotificationView) => {
    if (!n.readAt) {
      live.markRead(n.id);
      await markNotificationReadAction(n.id);
    }
    if (n.link) router.push(n.link);
  };
  const cats = NOTIFICATION_CATEGORIES.filter((c) => (live.byCategory[c.key] ?? 0) > 0);
  return (
    <Card className={className} data-testid="recent-notifications">
      <CardHeader
        title={<span className="inline-flex items-center gap-2"><BellRing className="size-4 text-accent" aria-hidden />Notifications</span>}
        description={live.unread ? `${live.unread} unread${live.actionNeeded ? ` · ${live.actionNeeded} need${live.actionNeeded === 1 ? 's' : ''} you` : ''}` : 'You are all caught up'}
        action={<Link href={view === 'action' ? '/notifications?filter=action' : '/notifications'} className="text-xs font-medium text-accent hover:underline" data-testid="home-notifications-all">View all</Link>}
      />
      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-2" role="tablist" aria-label="Show">
        {([['latest', 'Latest', 0], ['action', 'Action needed', live.actionNeeded]] as const).map(([key, label, n]) => (
          <button key={key} role="tab" aria-selected={view === key} onClick={() => setView(key)} data-testid={`home-notices-${key}`} className={cn('rounded-full px-2.5 py-1 text-xs font-medium', view === key ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg')}>
            {label}{n ? ` · ${n}` : ''}
          </button>
        ))}
        {cats.slice(0, 4).map((c) => (
          <Link key={c.key} href={NOTIFICATION_NAV[c.key][0] ?? `/notifications?category=${c.key}`} className="rounded-full border border-border px-2 py-0.5 text-[0.6875rem] text-fg-muted hover:border-accent hover:text-fg" data-testid={`home-notices-cat-${c.key}`}>
            {c.label} <span className="font-semibold text-accent">{live.byCategory[c.key]}</span>
          </Link>
        ))}
      </div>
      <ul className="divide-y divide-border">
        {shown.length === 0 && <li className="px-5 py-6 text-center text-[0.8125rem] text-fg-subtle">{view === 'action' ? 'Nothing is waiting for you.' : 'Nothing yet'}</li>}
        {shown.map((n) => (
          <li key={n.id} className={cn('crew-notice-row relative', !n.readAt && 'crew-notice-unread', fresh.has(n.id) && 'crew-notice-enter', n.priority === 'urgent' && !n.readAt && 'crew-notice-urgent', n.priority === 'high' && !n.readAt && 'crew-notice-high')}>
            <button onClick={() => void open(n)} className="flex w-full gap-3 px-5 py-2.5 text-left hover:bg-bg-subtle">
              <NotificationIcon n={n} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className={cn('truncate text-[0.8125rem]', n.readAt ? 'font-medium' : 'font-semibold')}>{n.title}</span>
                  {!n.readAt && n.priority === 'urgent' && <Badge tone="danger">Urgent</Badge>}
                  {!n.readAt && n.priority === 'high' && <Badge tone="warning">Important</Badge>}
                  {!n.readAt && n.actionRequired && <ActionBadge />}
                </span>
                {n.body && <span className="line-clamp-1 block text-xs text-fg-muted">{n.body}</span>}
                <span className="block text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{originOf(n)} · {when(n.updatedAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

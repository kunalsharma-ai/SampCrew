'use client';
import type { NotificationView } from '@crew/contracts';
import { Badge, Card, CardHeader, cn } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { markNotificationReadAction } from '@/app/(app)/shell-actions';
import { useLive } from './live';
import { CATEGORY_LABEL, NotificationIcon, when } from './notification-bell';

/**
 * Recent notifications for the Home dashboard: important unread ones first, then the latest, updating live. Opening
 * one marks it read and goes to its record. Place it anywhere inside the signed-in shell.
 */
export function RecentNotifications({ limit = 6, className }: { limit?: number; className?: string }) {
  const live = useLive();
  const router = useRouter();
  const rank = (n: NotificationView) => (n.readAt ? 0 : n.priority === 'urgent' ? 3 : n.priority === 'high' ? 2 : 1);
  const shown = [...live.items].sort((a, b) => rank(b) - rank(a) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  const open = async (n: NotificationView) => {
    if (!n.readAt) {
      live.markRead(n.id);
      await markNotificationReadAction(n.id);
    }
    if (n.link) router.push(n.link);
  };
  return (
    <Card className={className} data-testid="recent-notifications">
      <CardHeader
        title="Notifications"
        description={live.unread ? `${live.unread} unread` : 'You are all caught up'}
        action={<Link href="/notifications" className="text-xs font-medium text-accent hover:underline">See all</Link>}
      />
      <ul className="divide-y divide-border">
        {shown.length === 0 && <li className="px-5 py-6 text-center text-[0.8125rem] text-fg-subtle">Nothing yet</li>}
        {shown.map((n) => (
          <li key={n.id}>
            <button onClick={() => void open(n)} className={cn('flex w-full gap-3 px-5 py-2.5 text-left hover:bg-bg-subtle', !n.readAt && 'bg-accent-subtle/30')}>
              <NotificationIcon n={n} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-[0.8125rem] font-medium">{n.title}</span>
                  {!n.readAt && n.priority === 'urgent' && <Badge tone="danger">Urgent</Badge>}
                  {!n.readAt && n.priority === 'high' && <Badge tone="warning">Important</Badge>}
                </span>
                <span className="block text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{CATEGORY_LABEL[n.category]} · {when(n.updatedAt)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

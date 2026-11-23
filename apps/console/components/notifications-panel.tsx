'use client';
import type { ConsoleNotificationSummary } from '@crew/contracts';
import { Card, CardBody, CardHeader, EmptyState } from '@crew/ui';
import { CheckCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { markAllNotificationsReadAction, markNotificationsReadAction, notificationSummaryAction } from '@/app/(console)/console-actions';
import { NotificationRow } from './console-notifications';

/** The dashboard's notification panel: the latest notifications the admin may see, with mark-all and a link to the history. */
export function NotificationsPanel({ initial }: { initial: ConsoleNotificationSummary | null }) {
  const [summary, setSummary] = useState(initial);
  const [pending, start] = useTransition();
  const reload = async () => { const s = await notificationSummaryAction().catch(() => null); if (s) setSummary(s); };
  const latest = summary?.latest.slice(0, 6) ?? [];
  return (
    <Card data-testid="dashboard-notifications">
      <CardHeader
        title={<span className="flex items-center gap-2">Notifications{summary?.unread ? <span className="rounded-full bg-danger px-1.5 text-[10.5px] font-semibold leading-4 text-white tabular">{summary.unread}</span> : null}</span>}
        action={summary?.unread ? <button type="button" disabled={pending} onClick={() => start(async () => { await markAllNotificationsReadAction(); await reload(); })} className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline"><CheckCheck className="size-3.5" aria-hidden />Mark all as read</button> : null}
      />
      <CardBody className="p-0">
        {!summary ? <p className="px-4 py-6 text-center text-[13px] text-fg-muted">Notifications could not be loaded. Try again in a moment.</p>
          : latest.length ? <div className="divide-y divide-border">{latest.map((n) => <NotificationRow key={n.id} n={n} compact onOpen={() => { if (!n.read) void markNotificationsReadAction([n.id]).then(reload); }} />)}</div>
          : <EmptyState title="All caught up" description="New clients, payments, tickets and security events will show here." />}
        <div className="border-t border-border px-4 py-2 text-right"><Link href="/notifications" className="text-[12px] text-accent hover:underline">See all notifications</Link></div>
      </CardBody>
    </Card>
  );
}

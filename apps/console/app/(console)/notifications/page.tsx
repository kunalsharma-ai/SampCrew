import { CONSOLE_NOTIFICATION_CATEGORIES, type ConsoleNotification, type ConsoleNotificationSummary } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { NotificationsView } from './notifications-view';

export const metadata: Metadata = { title: 'Notifications' };

/** Notification history (by category, unread), and each admin's own preferences: muted categories, sound, desktop. */
export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ tab?: string; category?: string; unread?: string; before?: string }> }) {
  const sp = await searchParams;
  const tab = sp.tab === 'preferences' ? 'preferences' : 'history';
  const category = (CONSOLE_NOTIFICATION_CATEGORIES as readonly string[]).includes(sp.category ?? '') ? sp.category : undefined;
  const qs = new URLSearchParams({ limit: '30' });
  if (category) qs.set('category', category);
  if (sp.unread === 'true') qs.set('unread', 'true');
  if (sp.before && !Number.isNaN(Date.parse(sp.before))) qs.set('before', new Date(sp.before).toISOString());
  const [page, summary] = await Promise.all([
    load<{ items: ConsoleNotification[]; next: string | null; categories: string[] }>(`/platform/notifications?${qs}`),
    load<ConsoleNotificationSummary>('/platform/notifications/summary'),
  ]);
  return (
    <>
      <PageHeader title="Notifications" description="New companies, workspaces, payments, renewals, tickets, security and system events you are allowed to see. Each admin has their own read state and preferences." />
      <NotificationsView tab={tab} page={page} summary={summary} filters={{ category, unread: sp.unread === 'true', before: sp.before }} />
    </>
  );
}

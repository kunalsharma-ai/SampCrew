import { NOTIFICATION_CATEGORY_KEYS, type NotificationCategory, type NotificationView } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { NotificationCenter } from './notification-center';

export const metadata: Metadata = { title: 'Notifications' };

export interface NotificationSummary {
  unread: number;
  categories: { category: NotificationCategory; total: number; unread: number }[];
  important: NotificationView[];
}

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const category = sp.category && (NOTIFICATION_CATEGORY_KEYS as string[]).includes(sp.category) ? sp.category : undefined;
  const filter = sp.filter === 'unread' ? 'unread' : sp.filter === 'read' ? 'read' : 'all';
  const q = new URLSearchParams({ limit: '30' });
  if (category) q.set('category', category);
  if (filter !== 'all') q.set('unread', filter === 'unread' ? 'true' : 'false');
  if (sp.priority && ['low', 'normal', 'high', 'urgent'].includes(sp.priority)) q.set('priority', sp.priority);
  if (sp.q) q.set('q', sp.q.slice(0, 100));
  const [list, summary] = await Promise.all([
    load<{ unread: number; items: NotificationView[]; nextBefore: string | null }>(`/notifications?${q}`),
    load<NotificationSummary>('/notifications/summary'),
  ]);
  return (
    <>
      <PageHeader
        title="Notification Center"
        description="Everything SampCrew told you, by category. Opening a notice takes you to the record it is about."
        actions={<Link href="/settings/notifications" className="text-[0.8125rem] font-medium text-accent hover:underline">Notification &amp; sound settings</Link>}
      />
      <NotificationCenter list={list} summary={summary} query={q.toString()} filter={filter} category={category ?? null} search={sp.q ?? ''} priority={sp.priority ?? ''} />
    </>
  );
}

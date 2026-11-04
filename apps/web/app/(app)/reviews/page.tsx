import { buttonClass, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import type { Me } from '@/lib/types';
import type { FeedbackListItem, ReviewListItem } from '../talent/types';
import { ReviewsView } from './reviews-view';

export const metadata: Metadata = { title: 'Reviews' };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: v } = await searchParams;
  const me = await load<Me>('/me');
  const view = v === 'team' || v === 'feedback' ? v : 'mine';
  const items = await load<(ReviewListItem | FeedbackListItem)[]>(`/reviews?view=${view}`);
  return (
    <>
      <PageHeader
        title="Reviews"
        description="Your performance reviews, the reviews you write for your team, and feedback colleagues asked you for."
        actions={me.permissions['performance:configure'] ? <Link className={buttonClass('secondary', 'sm')} href="/reviews/cycles">Review cycles</Link> : undefined}
      />
      {view === 'mine' && <ModuleOverview module="performance" actions={allowed(me, [
        { label: 'Set goals', href: '/goals?create=goal', icon: 'target', permission: 'performance:read' },
        { label: 'Team reviews', href: '/reviews?view=team', icon: 'messages-square', permission: 'performance:read' },
        { label: 'Feedback', href: '/reviews?view=feedback', icon: 'message-square', permission: 'performance:read' },
        { label: 'Review cycles', href: '/reviews/cycles', icon: 'calendar-range', permission: 'performance:configure' },
      ])} />}
      <ReviewsView view={view} items={items} />
    </>
  );
}

import { buttonClass, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
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
      <ReviewsView view={view} items={items} />
    </>
  );
}

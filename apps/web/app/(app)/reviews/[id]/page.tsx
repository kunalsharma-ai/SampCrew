import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOptional } from '@/lib/api';
import type { ReviewDetail } from '../../talent/types';
import { ReviewView } from './review-view';

export const metadata: Metadata = { title: 'Review' };

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const review = await loadOptional<ReviewDetail>(`/reviews/${id}`);
  if (!review) notFound();
  const back = review.role === 'manager' ? '/reviews?view=team' : review.role === 'hr' ? `/reviews/cycles/${review.cycle.id}` : '/reviews';
  return (
    <>
      <PageHeader
        eyebrow={<Link href={back} className="hover:underline">{review.role === 'hr' ? review.cycle.name : 'Reviews'}</Link>}
        title={review.role === 'employee' ? `Your review: ${review.cycle.name}` : `${review.employeeName}: ${review.cycle.name}`}
        description={`Period ${review.cycle.periodStart} to ${review.cycle.periodEnd}${review.managerName ? ` · reviewed by ${review.managerName}` : ''}`}
      />
      <ReviewView review={review} />
    </>
  );
}

import { Card, EmptyState, PageHeader, buttonClass } from '@crew/ui';
import { MessageSquareText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOptional } from '@/lib/api';
import type { FeedbackForm } from '../../../talent/types';
import { FeedbackView } from './feedback-view';

export const metadata: Metadata = { title: 'Give feedback' };

export default async function FeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const form = await loadOptional<FeedbackForm>(`/feedback/${id}`);
  const eyebrow = <Link href="/reviews?view=feedback" className="hover:underline">Feedback asked of me</Link>;
  if (!form) {
    // A feedback request opens only for the colleague it was sent to: names stay with the manager and HR, who read
    // the answers on the review itself. Anyone else gets a clear explanation instead of a "page not found".
    return (
      <>
        <PageHeader eyebrow={eyebrow} title="Give feedback" />
        <Card data-testid="feedback-not-yours">
          <EmptyState
            icon={<MessageSquareText className="size-5" />}
            title="This feedback request was sent to someone else"
            description="Only the colleague who was asked can open it. Managers and HR read submitted feedback on the review."
            action={<Link href="/reviews?view=feedback" className={buttonClass('primary', 'sm')}>Feedback asked of me</Link>}
          />
        </Card>
      </>
    );
  }
  return (
    <>
      <PageHeader eyebrow={eyebrow} title={`Feedback on ${form.employeeName}`} description={form.cycleName} />
      <FeedbackView form={form} />
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { loadOptional } from '@/lib/api';
import type { FeedbackForm } from '../../../talent/types';
import { FeedbackView } from './feedback-view';

export const metadata: Metadata = { title: 'Give feedback' };

export default async function FeedbackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await loadOptional<FeedbackForm>(`/feedback/${id}`);
  if (!form) notFound();
  return (
    <>
      <PageHeader eyebrow={<Link href="/reviews?view=feedback" className="hover:underline">Feedback asked of me</Link>} title={`Feedback on ${form.employeeName}`} description={form.cycleName} />
      <FeedbackView form={form} />
    </>
  );
}

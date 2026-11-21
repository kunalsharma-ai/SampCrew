import type { SubmissionStatus } from '@crew/contracts';
import { Alert } from '@crew/ui';
import type { Metadata } from 'next';
import { SubNav } from '@/components/sub-nav';
import { load } from '@/lib/api';
import type { LearningAccessView, PendingAttempt, ReviewSubmission } from '../../types';
import { AttemptReviews, SubmissionReviews } from './review-parts';

export const metadata: Metadata = { title: 'Learning reviews' };

const VIEWS = ['submitted', 'quizzes', 'resubmit', 'approved', 'rejected', 'all'] as const;

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view: v } = await searchParams;
  const view = (VIEWS as readonly string[]).includes(v ?? '') ? v! : 'submitted';
  const access = await load<LearningAccessView>('/learning/access');
  if (!access.caps.grade) return <Alert tone="warning">Your Super Workspace has not let your HR Workspace grade assignments.</Alert>;
  const [waiting, attempts] = await Promise.all([load<ReviewSubmission[]>('/learning/reviews/submissions?status=submitted'), load<PendingAttempt[]>('/learning/reviews/attempts')]);
  const list = view === 'submitted' ? waiting : view === 'quizzes' ? [] : await load<ReviewSubmission[]>(`/learning/reviews/submissions?status=${view as SubmissionStatus | 'all'}`);
  const base = '/learning/manage/reviews';
  return (
    <div className="grid gap-4">
      <SubNav label="Review lists" current={`${base}?view=${view}`} items={[
        { href: `${base}?view=submitted`, label: 'Assignments to review', count: waiting.length, alert: true },
        { href: `${base}?view=quizzes`, label: 'Written quiz answers', count: attempts.length, alert: true },
        { href: `${base}?view=resubmit`, label: 'Asked to resubmit' },
        { href: `${base}?view=approved`, label: 'Approved' },
        { href: `${base}?view=rejected`, label: 'Not passed' },
        { href: `${base}?view=all`, label: 'All' },
      ]} />
      {view === 'quizzes' ? <AttemptReviews attempts={attempts} /> : <SubmissionReviews items={list} reviewing={view === 'submitted'} />}
    </div>
  );
}

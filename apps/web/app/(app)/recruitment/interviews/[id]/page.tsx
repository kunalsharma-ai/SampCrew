import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { InterviewDetail } from '@/lib/types';
import { MODE, when } from '../../labels';
import { InterviewView } from './interview-view';

export const metadata: Metadata = { title: 'Interview' };

export default async function InterviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await load<InterviewDetail>(`/recruitment/interviews/${id}`);
  return (
    <>
      <PageHeader
        eyebrow={`${d.interview.requisitionTitle} · ${d.interview.requisitionCode}`}
        title={`${d.interview.title}: ${d.interview.candidateName}`}
        description={`${when(d.interview.startsAt)} · ${d.interview.durationMinutes} minutes · ${MODE[d.interview.mode]}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/recruitment/interviews">My interviews</Link>}
      />
      <InterviewView d={d} />
    </>
  );
}

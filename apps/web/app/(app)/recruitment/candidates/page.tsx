import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Candidate, Me } from '@/lib/types';
import { CandidatesView } from './candidates-view';

export const metadata: Metadata = { title: 'Candidates' };

export default async function CandidatesPage({ searchParams }: { searchParams: Promise<{ q?: string; tag?: string }> }) {
  const { q, tag } = await searchParams;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  const [me, candidates] = await Promise.all([load<Me>('/me'), load<Candidate[]>(`/recruitment/candidates?${params}`)]);
  return (
    <>
      <PageHeader title="Candidates" description="Everyone who has applied or been added, across the jobs you can see." />
      <CandidatesView candidates={candidates} q={q ?? ''} canAdd={me.permissions['candidates:manage'] === 'tenant'} />
    </>
  );
}

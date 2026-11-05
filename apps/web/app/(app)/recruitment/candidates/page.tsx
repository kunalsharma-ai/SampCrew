import type { SavedView } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { Candidate, Me, Requisition } from '@/lib/types';
import { CandidatesView } from './candidates-view';
import { type CandidateSearch, candidateQuery, candidateState, candidateViewUrl } from './view-url';

export const metadata: Metadata = { title: 'Candidates' };

export default async function CandidatesPage({ searchParams }: { searchParams: Promise<CandidateSearch> }) {
  const sp = await searchParams;
  const views = (await loadOptional<SavedView[]>('/me/views?page=candidates')) ?? [];
  // Opening the list with nothing chosen opens the person's default view, if they have one.
  const def = views.find((v) => v.isDefault);
  if (def && Object.keys(sp).length === 0) redirect(candidateViewUrl(def.state, def.id));
  const state = candidateState(sp);
  const [me, candidates, jobs] = await Promise.all([
    load<Me>('/me'),
    load<Candidate[]>(`/recruitment/candidates?${candidateQuery(state)}`),
    loadOptional<Requisition[] | { items: Requisition[] }>('/recruitment/requisitions'),
  ]);
  const jobList = Array.isArray(jobs) ? jobs : (jobs?.items ?? []);
  const activeView = sp.view && views.some((v) => v.id === sp.view) ? sp.view : null;
  return (
    <>
      <PageHeader title="Candidates" description="Everyone who has applied or been added, across the jobs you can see." />
      <CandidatesView
        candidates={candidates}
        state={state}
        views={views}
        activeViewId={activeView}
        jobs={jobList.map((j) => ({ id: j.id, label: `${j.code} · ${j.title}` }))}
        canAdd={me.permissions['candidates:manage'] === 'tenant'}
      />
    </>
  );
}

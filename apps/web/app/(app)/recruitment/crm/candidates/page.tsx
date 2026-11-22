import type { SavedView } from '@crew/contracts';
import { buttonClass } from '@crew/ui';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { CrmContext, CrmField, CrmList } from '../crm-types';
import { crmQuery, type CrmSearch, crmState, crmViewUrl } from '../crm-view-url';
import { CandidateList } from './candidate-list';

export const metadata: Metadata = { title: 'All Candidates · Candidate CRM' };

export default async function CrmCandidatesPage({ searchParams }: { searchParams: Promise<CrmSearch> }) {
  const sp = await searchParams;
  const views = (await loadOptional<SavedView[]>('/me/views?page=candidate_crm')) ?? [];
  const def = views.find((v) => v.isDefault);
  if (def && Object.keys(sp).length === 0) redirect(crmViewUrl(def.state, def.id));
  const state = crmState(sp);
  const page = Math.max(1, Math.min(2000, Number(sp.page) || 1));
  const [ctx, list, fields] = await Promise.all([
    load<CrmContext>('/recruitment/crm/context'),
    load<CrmList>(`/recruitment/crm/candidates?${crmQuery(state, page)}`),
    loadOptional<{ fields: CrmField[] }>('/recruitment/crm/fields'),
  ]);
  const activeView = sp.view && views.some((v) => v.id === sp.view) ? sp.view : null;
  const filterFields = (fields?.fields ?? []).filter((f) => !f.archivedAt && f.enabled && f.flags.includes('filter') && f.type !== 'file');
  return (
    <CrmShell
      ctx={ctx}
      current="/recruitment/crm/candidates"
      title="All Candidates"
      description="Search, filter and work on every candidate you can see."
      actions={<Link href="/recruitment/crm/candidates/new" className={buttonClass('primary', 'sm')}><Plus className="size-3.5" /> Add candidate</Link>}
    >
      <CandidateList ctx={ctx} list={list} state={state} page={page} views={views} activeViewId={activeView} filterFields={filterFields} />
    </CrmShell>
  );
}

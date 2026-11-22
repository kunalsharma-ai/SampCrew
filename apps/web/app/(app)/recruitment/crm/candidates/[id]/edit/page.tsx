import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { CrmShell } from '../../../crm-shell';
import type { CrmContext, CrmProfile } from '../../../crm-types';
import { CandidateForm } from '../../candidate-form';

export const metadata: Metadata = { title: 'Edit candidate · Candidate CRM' };

export default async function EditCrmCandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [ctx, p] = await Promise.all([load<CrmContext>('/recruitment/crm/context'), load<CrmProfile>(`/recruitment/crm/candidates/${id}`)]);
  if (!p.can.edit || p.candidate.anonymizedAt) redirect(`/recruitment/crm/candidates/${id}`);
  const custom = Object.fromEntries(p.customFields.map((f) => [f.key, f.value]));
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/candidates" title={`Edit ${p.candidate.name}`} description={p.candidate.candidateCode ?? undefined}>
      <CandidateForm ctx={ctx} candidate={p.candidate} customValues={custom} />
    </CrmShell>
  );
}

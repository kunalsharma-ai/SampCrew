import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CustomFieldsCard, type FieldValue } from '@/components/custom-fields-card';
import { load, loadOptional } from '@/lib/api';
import type { CandidateDetail, Designation, Me, RecruitPerson, Requisition, Stage } from '@/lib/types';
import { CandidateView } from './candidate-view';

export const metadata: Metadata = { title: 'Candidate' };

export default async function CandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await load<CandidateDetail>(`/recruitment/candidates/${id}`);
  const manages = detail.can.edit;
  const [stages, people, openJobs, designations, fields, me] = await Promise.all([
    load<Stage[]>('/recruitment/settings/stages'),
    manages ? loadOptional<RecruitPerson[]>('/recruitment/people') : null,
    manages ? loadOptional<Requisition[]>('/recruitment/requisitions?status=open') : null,
    loadOptional<Designation[]>('/designations'),
    loadOptional<FieldValue[]>(`/custom-fields/values/candidate/${id}`),
    loadOptional<Me>('/me'),
  ]);
  const c = detail.candidate;
  const name = c.anonymizedAt ? 'Erased candidate' : `${c.firstName} ${c.lastName}`.trim();
  return (
    <>
      <PageHeader
        title={name}
        description={c.anonymizedAt ? `Personal details erased on ${new Date(c.anonymizedAt).toLocaleDateString()}. The anonymous pipeline history is kept.` : [c.currentTitle, c.currentCompany].filter(Boolean).join(' at ') || undefined}
        actions={
          <>
            {me?.candidateCrm && !c.anonymizedAt && <Link className="text-sm font-medium text-accent hover:underline" href={`/recruitment/crm/candidates/${id}`}>Open in Candidate CRM</Link>}
            <Link className="text-sm font-medium text-accent hover:underline" href="/recruitment/candidates">All candidates</Link>
          </>
        }
      />
      <CandidateView detail={detail} stages={stages} people={people ?? []} openJobs={(openJobs ?? []).filter((j) => !detail.applications.some((a) => a.requisitionId === j.id))} designations={designations ?? []} />
      {fields && fields.length > 0 && !c.anonymizedAt && <div className="mt-6"><CustomFieldsCard entity="candidate" recordId={id} initial={fields} path={`/recruitment/candidates/${id}`} /></div>}
    </>
  );
}

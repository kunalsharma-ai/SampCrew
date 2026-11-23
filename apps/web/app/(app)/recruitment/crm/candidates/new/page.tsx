import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { CrmShell } from '../../crm-shell';
import type { CrmContext } from '../../crm-types';
import { CandidateForm } from '../candidate-form';

export const metadata: Metadata = { title: 'Add candidate · Candidate CRM' };

export default async function NewCrmCandidatePage() {
  const ctx = await load<CrmContext>('/recruitment/crm/context');
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/candidates" title="Add candidate" description="Each candidate gets a Candidate ID (CAN-…) when saved. Only add people who shared their details with you for recruitment.">
      <CandidateForm ctx={ctx} />
    </CrmShell>
  );
}

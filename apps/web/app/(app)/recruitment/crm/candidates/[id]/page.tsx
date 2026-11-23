import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { CrmShell } from '../../crm-shell';
import type { CrmContext, CrmProfile } from '../../crm-types';
import { ProfileView } from './profile-view';

export const metadata: Metadata = { title: 'Candidate profile · Candidate CRM' };

const TABS = ['overview', 'remarks', 'references', 'activities', 'follow-ups', 'documents', 'jobs', 'timeline'];

export default async function CrmCandidatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; saved?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [ctx, profile] = await Promise.all([load<CrmContext>('/recruitment/crm/context'), load<CrmProfile>(`/recruitment/crm/candidates/${id}`)]);
  const c = profile.candidate;
  const tab = TABS.includes(sp.tab ?? '') ? sp.tab! : 'overview';
  return (
    <CrmShell
      ctx={ctx}
      current="/recruitment/crm/candidates"
      title={c.anonymizedAt ? 'Erased candidate' : c.name}
      description={c.anonymizedAt ? `Personal details erased on ${new Date(c.anonymizedAt).toLocaleDateString()}. The anonymous history is kept.` : [c.candidateCode, c.currentTitle as string | null, c.currentCompany as string | null].filter(Boolean).join(' · ')}
    >
      <ProfileView ctx={ctx} profile={profile} tab={tab} saved={sp.saved === 'added' ? `Candidate added as ${c.candidateCode}.` : sp.saved === 'updated' ? 'Candidate updated.' : null} />
    </CrmShell>
  );
}

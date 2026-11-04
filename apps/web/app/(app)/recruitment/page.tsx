import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import type { Department, LegalEntity, Location, Me, RecruitPerson, Requisition } from '@/lib/types';
import { JobsView } from './jobs-view';

export const metadata: Metadata = { title: 'Recruitment' };

export default async function RecruitmentPage({ searchParams }: { searchParams: Promise<{ status?: string; scope?: string }> }) {
  const { status, scope } = await searchParams;
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  if (scope === 'mine') q.set('scope', 'mine');
  const [me, reqs, departments, entities, locations, people] = await Promise.all([
    load<Me>('/me'),
    load<Requisition[]>(`/recruitment/requisitions?${q}`),
    loadOptional<Department[]>('/org/departments'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<RecruitPerson[]>('/recruitment/people'),
  ]);
  return (
    <>
      <PageHeader title="Recruitment" description="Job requisitions, from approval to hire. Open a job to manage its posting and pipeline." />
      <ModuleOverview module="recruitment" actions={allowed(me, [
        { label: 'Create job', href: '/recruitment?create=requisition', icon: 'briefcase', permission: 'requisitions:create' },
        { label: 'Candidates', href: '/recruitment/candidates', icon: 'user-search', permission: 'candidates:read' },
        { label: 'Interviews', href: '/recruitment/interviews', icon: 'message-square', permission: 'interviews:feedback' },
        { label: 'Offers', href: '/recruitment/offers', icon: 'handshake', permission: 'offers:manage' },
        { label: 'Recruitment settings', href: '/settings/recruitment', icon: 'sliders', permission: 'recruitment:configure' },
      ])} />
      <JobsView
        reqs={reqs}
        filter={{ status: status ?? '', scope: scope === 'mine' ? 'mine' : 'all' }}
        canCreate={Boolean(me.permissions['requisitions:create'])}
        refs={{ departments: departments ?? [], entities: entities ?? [], locations: locations ?? [], people: people ?? [] }}
        defaults={{ currency: me.tenant.currency, membershipId: me.membership.id }}
      />
    </>
  );
}

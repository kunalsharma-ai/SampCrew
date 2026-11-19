import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { CareerSiteSettings, Role, Stage } from '@/lib/types';
import { ApprovalChainEditor } from '@/components/approval-chain-editor';
import { RecruitmentSettingsView } from './recruitment-settings-view';

export const metadata: Metadata = { title: 'Recruitment settings' };

export default async function RecruitmentSettingsPage() {
  const [stages, site, chain, roles] = await Promise.all([
    load<Stage[]>('/recruitment/settings/stages'),
    load<CareerSiteSettings>('/recruitment/settings/career-site'),
    loadOptional<{ steps: { type: string; role?: string }[]; fallbackRole: string }>('/approvals/policies/job_requisition'),
    loadOptional<Role[]>('/roles'),
  ]);
  return (
    <>
      <PageHeader title="Recruitment settings" description="Your hiring pipeline stages, public career site and who approves new job requisitions." />
      <div className="grid gap-6">
        {chain && (
          <ApprovalChainEditor resourceType="job_requisition" title="Job requisition approval chain" steps={chain.steps} fallbackRole={chain.fallbackRole} roles={roles ?? []}
            note="When the only Owner of the workspace raises a requisition and nobody else can approve it, it is approved automatically and recorded in the audit trail." />
        )}
        <RecruitmentSettingsView stages={stages} site={site} />
      </div>
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { CareerSiteSettings, Stage } from '@/lib/types';
import { RecruitmentSettingsView } from './recruitment-settings-view';

export const metadata: Metadata = { title: 'Recruitment settings' };

export default async function RecruitmentSettingsPage() {
  const [stages, site] = await Promise.all([load<Stage[]>('/recruitment/settings/stages'), load<CareerSiteSettings>('/recruitment/settings/career-site')]);
  return (
    <>
      <PageHeader title="Recruitment settings" description="Your hiring pipeline stages and public career site." />
      <RecruitmentSettingsView stages={stages} site={site} />
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { OnboardingTemplate } from '@/lib/types';
import { TemplatesView } from './templates-view';

export const metadata: Metadata = { title: 'Onboarding checklists' };

export default async function OnboardingSettingsPage() {
  const templates = await load<OnboardingTemplate[]>('/onboarding/templates');
  return (
    <>
      <PageHeader title="Onboarding checklists" description="Templates copied onto each new joiner. Changing a template does not change checklists already started." />
      <TemplatesView templates={templates} />
    </>
  );
}

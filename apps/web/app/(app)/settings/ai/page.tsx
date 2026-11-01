import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { AiSettings, AiUsage } from '../../ai/types';
import { AiSettingsForm } from './ai-settings';

export const metadata: Metadata = { title: 'AI settings' };

export default async function AiSettingsPage() {
  const [settings, usage] = await Promise.all([load<AiSettings>('/ai/settings'), load<AiUsage>('/ai/usage')]);
  return (
    <>
      <PageHeader title="AI settings" description="Choose which AI features people in this workspace can use. Every feature starts switched off, works only within each person's own access, and is logged for your auditors." />
      <AiSettingsForm settings={settings} usage={usage} />
    </>
  );
}

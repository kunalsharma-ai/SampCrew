import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { WorkModeSettingsForm, type SettingsView } from './settings-form';

export const metadata: Metadata = { title: 'Office and home attendance rules' };

export default async function WorkModeSettingsPage() {
  const v = await load<SettingsView>('/attendance/work-mode/settings');
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/attendance/work-mode" className="hover:underline">Workforce attendance</Link>}
        title="Office and home attendance rules"
        description="How each day is classified as office, home or hybrid, what the three are called, and how long locations are kept."
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/attendance/offices">Office locations</Link>}
      />
      <WorkModeSettingsForm view={v} />
    </>
  );
}

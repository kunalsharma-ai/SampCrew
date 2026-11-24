import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { settingsHub } from '@/lib/settings-hub';
import type { Me } from '@/lib/types';
import { SettingsHub } from './settings-hub';

export const metadata: Metadata = { title: 'Settings' };

/** One place for every setting the person may change, by category, with search. */
export default async function SettingsPage() {
  const me = await load<Me>('/me');
  return (
    <>
      <PageHeader title="Settings" description="Every setting you can change, in one place. Each one lives on a single page, so nothing is set twice." />
      <SettingsHub categories={settingsHub(me)} />
    </>
  );
}

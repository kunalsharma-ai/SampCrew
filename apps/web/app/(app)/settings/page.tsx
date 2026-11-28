import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { inMyDay } from '@/lib/my-day';
import { settingsHub } from '@/lib/settings-hub';
import type { Me } from '@/lib/types';
import { SettingsHub } from './settings-hub';

export const metadata: Metadata = { title: 'Settings' };

/** One place for every setting the person may change, by category, with search. In My Day, only their own account. */
export default async function SettingsPage() {
  const me = await load<Me>('/me');
  const myDay = await inMyDay(me);
  const categories = settingsHub(me).filter((c) => !myDay || c.key === 'you');
  return (
    <>
      <PageHeader
        title="Settings"
        description={myDay ? 'Your own account settings. Switch to your workforce view in the menu for the company settings.' : 'Every setting you can change, in one place. Each one lives on a single page, so nothing is set twice.'}
      />
      <SettingsHub categories={categories} />
    </>
  );
}

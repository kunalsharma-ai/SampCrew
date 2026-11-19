import type { NotificationPreferences } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { NotificationSettings } from './notification-settings';

export const metadata: Metadata = { title: 'Notification settings' };

export default async function NotificationSettingsPage() {
  const prefs = await load<NotificationPreferences>('/notifications/preferences');
  return (
    <>
      <PageHeader title="Notification settings" description="Choose what you are told about in SampCrew and by email, and whether important notices make a sound. These settings are yours alone." />
      <NotificationSettings initial={prefs} />
    </>
  );
}

import type { NotificationPolicy } from '@crew/contracts';
import { EmptyState, PageHeader } from '@crew/ui';
import { ShieldAlert } from 'lucide-react';
import type { Metadata } from 'next';
import { loadOptional, loadSession } from '@/lib/api';
import type { Me } from '@/lib/types';
import { PolicyEditor } from './policy-editor';

export const metadata: Metadata = { title: 'Notification policy' };

/**
 * The organisation's notification rules (Super Workspace only): what everyone must see or be emailed, whether sound,
 * desktop and phone notifications are allowed, and the starting choices for people who did not choose themselves.
 */
export default async function NotificationPolicyPage() {
  const me = await loadSession<Me>('/me');
  const data = me.levels?.super ? await loadOptional<{ policy: NotificationPolicy; updatedAt: string | null; members: number }>('/notifications/policy') : null;
  return (
    <>
      <PageHeader title="Notification policy" description="Rules for everyone in your organisation. People choose their own notification settings inside these rules; what you require here they cannot switch off." />
      {data ? <PolicyEditor initial={data} /> : <EmptyState icon={<ShieldAlert className="size-5" />} title="Only the Super Workspace sets the notification policy" description="Your own notification settings are on Settings > Notification settings." />}
    </>
  );
}

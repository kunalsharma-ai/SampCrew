import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { RequestSettingsView } from '../../requests/types';
import { RequestSettingsEditor } from './settings-editor';

export const metadata: Metadata = { title: 'Requests & approvals' };

/** Settings > Request & Approval: categories, which levels may raise each, how each is approved, and the rules. */
export default async function RequestSettingsPage() {
  const data = await load<RequestSettingsView>('/requests/settings');
  return (
    <>
      <PageHeader title="Requests & approvals" description="The request categories people can raise, who may raise each, how each is approved (one approver, all of them, or one after another), and the rules for leave cancellations and reminders. Changes are audited." />
      <RequestSettingsEditor initial={data.settings} canManage={data.canManage} workflows={data.workflows} />
    </>
  );
}

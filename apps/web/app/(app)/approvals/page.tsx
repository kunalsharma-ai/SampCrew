import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { InboxItem } from '@/lib/types';
import { InboxView } from './inbox-view';

export const metadata: Metadata = { title: 'Approvals' };

export default async function ApprovalsPage() {
  const items = await load<InboxItem[]>('/approvals/inbox');
  return (
    <>
      <PageHeader title="Approvals" description="Requests waiting for your decision. You never see your own requests here, and every decision is recorded in the audit trail." />
      <InboxView items={items} />
    </>
  );
}

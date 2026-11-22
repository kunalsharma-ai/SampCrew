import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { loadInbox } from './data';
import { SupportInbox } from './support-inbox';

export const metadata: Metadata = { title: 'Support inbox' };

type Search = { q?: string; state?: string; tenant?: string };

export default async function SupportInboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const inbox = await loadInbox(sp);
  return (
    <>
      <PageHeader title="Support inbox" description="Private conversations between each Super Workspace and the Console Admin team. Any Console Admin with support access can answer; your name is recorded on each reply." />
      <SupportInbox inbox={inbox} detail={null} search={sp} />
    </>
  );
}

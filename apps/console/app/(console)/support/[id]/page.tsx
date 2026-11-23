import type { SupportConversationDetail } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, load } from '@/lib/api';
import { loadInbox } from '../data';
import { SupportInbox } from '../support-inbox';

export const metadata: Metadata = { title: 'Support conversation' };

type Search = { q?: string; state?: string; tenant?: string };

export default async function SupportConversationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [detail, inbox] = await Promise.all([
    load<SupportConversationDetail>(`/platform/support/conversations/${id}`).catch((e) => (e instanceof ApiError && e.status === 404 ? null : Promise.reject(e))),
    loadInbox(sp),
  ]);
  if (!detail) notFound();
  return (
    <>
      <PageHeader title="Support inbox" description="Private conversations between each Super Workspace and the Console Admin team. Any Console Admin with support access can answer; your name is recorded on each reply." />
      <SupportInbox inbox={inbox} detail={detail} search={sp} />
    </>
  );
}

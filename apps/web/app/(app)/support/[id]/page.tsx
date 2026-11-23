import type { SupportConversationDetail } from '@crew/contracts';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import { NotSuper, SupportFrame, type SupportList } from '../frame';
import { SupportApp } from '../support-app';

export const metadata: Metadata = { title: 'SampCrew Support' };

export default async function SupportConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await load<Me>('/me');
  if (!me.levels?.super) return <SupportFrame me={me}><NotSuper /></SupportFrame>;
  const [detail, list] = await Promise.all([load<SupportConversationDetail>(`/support/conversations/${id}`), load<SupportList>('/support/conversations')]);
  return (
    <SupportFrame me={me}>
      <SupportApp list={list.items} detail={detail} startNew={false} me={me.membership.id} />
    </SupportFrame>
  );
}

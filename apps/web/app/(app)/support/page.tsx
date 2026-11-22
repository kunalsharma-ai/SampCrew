import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import { NotSuper, SupportFrame, type SupportList } from './frame';
import { SupportApp } from './support-app';

export const metadata: Metadata = { title: 'SampCrew Support' };

export default async function SupportPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const { new: startNew } = await searchParams;
  const me = await load<Me>('/me');
  if (!me.levels?.super) return <SupportFrame me={me}><NotSuper /></SupportFrame>;
  const list = await load<SupportList>('/support/conversations');
  return (
    <SupportFrame me={me}>
      <SupportApp list={list.items} detail={null} startNew={startNew === '1' || !list.items.length} me={me.membership.id} />
    </SupportFrame>
  );
}

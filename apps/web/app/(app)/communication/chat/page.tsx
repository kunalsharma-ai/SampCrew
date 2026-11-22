import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Department, Me } from '@/lib/types';
import { CommTabs } from '../comm-tabs';
import type { ConversationList } from '../types';
import { ChatApp } from './chat-app';

export const metadata: Metadata = { title: 'Chat' };

export default async function ChatPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const { new: startNew } = await searchParams;
  const me = await load<Me>('/me');
  const isHr = can(me, 'helpdesk:manage');
  const [list, departments] = await Promise.all([
    load<ConversationList>('/communication/conversations'),
    isHr ? loadOptional<Department[]>('/org/departments') : Promise.resolve(null),
  ]);
  // The Super Workspace's SampCrew Support conversations show as a pinned entry in the chat list.
  const support = me.levels?.super ? await loadOptional<{ unread: number; allowed: boolean }>('/support/unread') : null;
  return (
    <>
      <PageHeader title="Communication" description="Chat one to one, in groups and departments, and with the HR team. Every message shows who sent it, their level and workspace." />
      <CommTabs active="chat" isHr={isHr} unread={list.unread} superWs={!!me.levels?.super} supportUnread={support?.unread} />
      <ChatApp list={list.items} detail={null} isHr={isHr} departments={(departments ?? []).map((d) => ({ id: d.id, name: d.name }))} startNew={startNew === '1'} me={me.membership.id} support={support?.allowed ? { unread: support.unread } : null} />
    </>
  );
}

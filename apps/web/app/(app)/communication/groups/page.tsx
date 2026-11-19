import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { CommTabs } from '../comm-tabs';
import type { ConversationList, Group } from '../types';
import { GroupsView } from './groups-view';

export const metadata: Metadata = { title: 'Groups' };

export default async function GroupsPage() {
  const me = await load<Me>('/me');
  if (!can(me, 'helpdesk:manage')) redirect('/communication/chat');
  const [groups, chats] = await Promise.all([load<{ items: Group[] }>('/communication/groups'), load<ConversationList>('/communication/conversations')]);
  return (
    <>
      <PageHeader title="Communication" description="Groups are your own lists of people. Send emails and announcements to a group as well as to departments and designations." />
      <CommTabs active="groups" isHr unread={chats.unread} />
      <GroupsView groups={groups.items} />
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Announcement } from '../../helpdesk/types';
import { ManageAnnouncements } from './manage-announcements';

export const metadata: Metadata = { title: 'Manage announcements' };

export default async function ManageAnnouncementsPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const deleted = (await searchParams).deleted === 'true';
  const items = await load<Announcement[]>(`/announcements/manage${deleted ? '?deleted=true' : ''}`);
  return (
    <>
      <PageHeader title="Manage announcements" description="Write an announcement, choose who it is for, then publish it now or schedule it. Publishing notifies everyone in the audience. Edits after publishing are saved as new versions." />
      <ManageAnnouncements items={items} deleted={deleted} />
    </>
  );
}

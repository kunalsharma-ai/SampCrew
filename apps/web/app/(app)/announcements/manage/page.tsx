import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Department, LegalEntity, Location } from '@/lib/types';
import type { Announcement } from '../../helpdesk/types';
import { ManageAnnouncements } from './manage-announcements';

export const metadata: Metadata = { title: 'Manage announcements' };

export default async function ManageAnnouncementsPage() {
  const [items, entities, departments, locations] = await Promise.all([
    load<Announcement[]>('/announcements/manage'),
    load<LegalEntity[]>('/org/legal-entities'),
    load<Department[]>('/org/departments'),
    load<Location[]>('/org/locations'),
  ]);
  return (
    <>
      <PageHeader title="Manage announcements" description="Write a draft, choose who it is for, then publish. Publishing notifies everyone in the audience; after that the text cannot change." />
      <ManageAnnouncements items={items} entities={entities} departments={departments} locations={locations} />
    </>
  );
}

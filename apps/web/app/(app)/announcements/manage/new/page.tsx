import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { LegalEntity, Location } from '@/lib/types';
import { loadAudienceOptions } from '../../../communication/audience-options';
import { AnnouncementComposer } from '../composer';

export const metadata: Metadata = { title: 'New announcement' };

export default async function NewAnnouncementPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const { group } = await searchParams;
  const [{ options, knownNames }, entities, locations] = await Promise.all([loadAudienceOptions(), load<LegalEntity[]>('/org/legal-entities'), load<Location[]>('/org/locations')]);
  return (
    <>
      <PageHeader title="New announcement" description="Choose who it is for, write it, then publish now or schedule it. People are notified when it is published."
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/announcements/manage">All announcements</Link>} />
      <AnnouncementComposer a={null} initialGroup={group && /^[0-9a-f-]{36}$/.test(group) ? group : undefined} options={options} knownNames={knownNames} entities={entities} locations={locations} />
    </>
  );
}

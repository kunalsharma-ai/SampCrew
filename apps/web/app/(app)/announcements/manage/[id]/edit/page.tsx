import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import type { LegalEntity, Location } from '@/lib/types';
import { loadAudienceOptions } from '../../../../communication/audience-options';
import type { Announcement } from '../../../../helpdesk/types';
import { AnnouncementComposer } from '../../composer';

export const metadata: Metadata = { title: 'Edit announcement' };

export default async function EditAnnouncementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [a, { options, knownNames }, entities, locations] = await Promise.all([
    load<Announcement & { people: { membershipId: string; name: string }[] }>(`/announcements/manage/${id}`), loadAudienceOptions(), load<LegalEntity[]>('/org/legal-entities'), load<Location[]>('/org/locations'),
  ]);
  if (a.status === 'archived' || a.deletedAt) redirect(`/announcements/manage/${id}`);
  // People already chosen by name show their names.
  const names = { ...knownNames, ...Object.fromEntries(a.people.map((p) => [p.membershipId, p.name])) };
  return (
    <>
      <PageHeader eyebrow={a.status === 'published' ? `Published · version ${a.version}` : a.status === 'scheduled' ? 'Scheduled' : 'Draft'} title={`Edit: ${a.title}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={`/announcements/manage/${id}`}>Back to the announcement</Link>} />
      <AnnouncementComposer a={a} options={options} knownNames={names} entities={entities} locations={locations} />
    </>
  );
}

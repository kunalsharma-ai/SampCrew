import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { OfficesView, type PlacesData } from './offices-view';

export const metadata: Metadata = { title: 'Office locations' };

/** Offices with their geofence on a map, approved work sites and who may work where (office / home attendance). */
export default async function OfficesPage() {
  const data = await load<PlacesData>('/attendance/work-mode/places');
  return (
    <>
      <PageHeader
        title="Office locations"
        eyebrow="Attendance"
        description="A check-in inside an office area counts as office attendance; anywhere else counts as home. Approved sites can count as either."
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/attendance/work-mode">Workforce attendance</Link>}
      />
      <OfficesView data={data} />
    </>
  );
}

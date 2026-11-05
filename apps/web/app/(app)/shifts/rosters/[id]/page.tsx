import { PageHeader, StatusPill } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { dayLabel } from '@/lib/time';
import type { RosterGrid, ShiftTemplate } from '@/lib/types';
import { RosterEditor } from './roster-editor';

export const metadata: Metadata = { title: 'Roster' };

export default async function RosterPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [roster, shifts] = await Promise.all([load<RosterGrid>(`/shifts/rosters/${id}`), load<ShiftTemplate[]>('/shifts/templates')]);
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/shifts" className="hover:underline">Shifts</Link>}
        title={roster.name}
        description={`${dayLabel(roster.startDate)} to ${dayLabel(roster.endDate)}. ${roster.status === 'draft' ? 'Draft: nothing changes for anyone until you publish.' : 'Published: changes apply as soon as you save.'}`}
        actions={<StatusPill status={roster.status} />}
      />
      <RosterEditor roster={roster} shifts={shifts} />
    </>
  );
}

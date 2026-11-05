import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Designation, LegalEntity, Me } from '@/lib/types';
import { BidEditor } from '../../bid-editor';
import type { BidTemplate, Client, RateCard } from '../../types';

export const metadata: Metadata = { title: 'New staffing bid' };

export default async function NewBidPage({ searchParams }: { searchParams: Promise<{ mode?: string; clientId?: string; people?: string; role?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  if (!can(me, 'bids:manage')) redirect('/staffing/bids');
  const [clients, templates, entities, designations, rateCards] = await Promise.all([
    load<Client[]>('/staffing/clients'),
    load<BidTemplate[]>('/staffing/templates'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Designation[]>('/designations'),
    loadOptional<RateCard[]>('/staffing/rate-cards'),
  ]);
  const people = /^\d{1,4}$/.test(sp.people ?? '') && Number(sp.people) > 0 ? Number(sp.people) : undefined;
  const initialLine = sp.role || people ? { roleTitle: sp.role?.trim() || undefined, headcount: people } : undefined;
  const mode = sp.mode === 'advanced' ? 'advanced' : 'quick';
  return (
    <>
      <PageHeader eyebrow="Staffing bids" title={mode === 'quick' ? 'Quick Bid' : 'New bid'} description="The price updates as you type. Finance approves every bid before the proposal can go to the client." />
      <BidEditor bid={null} initialMode={mode} initialClientId={sp.clientId} initialLine={initialLine} clients={clients} templates={templates} entities={entities ?? []} designations={designations ?? []} rateCards={rateCards ?? []} />
    </>
  );
}

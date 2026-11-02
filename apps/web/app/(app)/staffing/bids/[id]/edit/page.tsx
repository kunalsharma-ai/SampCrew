import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { Designation, LegalEntity } from '@/lib/types';
import { BidEditor } from '../../../bid-editor';
import type { Bid, BidTemplate, Client, RateCard } from '../../../types';

export const metadata: Metadata = { title: 'Edit staffing bid' };

export default async function EditBidPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const bid = await loadOptional<Bid>(`/staffing/bids/${id}`);
  if (!bid) notFound();
  if (!bid.can.edit) redirect(`/staffing/bids/${id}`);
  const [clients, templates, entities, designations, rateCards] = await Promise.all([
    load<Client[]>('/staffing/clients'),
    load<BidTemplate[]>('/staffing/templates'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Designation[]>('/designations'),
    loadOptional<RateCard[]>('/staffing/rate-cards'),
  ]);
  const reopens = bid.status === 'approved' || bid.status === 'sent';
  return (
    <>
      <PageHeader
        eyebrow={`${bid.code} · version ${bid.version}`}
        title={`Edit ${bid.title}`}
        description={reopens ? 'This bid was already approved. Saving a change makes a new version that Finance approves again; what was sent stays in the history.' : 'Change the roles, pricing or proposal text.'}
      />
      <BidEditor bid={bid} initialMode={bid.mode} clients={clients} templates={templates} entities={entities ?? []} designations={designations ?? []} rateCards={rateCards ?? []} />
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import type { Client, RateCard } from '../types';
import { RateCardsView } from './rate-cards-view';

export const metadata: Metadata = { title: 'Rate cards' };

export default async function RateCardsPage() {
  const me = await load<Me>('/me');
  const [cards, clients] = await Promise.all([load<RateCard[]>('/staffing/rate-cards'), load<Client[]>('/staffing/clients')]);
  return (
    <>
      <PageHeader title="Rate cards" description="Standard monthly pay and bill rates per role, for every client or agreed with one. A bid that uses a card fills its rates from it, and Finance sees any role billed below the card." />
      <RateCardsView cards={cards} clients={clients} canManage={can(me, 'bids:manage')} />
    </>
  );
}

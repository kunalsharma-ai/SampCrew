import { BID_STATUSES } from '@crew/contracts';
import { PageHeader, buttonClass } from '@crew/ui';
import { Plus, Zap } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import type { BidSummary, Client } from '../types';
import { BidsList } from './bids-list';

export const metadata: Metadata = { title: 'Staffing bids' };

type Search = { status?: string; q?: string; clientId?: string };

export default async function BidsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.status && (BID_STATUSES as readonly string[]).includes(sp.status)) qs.set('status', sp.status);
  if (sp.q) qs.set('q', sp.q.slice(0, 120));
  if (sp.clientId && /^[0-9a-f-]{36}$/.test(sp.clientId)) qs.set('clientId', sp.clientId);
  const [me, bids, clients] = await Promise.all([
    load<Me>('/me'),
    load<BidSummary[]>(`/staffing/bids?${qs}`),
    load<Client[]>('/staffing/clients'),
  ]);
  const manage = can(me, 'bids:manage');
  return (
    <>
      <PageHeader
        title="Staffing bids"
        description="Price staffing proposals for clients, get them approved by Finance, send the PDF and track what you win."
        actions={manage ? (
          <div className="flex gap-2">
            <Link href="/staffing/bids/new?mode=quick" className={buttonClass('secondary')}><Zap className="size-4" /> Quick Bid</Link>
            <Link href="/staffing/bids/new?mode=advanced" className={buttonClass('primary')}><Plus className="size-4" /> New bid</Link>
          </div>
        ) : undefined}
      />
      <BidsList bids={bids} clients={clients} filters={{ status: qs.get('status') ?? '', q: sp.q ?? '', clientId: qs.get('clientId') ?? '' }} />
    </>
  );
}

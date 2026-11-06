'use client';
import { BID_STATUSES, formatAmount } from '@crew/contracts';
import { Badge, Card, type DataColumn, DataTable, EmptyState, Input, Select, Stat } from '@crew/ui';
import { Handshake, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { BID_STATUS_LABEL, BID_STATUS_TONE, type BidSummary, type Client } from '../types';

const money = (v: string, c: string) => `${c} ${formatAmount(v, c)}`;
const COLUMNS: DataColumn<BidSummary>[] = [
  {
    key: 'bid', label: 'Bid', required: true,
    render: (b) => (
      <Link href={`/staffing/bids/${b.id}`} className="block" onClick={(e) => e.stopPropagation()}>
        <span className="block font-medium">{b.title}</span>
        <span className="block text-xs text-fg-subtle"><span className="font-mono">{b.code}</span> · v{b.version} · {b.mode === 'quick' ? 'Quick Bid' : 'Advanced Bid'}</span>
      </Link>
    ),
  },
  { key: 'client', label: 'Client', render: (b) => b.clientName },
  { key: 'people', label: 'People', className: 'tabular-nums text-right', render: (b) => b.headcount },
  { key: 'monthly', label: 'Monthly billing', className: 'tabular-nums text-right whitespace-nowrap', render: (b) => money(b.monthlyRevenue, b.currency) },
  { key: 'value', label: 'Contract value', className: 'tabular-nums text-right whitespace-nowrap', render: (b) => money(b.contractRevenue, b.currency) },
  {
    key: 'margin', label: 'Margin', className: 'text-right',
    render: (b) => <Badge tone={Number(b.marginPct) < 0 ? 'danger' : Number(b.marginPct) < Number(b.targetMarginPct) ? 'warning' : 'success'}>{b.marginPct}%</Badge>,
  },
  { key: 'status', label: 'Status', render: (b) => <Badge tone={BID_STATUS_TONE[b.status]} dot>{BID_STATUS_LABEL[b.status]}</Badge> },
  { key: 'owner', label: 'Owner', render: (b) => <span className="text-fg-muted">{b.ownerName}</span> },
  { key: 'updated', label: 'Updated', className: 'whitespace-nowrap text-fg-muted', render: (b) => new Date(b.updatedAt).toLocaleDateString() },
];
const ALL = COLUMNS.map((c) => c.key);

/** Totals by currency, so a list with INR and USD bids never adds the two together. */
function totals(bids: BidSummary[], pick: (b: BidSummary) => boolean) {
  const by = new Map<string, number>();
  for (const b of bids.filter(pick)) by.set(b.currency, (by.get(b.currency) ?? 0) + Number(b.contractRevenue));
  if (!by.size) return '—';
  return [...by].map(([c, v]) => money(v.toFixed(2), c)).join(' + ');
}

export function BidsList({ bids, clients, filters }: { bids: BidSummary[]; clients: Client[]; filters: { status: string; q: string; clientId: string } }) {
  const router = useRouter();
  const [visible, setVisible] = useState(ALL);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [q, setQ] = useState(filters.q);
  const go = (patch: Partial<typeof filters>) => {
    const next = { ...filters, ...patch };
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v));
    router.push(`/staffing/bids${qs.size ? `?${qs}` : ''}`);
  };
  const decided = bids.filter((b) => b.status === 'won' || b.status === 'lost');
  const won = bids.filter((b) => b.status === 'won').length;
  const filtered = Boolean(filters.status || filters.q || filters.clientId);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open pipeline" value={totals(bids, (b) => ['draft', 'pending_approval', 'approved', 'rejected', 'sent'].includes(b.status))} hint="Contract value of bids not yet decided" />
        <Stat label="Waiting for approval" value={bids.filter((b) => b.status === 'pending_approval').length} />
        <Stat label="Won" value={totals(bids, (b) => b.status === 'won')} hint={`${won} ${won === 1 ? 'bid' : 'bids'}`} />
        <Stat label="Win rate" value={decided.length ? `${Math.round((won / decided.length) * 100)}%` : '—'} hint={decided.length ? `${won} of ${decided.length} decided` : 'No outcomes yet'} />
      </div>
      <Card>
        <DataTable
          label="Staffing bids"
          columns={COLUMNS}
          visible={visible}
          onVisibleChange={setVisible}
          density={density}
          onDensityChange={setDensity}
          rows={bids}
          rowKey={(b) => b.id}
          onRowClick={(b) => router.push(`/staffing/bids/${b.id}`)}
          toolbar={(
            <>
              <form className="relative flex-1" onSubmit={(e) => { e.preventDefault(); go({ q: q.trim() }); }}>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
                <Input aria-label="Search bids" placeholder="Search by title, code or client" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
              </form>
              <Select aria-label="Status" value={filters.status} onChange={(e) => go({ status: e.target.value })} className="sm:w-48">
                <option value="">All statuses</option>
                {BID_STATUSES.map((s) => <option key={s} value={s}>{BID_STATUS_LABEL[s]}</option>)}
              </Select>
              <Select aria-label="Client" value={filters.clientId} onChange={(e) => go({ clientId: e.target.value })} className="sm:w-48">
                <option value="">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </>
          )}
          empty={(
            <EmptyState
              icon={<Handshake className="size-5" />}
              title={filtered ? 'No bids match' : 'No staffing bids yet'}
              description={filtered ? 'Try another status, client or search.' : 'Start with a Quick Bid: pick a client, the role, people and pay, and SampCrew works out the rate from your target margin.'}
            />
          )}
          footer={<p className="px-5 py-3 text-xs text-fg-subtle">{bids.length} {bids.length === 1 ? 'bid' : 'bids'}</p>}
        />
      </Card>
    </div>
  );
}

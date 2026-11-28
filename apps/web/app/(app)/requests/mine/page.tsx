import { REQUEST_STATUSES } from '@crew/contracts';
import { EmptyState, PageHeader, cn } from '@crew/ui';
import { Plane, Plus, Send } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { LiveRefresh } from '../[id]/request-actions';
import { RequestCard } from '../request-card';
import type { RequestList } from '../types';

export const metadata: Metadata = { title: 'My Requests' };

const TABS = [
  { key: '', label: 'All' }, { key: 'pending', label: 'Pending' }, { key: 'changes_requested', label: 'Changes requested' }, { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' }, { key: 'cancelled', label: 'Cancelled' },
] as const;

/** My Requests: every request and leave application the person raised, where each stands, and who it waits for. */
export default async function MyRequestsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const status = (REQUEST_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status! : '';
  const list = await load<RequestList>(`/requests${status ? `?status=${status}` : ''}`);
  return (
    <>
      <LiveRefresh />
      <PageHeader title="My Requests" description="Your requests and leave applications: the Request ID, dates, status, who it is waiting for, and every comment."
        actions={<div className="flex flex-wrap gap-2">
          <Link href="/leave/apply" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[0.8125rem] font-medium text-fg hover:bg-bg-subtle"><Plane className="size-4" /> Apply for leave</Link>
          <Link href="/requests/new" className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[0.8125rem] font-semibold text-accent-fg shadow-card hover:bg-accent-hover"><Plus className="size-4" /> Create request</Link>
        </div>} />
      <nav aria-label="Filter requests" className="mb-4 flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1 shadow-card">
        {TABS.map((t) => (
          <Link key={t.key} href={t.key ? `/requests/mine?status=${t.key}` : '/requests/mine'} aria-current={status === t.key ? 'page' : undefined}
            className={cn('rounded-lg px-3 py-1.5 text-[0.8125rem] font-medium', status === t.key ? 'bg-accent text-accent-fg shadow-card' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
            {t.label} <span className="tabular opacity-80">{t.key ? list.counts[t.key] : list.counts.all}</span>
          </Link>
        ))}
      </nav>
      {list.items.length ? (
        <ul className="grid gap-3" data-testid="my-requests">{list.items.map((r) => <RequestCard key={r.id} r={r} />)}</ul>
      ) : (
        <EmptyState icon={<Send className="size-5" />} title={status ? 'No requests with this status' : 'No requests yet'} description="Requests and leave applications you submit appear here, with each approver's decision and comment." />
      )}
    </>
  );
}

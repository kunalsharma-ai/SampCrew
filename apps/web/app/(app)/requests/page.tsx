import { REQUEST_STATUSES } from '@crew/contracts';
import { EmptyState, PageHeader, cn } from '@crew/ui';
import { Inbox, Plus, Send } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { KindTile, RequestsIllustration } from './kind-visual';
import { RequestCard } from './request-card';
import type { RequestList, RequestOptions } from './types';

export const metadata: Metadata = { title: 'Requests' };

const TABS = [
  { key: '', label: 'All' }, { key: 'pending', label: 'Pending' }, { key: 'approved', label: 'Approved' }, { key: 'rejected', label: 'Rejected' }, { key: 'cancelled', label: 'Cancelled' },
] as const;

/**
 * Requests: raise a request (work from home, early leave, late coming, comp off, leave ...) to the people you choose,
 * and follow each one: who approved, who is still deciding, and their comments. The same page at every level.
 */
export default async function RequestsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const status = (REQUEST_STATUSES as readonly string[]).includes(sp.status ?? '') ? sp.status! : '';
  const [options, list] = await Promise.all([
    load<RequestOptions>('/requests/options'),
    load<RequestList>(`/requests${status ? `?status=${status}` : ''}`),
  ]);
  const first = options.me.name.split(' ')[0];
  return (
    <>
      <PageHeader title="Requests" eyebrow={options.me.levelLabel} description="Ask for work from home, early leave, late coming, comp off, leave and more. Loop in your HR, your reporting manager or anyone else: each of them gets it in Approvals." />

      <section aria-label="Raise a request" className="relative mb-6 overflow-hidden rounded-2xl border border-accent/20 bg-gradient-to-br from-accent-subtle via-surface to-surface p-5 shadow-card sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-accent/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-5 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold tracking-tight text-fg">Hi {first}, what do you need?</h2>
            <p className="mt-1 max-w-xl text-[0.8125rem] text-fg-muted">Pick a type, give the dates, times and reason, and choose who should approve. You will see every decision and comment here, and get a notification as each one arrives.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/requests/new" className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg shadow-card hover:bg-accent-hover" data-testid="raise-request"><Plus className="size-4" /> Raise a request</Link>
              <Link href="/approvals" className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-fg hover:bg-bg-subtle"><Inbox className="size-4" /> Requests waiting for me</Link>
            </div>
          </div>
          <RequestsIllustration className="mx-auto h-36 w-auto shrink-0 md:mx-0 md:h-40" />
        </div>
      </section>

      <section aria-labelledby="types" className="mb-8">
        <h2 id="types" className="mb-3 text-[0.9375rem] font-semibold text-fg">Raise a request</h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {options.kinds.map((k) => (
            <li key={k.key}>
              <Link href={`/requests/new?kind=${k.key}`} className="group flex h-full items-center gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-pop" data-testid={`kind-${k.key}`}>
                <KindTile kind={k.key} />
                <span className="min-w-0">
                  <span className="block text-[0.875rem] font-semibold text-fg">{k.label}</span>
                  <span className="block text-xs text-fg-muted">{k.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="mine">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="mine" className="text-[0.9375rem] font-semibold text-fg">My requests</h2>
          <nav aria-label="Filter requests" className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1">
            {TABS.map((t) => {
              const n = t.key ? list.counts[t.key] : list.counts.all;
              return (
                <Link key={t.key} href={t.key ? `/requests?status=${t.key}` : '/requests'} aria-current={status === t.key ? 'page' : undefined}
                  className={cn('rounded-md px-2.5 py-1 text-xs font-medium', status === t.key ? 'bg-accent text-accent-fg' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
                  {t.label} <span className="tabular opacity-80">{n}</span>
                </Link>
              );
            })}
          </nav>
        </div>
        {list.items.length ? (
          <ul className="grid gap-3" data-testid="my-requests">{list.items.map((r) => <RequestCard key={r.id} r={r} />)}</ul>
        ) : (
          <EmptyState icon={<Send className="size-5" />} title={status ? `No ${status} requests` : 'No requests yet'} description="Requests you raise appear here, with each approver's decision and comment." />
        )}
      </section>
    </>
  );
}

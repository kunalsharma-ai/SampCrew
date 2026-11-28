import { EmptyState, PageHeader } from '@crew/ui';
import { ArrowRight, Inbox, ListChecks, Plane, Plus, Send } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { KindTile, RequestsIllustration } from './kind-visual';
import { RequestCard } from './request-card';
import type { RequestList, RequestOptions, RequestSummary } from './types';

export const metadata: Metadata = { title: 'Requests' };

/**
 * Requests: create a request (work from home, early leave, late arrival, comp off, attendance regularization ...) or
 * apply for leave, then follow it in My Requests; requests for your decision are in My Approvals. Every level.
 */
export default async function RequestsPage() {
  const [options, list, summary] = await Promise.all([
    load<RequestOptions>('/requests/options'),
    load<RequestList>('/requests?limit=5'),
    load<RequestSummary>('/requests/summary'),
  ]);
  const first = options.me.name.split(' ')[0];
  const leave = options.categories.find((c) => c.kind === 'leave');
  const others = options.categories.filter((c) => c.kind !== 'leave');
  const stat = (label: string, n: number, href: string, testId: string) => (
    <Link href={href} className="rounded-xl border border-border bg-surface/80 px-4 py-3 shadow-card backdrop-blur hover:border-accent/40" data-testid={testId}>
      <div className="text-2xl font-semibold tabular text-fg">{n}</div>
      <div className="text-xs text-fg-muted">{label}</div>
    </Link>
  );
  return (
    <>
      <PageHeader title="Requests" eyebrow={options.me.levelLabel} description="Create a request or apply for leave, choose your approvers and who to keep in CC, and follow every decision." />

      <section aria-label="Start a request" className="relative mb-6 overflow-hidden rounded-2xl border border-accent/20 bg-gradient-to-br from-accent-subtle via-surface to-surface p-5 shadow-card sm:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-accent/10 blur-3xl" aria-hidden />
        <div className="relative flex flex-col gap-5 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold tracking-tight text-fg">Hi {first}, what do you need?</h2>
            <p className="mt-1 max-w-xl text-[0.8125rem] text-fg-muted">Your details, reporting manager and HR are filled in for you. Choose the primary approver, any additional approvers, and people to keep informed.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/requests/new" className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg shadow-card hover:bg-accent-hover" data-testid="raise-request"><Plus className="size-4" /> Create request</Link>
              {leave && <Link href="/leave/apply" className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-semibold text-fg hover:bg-bg-subtle" data-testid="apply-leave-cta"><Plane className="size-4" /> Apply for leave</Link>}
            </div>
            <div className="mt-5 grid max-w-lg grid-cols-3 gap-2">
              {stat('Pending', summary.pending, '/requests/mine?status=pending', 'summary-pending')}
              {stat('Changes asked', summary.changesRequested, '/requests/mine?status=changes_requested', 'summary-changes')}
              {stat('For my approval', summary.toDecide, '/requests/approvals', 'summary-to-decide')}
            </div>
          </div>
          <RequestsIllustration className="mx-auto h-36 w-auto shrink-0 md:mx-0 md:h-40" />
        </div>
      </section>

      <section aria-labelledby="types" className="mb-8">
        <h2 id="types" className="mb-3 text-[0.9375rem] font-semibold text-fg">Request types</h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[...(leave ? [leave] : []), ...others].map((c) => (
            <li key={c.key}>
              <Link href={c.kind === 'leave' ? '/leave/apply' : `/requests/new?kind=${c.key}`} className="group flex h-full items-center gap-3 rounded-xl border border-border bg-surface p-3.5 shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-pop" data-testid={`kind-${c.key}`}>
                <KindTile kind={c.kind} />
                <span className="min-w-0">
                  <span className="block text-[0.875rem] font-semibold text-fg">{c.label}</span>
                  <span className="block text-xs text-fg-muted">{c.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="recent">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="recent" className="text-[0.9375rem] font-semibold text-fg">Recent requests</h2>
          <div className="flex gap-3 text-[0.8125rem]">
            <Link href="/requests/mine" className="inline-flex items-center gap-1 font-medium text-accent hover:underline"><ListChecks className="size-4" /> My Requests <ArrowRight className="size-3.5" /></Link>
            <Link href="/requests/approvals" className="inline-flex items-center gap-1 font-medium text-accent hover:underline"><Inbox className="size-4" /> My Approvals <ArrowRight className="size-3.5" /></Link>
          </div>
        </div>
        {list.items.length ? (
          <ul className="grid gap-3" data-testid="recent-requests">{list.items.map((r) => <RequestCard key={r.id} r={r} />)}</ul>
        ) : (
          <EmptyState icon={<Send className="size-5" />} title="No requests yet" description="Requests and leave applications you submit appear here." />
        )}
      </section>
    </>
  );
}

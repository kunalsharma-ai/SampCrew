'use client';
import { Badge, Card, EmptyState, cn } from '@crew/ui';
import { ChevronRight, Inbox } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useRefreshOn } from '@/components/live';
import { ICONS } from '@/lib/icons';
import type { InboxItem } from '@/lib/types';
import { InboxView } from './inbox-view';
import type { ApprovalCard, ApprovalOverview, ApprovalRow } from './types';

const VIEW_LABEL = { waiting: 'Waiting for me', mine: 'My requests', decided: 'Decided by me' } as const;

export const STATUS_TONE: Record<string, 'warning' | 'success' | 'danger' | 'neutral'> = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' };
export const STATUS_LABEL: Record<string, string> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };

export function ApprovalsBoard({ view, overview, counts, inbox, rows, category, status }: {
  view: 'waiting' | 'mine' | 'decided';
  overview: ApprovalOverview;
  counts: { waiting: number; mine: number };
  inbox: InboxItem[] | null;
  rows: ApprovalRow[] | null;
  category: string | null;
  status: string | null;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  // A new request for me, or a decision on mine, shows without reloading.
  useRefreshOn(['approvals.changed']);
  const href = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams();
    const merged = { view, category, status, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === 'view' && v === 'waiting')) sp.set(k, v);
    return `/approvals${sp.size ? `?${sp}` : ''}`;
  };
  const active = overview.categories.filter((c) => c.total > 0);
  const empty = overview.categories.filter((c) => c.total === 0);
  const shownCards = showEmpty ? [...active, ...empty] : active;
  const selected = overview.categories.find((c) => c.key === category) ?? null;
  const items = inbox ? (category ? inbox.filter((i) => i.category === category) : inbox) : null;

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Approvals view">
        {(['waiting', 'mine', 'decided'] as const).map((v) => (
          <Link key={v} role="tab" aria-selected={view === v} href={v === 'waiting' ? '/approvals' : `/approvals?view=${v}`} className={cn('flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[0.8125rem] font-medium', view === v ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted hover:text-fg')}>
            {VIEW_LABEL[v]}
            {v !== 'decided' && counts[v] > 0 && <span className={cn('rounded-full px-1.5 text-[0.6875rem]', view === v ? 'bg-accent-fg/20' : 'bg-bg-subtle')}>{counts[v]}</span>}
          </Link>
        ))}
      </div>

      {shownCards.length === 0 ? (
        <Card><EmptyState icon={<Inbox className="size-5" />} title={view === 'waiting' ? "You're all caught up" : view === 'mine' ? 'You have not asked for anything yet' : 'You have not decided any requests yet'} description={view === 'waiting' ? 'Leave requests and other approvals for you will appear here.' : 'Leave, expenses, corrections and other requests appear here by category.'} /></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="approval-cards">
          {shownCards.map((c) => <CategoryCard key={c.key} c={c} selected={category === c.key} href={href({ category: category === c.key ? null : c.key, status: null })} view={view} />)}
        </div>
      )}
      {empty.length > 0 && (
        <button className="justify-self-start text-xs font-medium text-accent hover:underline" onClick={() => setShowEmpty((v) => !v)}>
          {showEmpty ? 'Hide empty categories' : `Show all ${overview.categories.length} categories`}
        </button>
      )}

      <section className="grid gap-3" aria-label={selected ? selected.label : 'Requests'}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{selected ? `${selected.label}: ${VIEW_LABEL[view].toLowerCase()}` : view === 'waiting' ? 'Waiting for your decision' : VIEW_LABEL[view]}</h2>
          {view !== 'waiting' && (
            <div className="flex flex-wrap gap-1">
              {[null, 'pending', 'approved', 'rejected', 'cancelled'].map((s) => (
                <Link key={s ?? 'all'} href={href({ status: s })} className={cn('rounded-md px-2.5 py-1 text-xs', status === s ? 'bg-accent-subtle font-semibold text-fg' : 'text-fg-muted hover:bg-bg-subtle')}>{s ? STATUS_LABEL[s] : 'All'}</Link>
              ))}
            </div>
          )}
        </div>
        {items && <InboxView items={items} />}
        {rows && <RequestList rows={rows} />}
      </section>
    </div>
  );
}

function CategoryCard({ c, selected, href, view }: { c: ApprovalCard; selected: boolean; href: string; view: string }) {
  const Icon = ICONS[c.icon] ?? Inbox;
  return (
    <Link href={href} aria-current={selected ? 'true' : undefined} data-testid={`approval-card-${c.key}`} className={cn('group relative min-w-0 overflow-hidden rounded-xl border bg-surface p-4 shadow-card transition hover:-translate-y-0.5 hover:shadow-pop', selected ? 'border-accent ring-2 ring-accent/30' : 'border-border', c.total === 0 && 'opacity-60')}>
      <span aria-hidden className="absolute inset-x-0 top-0 h-1" style={{ background: c.color }} />
      <div className="flex items-start gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg" style={{ background: `${c.color}1f`, color: c.color }} aria-hidden><Icon className="size-4.5" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{c.label}</span>
            <span className="text-lg font-semibold tabular-nums">{c.total}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.6875rem] text-fg-muted">
            <span><strong className="text-warning">{c.pending}</strong> pending</span>
            {view !== 'waiting' && <><span><strong className="text-success">{c.approved}</strong> approved</span><span><strong className="text-danger">{c.rejected}</strong> rejected</span></>}
          </div>
        </div>
      </div>
      {c.total > 0 && c.pending + c.approved + c.rejected > 0 && view !== 'waiting' && (
        <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-bg-subtle" aria-hidden>
          <span className="bg-success" style={{ width: `${(c.approved / c.total) * 100}%` }} />
          <span className="bg-warning" style={{ width: `${(c.pending / c.total) * 100}%` }} />
          <span className="bg-danger" style={{ width: `${(c.rejected / c.total) * 100}%` }} />
        </div>
      )}
      {/* Waiting requests are listed in full below the cards, so the cards show the latest ones only in the other views. */}
      {view !== 'waiting' && c.recent.length > 0 && (
        <ul className="mt-3 grid gap-1 border-t border-border pt-2">
          {c.recent.slice(0, 2).map((r) => (
            <li key={r.id} className="flex min-w-0 items-center gap-2 text-[0.6875rem] text-fg-muted" title={r.summary}>
              <span className={cn('size-1.5 shrink-0 rounded-full', r.status === 'pending' ? 'bg-warning' : r.status === 'approved' ? 'bg-success' : r.status === 'rejected' ? 'bg-danger' : 'bg-fg-subtle')} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{r.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </Link>
  );
}

function RequestList({ rows }: { rows: ApprovalRow[] }) {
  if (!rows.length) return <Card><EmptyState icon={<Inbox className="size-5" />} title="No requests here" description="Try another category or status." /></Card>;
  return (
    <Card className="divide-y divide-border p-0" data-testid="approval-requests">
      {rows.map((r) => (
        <Link key={r.id} href={`/approvals/${r.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-bg-subtle" data-testid="approval-row">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[0.6875rem] text-fg-subtle">{r.ref}</span>
              <span className="text-[0.8125rem] font-semibold">{r.label}</span>
              <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status] ?? r.status}</Badge>
              {r.autoApproved && <Badge tone="info">Approved automatically</Badge>}
              {r.stepCount > 1 && r.status === 'pending' && <Badge tone="info">Step {r.stepSeq} of {r.stepCount}</Badge>}
            </div>
            <p className="mt-0.5 truncate text-[0.8125rem] text-fg">{r.summary}</p>
            <p className="text-xs text-fg-muted">{r.statusMessage}</p>
          </div>
          <span className="hidden text-xs text-fg-subtle sm:block" suppressHydrationWarning>{new Date(r.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          <ChevronRight className="size-4 text-fg-subtle" aria-hidden />
        </Link>
      ))}
    </Card>
  );
}

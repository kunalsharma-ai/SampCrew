import type { RequestView } from '@crew/contracts';
import { requestDateLabel } from '@crew/contracts';
import { Avatar, cn } from '@crew/ui';
import { ArrowRight, Check, MessageSquareQuote, RotateCcw, X } from 'lucide-react';
import Link from 'next/link';
import { KindTile, StatusChip } from './kind-visual';

/** One request in My Requests: ID, type, dates, submission date, status, who it waits for, and the approvers. */
export function RequestCard({ r }: { r: RequestView }) {
  const comments = r.events.filter((e) => e.comment).length || r.approvers.filter((a) => a.comment).length;
  return (
    <li className="group relative rounded-xl border border-border bg-surface shadow-card transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-pop" data-testid="request-card" data-request-id={r.id}>
      <Link href={`/requests/${r.id}`} className="absolute inset-0 rounded-xl" aria-label={`Open ${r.title}, ${r.ref}`} />
      <div className="flex items-start gap-3 p-4">
        <KindTile kind={r.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="min-w-0 truncate text-[0.9375rem] font-semibold text-fg">{r.title}</h3>
            <StatusChip status={r.status} />
            <span className="font-mono text-[0.6875rem] text-fg-subtle" data-testid="request-card-ref">{r.ref}</span>
          </div>
          <p className="mt-0.5 text-[0.8125rem] text-fg-muted">{r.when}{r.leave ? ` · ${r.leave.days} day(s) of ${r.leave.leaveTypeName}` : ''} · submitted {requestDateLabel(r.createdAt.slice(0, 10))}</p>
          <p className="mt-1.5 line-clamp-2 break-words text-[0.8125rem] text-fg">{r.reason}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <ul className="flex flex-wrap items-center gap-1.5" aria-label="Approvers">
              {r.approvers.map((a) => (
                <li key={a.membershipId} className="relative" title={`${a.name} (${a.levelLabel}): ${a.status.replace('_', ' ')}`}>
                  <Avatar name={a.name} size={26} />
                  <span className={cn('absolute -bottom-0.5 -right-0.5 inline-flex size-3.5 items-center justify-center rounded-full ring-2 ring-surface',
                    a.status === 'approved' ? 'bg-success text-white' : a.status === 'rejected' ? 'bg-danger text-white' : a.status === 'changes_requested' ? 'bg-info text-white' : a.status === 'pending' ? 'bg-warning' : 'bg-fg-subtle')}>
                    {a.status === 'approved' ? <Check className="size-2.5" strokeWidth={3} /> : a.status === 'rejected' ? <X className="size-2.5" strokeWidth={3} /> : a.status === 'changes_requested' ? <RotateCcw className="size-2" strokeWidth={3} /> : null}
                  </span>
                </li>
              ))}
            </ul>
            <span className="text-xs text-fg-muted">{r.statusMessage}</span>
            {comments > 0 && <span className="inline-flex items-center gap-1 text-xs text-fg-muted"><MessageSquareQuote className="size-3.5" /> {comments} comment{comments === 1 ? '' : 's'}</span>}
          </div>
        </div>
        <ArrowRight className="mt-1 size-4 shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" aria-hidden />
      </div>
    </li>
  );
}

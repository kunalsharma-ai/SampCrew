'use client';
import { Alert, Avatar, Badge, Button, Card, EmptyState, Input, Textarea } from '@crew/ui';
import { Check, Inbox, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import Link from 'next/link';
import type { InboxItem, SameDayLeaveDetails } from '@/lib/types';
import { leavePenaltyAction } from '../attendance/late/actions';
import { decideAction } from '../leave/actions';

export function InboxView({ items }: { items: InboxItem[] }) {
  if (!items.length) return <Card><EmptyState icon={<Inbox className="size-5" />} title="You're all caught up" description="Leave requests and other approvals for you will appear here." /></Card>;
  return <div className="grid gap-3">{items.map((i) => <Item key={i.id} item={i} />)}</div>;
}

function Item({ item }: { item: InboxItem }) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const decide = (d: 'approve' | 'reject') => start(async () => {
    const r = await decideAction(item.id, d, comment.trim() || undefined);
    if (r.ok) {
      setResult({ tone: 'success', text: r.data?.status === 'pending' ? 'Approved. It moves to the next approver.' : d === 'approve' ? 'Approved' : 'Rejected' });
      setTimeout(() => router.refresh(), 800);
    } else setResult({ tone: 'danger', text: r.message });
  });
  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Avatar name={item.subjectName ?? item.requestedBy ?? '?'} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{item.label}</span>
            {item.stepCount > 1 && <Badge tone="info">Step {item.stepSeq} of {item.stepCount}</Badge>}
            {item.viaRole && <Badge>As {item.viaRole.replace(/_/g, ' ')}</Badge>}
          </div>
          <p className="mt-1 text-sm text-fg">{item.summary}</p>
          {item.details?.sameDayLeave && <SameDayPenalty requestId={item.resourceId} d={item.details.sameDayLeave} />}
          <p className="mt-1 text-xs text-fg-subtle">Requested {item.requestedBy && item.requestedBy !== item.subjectName ? `by ${item.requestedBy} ` : ''}on {new Date(item.createdAt).toLocaleString()}</p>
          {result ? <Alert tone={result.tone} className="mt-3">{result.text}</Alert> : (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <Textarea aria-label="Comment" placeholder="Comment (optional, shared with the requester)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} className="min-h-9 flex-1" rows={1} />
              <div className="flex gap-2">
                <Button variant="secondary" loading={pending} onClick={() => decide('reject')}><X className="size-4" /> Reject</Button>
                <Button loading={pending} onClick={() => decide('approve')}><Check className="size-4" /> Approve</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

const daysText = (v: string) => `${v} day${v === '1' ? "'s" : "s'"} pay`;

/** Same-day leave: the penalty on the request, and applying or changing it (in half days) before deciding. */
function SameDayPenalty({ requestId, d }: { requestId: string; d: SameDayLeaveDetails }) {
  const router = useRouter();
  const [days, setDays] = useState(d.penalty?.status === 'active' ? d.penalty.days : (d.suggestedDays ?? ''));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const active = d.penalty?.status === 'active' ? d.penalty : null;
  return (
    <div className="mt-2 rounded-lg border border-warning/30 bg-warning-subtle/40 px-3 py-2 text-[0.8125rem]" data-testid="same-day-leave">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">Same-day leave</Badge>
        {d.appliedOn && <span className="text-fg-muted">Applied on {d.appliedOn}</span>}
        {active ? <span>Penalty: <strong>{daysText(active.days)}</strong> ({active.source === 'auto' ? 'workspace rule' : 'set by a manager'})</span> : d.exempt ? <span className="text-fg-muted">This leave type has no penalty.</span> : <span className="text-fg-muted">No penalty applied.</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="grid w-32 gap-1"><span className="text-xs text-fg-muted">Penalty in days of pay</span>
          <Input aria-label="Penalty in days of pay" className="h-8" inputMode="decimal" placeholder="2 or 3.5" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <Button size="sm" variant="secondary" loading={pending} disabled={!days.trim()} onClick={() => start(async () => {
          const r = await leavePenaltyAction(requestId, days.trim());
          setMsg(r.ok ? { tone: 'success', text: `Penalty set to ${daysText(r.data!.value)}.` } : { tone: 'danger', text: r.message });
          if (r.ok) router.refresh();
        })}>{active ? 'Change penalty' : 'Apply penalty'}</Button>
        {active && <Link className="pb-1.5 text-xs underline" href="/attendance/late">Waive it in Late coming &amp; penalties</Link>}
      </div>
      {msg && <Alert tone={msg.tone} className="mt-2">{msg.text}</Alert>}
    </div>
  );
}

'use client';
import { Alert, Avatar, Badge, Button, Card, EmptyState, Input, Textarea } from '@crew/ui';
import { Check, Inbox, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { InboxItem, SameDayLeaveDetails } from '@/lib/types';
import { leavePenaltyAction } from '../attendance/late/actions';
import { decideAction } from '../leave/actions';

type Result = { tone: 'success' | 'danger'; text: string };

export function InboxView({ items }: { items: InboxItem[] }) {
  // A decision refreshes the inbox from the server, which drops the decided request, sometimes before the result has
  // rendered. Keep the card, with its result, where it was for a moment so the confirmation is always seen.
  const [decided, setDecided] = useState<Record<string, { item: InboxItem; result: Result }>>({});
  const order = useRef<string[]>([]);
  const live = new Map(items.map((i) => [i.id, i]));
  const ids = [...order.current.filter((id) => live.has(id) || decided[id]), ...items.map((i) => i.id).filter((id) => !order.current.includes(id))];
  order.current = ids;
  const shown = ids.map((id) => live.get(id) ?? decided[id]!.item);
  if (!shown.length) return <Card><EmptyState icon={<Inbox className="size-5" />} title="You're all caught up" description="Leave requests and other approvals for you will appear here." /></Card>;
  return (
    <div className="grid gap-3">
      {shown.map((i) => <Item key={i.id} item={i} result={decided[i.id]?.result ?? null} onDecided={(result) => {
        setDecided((d) => ({ ...d, [i.id]: { item: i, result } }));
        setTimeout(() => setDecided((d) => { const { [i.id]: _, ...rest } = d; return rest; }), 1500);
      }} />)}
    </div>
  );
}

function Item({ item, result: decidedResult, onDecided }: { item: InboxItem; result: Result | null; onDecided: (r: Result) => void }) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<Result | null>(null);
  const result = decidedResult ?? failure;
  const decide = (d: 'approve' | 'reject') => start(async () => {
    const r = await decideAction(item.id, d, comment.trim() || undefined);
    if (r.ok) {
      onDecided({ tone: 'success', text: r.data?.status === 'pending' ? 'Approved. It moves to the next approver.' : d === 'approve' ? 'Approved' : 'Rejected' });
      router.refresh();
    } else setFailure({ tone: 'danger', text: r.message });
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
          <p className="mt-1 text-xs text-fg-subtle" suppressHydrationWarning>
            {item.ref && <span className="mr-1 font-mono">{item.ref}</span>}Requested {item.requestedBy && item.requestedBy !== item.subjectName ? `by ${item.requestedBy} ` : ''}on {new Date(item.createdAt).toLocaleString()}
            {' · '}<Link href={`/approvals/${item.id}`} className="font-medium text-accent hover:underline">Details and history</Link>
          </p>
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

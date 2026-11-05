'use client';
import { Alert, Avatar, Badge, Button, Card, EmptyState, Textarea } from '@crew/ui';
import { Check, Inbox, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { InboxItem } from '@/lib/types';
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

'use client';
import { COMP_OFF_WINDOW_DAYS } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type CompOff, decideCompOffAction, requestCompOffAction } from './actions';

const TONE: Record<string, 'info' | 'success' | 'danger' | 'neutral'> = { pending: 'info', approved: 'success', rejected: 'danger', cancelled: 'neutral' };
const hours = (m: number | null) => (m === null ? null : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m worked`);

/** Comp-off: a day off earned by working on a weekly off or a holiday, approved by the manager or HR. */
export function CompOffCard({ rows, team = false }: { rows: CompOff[]; team?: boolean }) {
  return (
    <Card data-testid={team ? 'comp-off-team' : 'comp-off-mine'}>
      <CardHeader
        title={team ? 'Comp-off requests' : 'Comp-off'}
        description={team ? 'Requests from people who worked on a weekly off or a holiday. Approving adds the day to their comp-off balance.' : `Worked on a weekly off or a holiday? Ask for a comp-off day within ${COMP_OFF_WINDOW_DAYS} days. Your manager or HR approves it.`}
        action={team ? null : <RequestCompOff />}
      />
      {rows.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">{team ? 'No comp-off requests.' : 'No comp-off requests yet.'}</p> : (
        <ul className="grid gap-2 px-5 pb-5">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm" data-testid="comp-off-row">
              <span className="min-w-0">
                <span className="font-medium">{team ? `${r.employeeName} · ` : ''}{r.workDate} · {r.days === '0.5' ? 'half day' : '1 day'}</span>
                <span className="block text-xs text-fg-subtle">{[r.dayKind === 'holiday' ? r.holidayName ?? 'Holiday' : 'Weekly off', hours(r.workedMinutes), r.reason].filter(Boolean).join(' · ')}</span>
                {r.comment && <span className="block text-xs text-fg-muted">{r.decidedBy ? `${r.decidedBy}: ` : ''}{r.comment}</span>}
              </span>
              <span className="flex items-center gap-2">
                <Badge tone={TONE[r.status] ?? 'neutral'} className="capitalize">{r.status}</Badge>
                {team && r.canDecide && r.status === 'pending' && <Decide r={r} />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RequestCompOff() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [workDate, setWorkDate] = useState('');
  const [days, setDays] = useState<'1' | '0.5'>('1');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const today = new Date().toISOString().slice(0, 10);
  const earliest = new Date(Date.now() - COMP_OFF_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="comp-off-request">Request comp-off</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Request comp-off" description="For a day you worked that was a weekly off or a holiday on your calendar."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!workDate || reason.trim().length < 5} onClick={() => start(async () => {
          setError(null);
          const r = await requestCompOffAction({ workDate, days, reason: reason.trim() });
          if (!r.ok) return setError(r.message);
          setOpen(false); setWorkDate(''); setReason('');
          router.refresh();
        })} data-testid="comp-off-send">Send for approval</Button></>}>
        <div className="grid gap-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Day you worked" required>{(p) => <Input {...p} type="date" min={earliest} max={today} value={workDate} onChange={(e) => setWorkDate(e.target.value)} data-testid="comp-off-date" />}</Field>
            <Field label="Comp-off">{(p) => <Select {...p} value={days} onChange={(e) => setDays(e.target.value as '1' | '0.5')}><option value="1">1 day</option><option value="0.5">Half a day</option></Select>}</Field>
          </div>
          <Field label="What you worked on" required>{(p) => <Textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="comp-off-reason" />}</Field>
        </div>
      </Dialog>
    </>
  );
}

function Decide({ r }: { r: CompOff }) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const decide = (decision: 'approve' | 'reject') => start(async () => {
    setError(null);
    const res = await decideCompOffAction(r.id, decision, comment.trim() || undefined);
    if (!res.ok) return setError(res.message);
    setRejecting(false);
    router.refresh();
  });
  return (
    <>
      <Button size="sm" loading={pending} onClick={() => decide('approve')} data-testid="comp-off-approve">Approve</Button>
      <Button size="sm" variant="secondary" onClick={() => setRejecting(true)}>Reject</Button>
      {error && !rejecting && <span className="text-xs text-danger">{error}</span>}
      <Dialog open={rejecting} onClose={() => setRejecting(false)} size="sm" title="Reject comp-off" description={`${r.employeeName} is told the reason.`}
        footer={<><Button variant="secondary" onClick={() => setRejecting(false)}>Back</Button><Button variant="danger" loading={pending} disabled={comment.trim().length < 3} onClick={() => decide('reject')}>Reject</Button></>}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" required>{(p) => <Textarea {...p} rows={3} maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}

'use client';
import { REQUEST_KIND_DEFS, type RequestView } from '@crew/contracts';
import { Alert, Button, DatePicker, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { Ban, CalendarX, Check, MessageSquarePlus, PencilLine, RotateCcw, Send, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useRefreshOn } from '@/components/live';
import { cancelApprovedLeaveAction, cancelRequestAction, commentRequestAction, decideRequestAction, resubmitRequestAction } from '../actions';

/** Reloads the request as approvers decide (live). */
export function LiveRefresh() {
  useRefreshOn(['approvals.changed']);
  return null;
}

type Decision = 'approve' | 'reject' | 'changes';
const DECISION: Record<Decision, { title: string; description: string; label: string; field: string; required: boolean; variant: 'primary' | 'danger' | 'secondary' }> = {
  approve: { title: 'Approve this request?', description: 'The requester and everyone on the request are told. Your comment is optional.', label: 'Approve', field: 'Comment (optional)', required: false, variant: 'primary' },
  reject: { title: 'Reject this request?', description: 'The requester reads your reason. It ends the request for every approver.', label: 'Reject', field: 'Reason for rejecting', required: true, variant: 'danger' },
  changes: { title: 'Request changes?', description: 'The request goes back to the requester to correct, then comes back to the approvers.', label: 'Request changes', field: 'What needs to be corrected', required: true, variant: 'secondary' },
};

/** The confirmation dialog for a decision: a comment that is optional for approving and required otherwise. */
export function DecisionDialog({ id, decision, onClose, onDone, subject }: { id: string; decision: Decision | null; onClose: () => void; onDone?: () => void; subject?: string }) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const d = decision ? DECISION[decision] : null;
  return (
    <Dialog open={Boolean(decision)} onClose={() => { setComment(''); setError(null); onClose(); }} title={d?.title ?? ''} description={subject ? `${subject}. ${d?.description ?? ''}` : d?.description}
      footer={d && <>
        <Button variant="ghost" onClick={onClose}>Back</Button>
        <Button variant={d.variant} loading={pending} disabled={d.required && !comment.trim()} data-testid={`confirm-${decision}`} onClick={() => start(async () => {
          const r = await decideRequestAction(id, decision!, comment);
          if (!r.ok) { setError(r.message); return; }
          setComment('');
          onClose();
          onDone?.();
          router.refresh();
        })}>{d.label}</Button>
      </>}>
      {d && (
        <Field label={d.field} required={d.required} error={error ?? undefined} help={false}>
          {(a) => <Textarea {...a} rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="decision-comment" />}
        </Field>
      )}
    </Dialog>
  );
}

/** Approve, reject or request changes, for an approver whose turn it is. */
export function DecisionBar({ id }: { id: string }) {
  const [open, setOpen] = useState<Decision | null>(null);
  return (
    <div className="flex flex-wrap gap-2" data-testid="decision-bar">
      <Button onClick={() => setOpen('approve')} data-testid="approve-request"><Check className="size-4" /> Approve</Button>
      <Button variant="secondary" onClick={() => setOpen('changes')} data-testid="changes-request"><RotateCcw className="size-4" /> Request changes</Button>
      <Button variant="danger" onClick={() => setOpen('reject')} data-testid="reject-request"><X className="size-4" /> Reject</Button>
      <DecisionDialog id={id} decision={open} onClose={() => setOpen(null)} />
    </div>
  );
}

export function CancelRequest({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="cancel-request"><Ban className="size-4" /> Cancel request</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Cancel this request?" description="Your approvers and CC participants are told, and it leaves their lists."
        footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Keep it</Button>
          <Button variant="danger" loading={pending} data-testid="confirm-cancel" onClick={() => start(async () => {
            const r = await cancelRequestAction(id, reason.trim() || undefined);
            if (!r.ok) { setError(r.message); return; }
            setOpen(false);
            router.refresh();
          })}>Cancel request</Button>
        </>}>
        <Field label="Reason (optional)" error={error ?? undefined} help={false}>
          {(a) => <Textarea {...a} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Dialog>
    </>
  );
}

/** Cancelling approved leave: through the approvers (or straight away before it starts, when the settings allow). */
export function CancelApprovedLeave({ id, direct }: { id: string; direct: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="cancel-approved-leave"><CalendarX className="size-4" /> Cancel leave</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Cancel this approved leave?"
        description={direct ? 'Before the leave starts it is cancelled straight away and the days go back to your balance.' : 'A cancellation request goes to the same approvers. The leave stays booked until they approve it.'}
        footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Keep the leave</Button>
          <Button variant="danger" loading={pending} disabled={reason.trim().length < 5} data-testid="confirm-cancel-leave" onClick={() => start(async () => {
            const r = await cancelApprovedLeaveAction(id, reason.trim());
            if (!r.ok) { setError(r.message); return; }
            setOpen(false);
            if (r.data?.cancellation) router.push(`/requests/${r.data.cancellation.id}?sent=1`);
            else router.refresh();
          })}>{direct ? 'Cancel leave' : 'Send cancellation request'}</Button>
        </>}>
        <Field label="Reason" required error={error ?? undefined} help={false}>
          {(a) => <Textarea {...a} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: the trip was called off." />}
        </Field>
      </Dialog>
    </>
  );
}

/** Correct a request an approver sent back and send it to the same approvers again. */
export function ResubmitRequest({ r }: { r: RequestView }) {
  const router = useRouter();
  const def = REQUEST_KIND_DEFS[r.kind];
  const single = def.timing !== 'days';
  const [open, setOpen] = useState(false);
  const [startDate, setStartDate] = useState(r.startDate);
  const [endDate, setEndDate] = useState(r.endDate);
  const [startTime, setStartTime] = useState(r.startTime ?? '');
  const [endTime, setEndTime] = useState(r.endTime ?? '');
  const [reason, setReason] = useState(r.reason);
  const [duration, setDuration] = useState(r.leave?.duration ?? 'full');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ask = [...r.events].reverse().find((e) => e.action === 'changes_requested');
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="resubmit-request"><PencilLine className="size-4" /> Correct and send again</Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title="Correct the request" description="It goes to the same approvers again, as a new round."
        footer={<>
          <Button variant="ghost" onClick={() => setOpen(false)}>Back</Button>
          <Button loading={pending} disabled={reason.trim().length < 5} data-testid="confirm-resubmit" onClick={() => start(async () => {
            setError(null);
            const body: Record<string, unknown> = {
              reason, startDate, ...(single ? {} : { endDate }), ...(startTime ? { startTime } : {}), ...(endTime ? { endTime } : {}), ...(note.trim() ? { note: note.trim() } : {}),
              ...(r.leave ? { duration } : {}),
            };
            const res = await resubmitRequestAction(r.id, body);
            if (!res.ok) { setError(res.message); return; }
            setOpen(false);
            router.refresh();
          })}><Send className="size-4" /> Send again</Button>
        </>}>
        <div className="grid gap-4">
          {ask?.comment && <Alert tone="info" title={`${ask.by ?? 'An approver'} asked for changes`}>{ask.comment}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={single ? 'Date' : 'Start date'} required help={false}>{(a) => <DatePicker {...a} value={startDate} onChange={(v) => { setStartDate(v); if (endDate < v) setEndDate(v); }} calendarLabel="Choose the start date" />}</Field>
            {!single && <Field label="End date" required help={false}>{(a) => <DatePicker {...a} value={endDate} onChange={setEndDate} min={startDate} calendarLabel="Choose the end date" />}</Field>}
            {(single || r.startTime) && <Field label={def.timeLabels?.start ?? 'Start time'} help={false}>{(a) => <Input {...a} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />}</Field>}
            {(def.timing === 'day_time_range' || r.endTime) && <Field label={def.timeLabels?.end ?? 'End time'} help={false}>{(a) => <Input {...a} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />}</Field>}
            {r.leave && (
              <Field label="Leave duration" help={false}>
                {(a) => <Select {...a} value={duration} onChange={(e) => setDuration(e.target.value as typeof duration)}><option value="full">Full day</option><option value="half">Half day</option><option value="hours">Hours</option></Select>}
              </Field>
            )}
          </div>
          <Field label="Reason" required help={false}>{(a) => <Textarea {...a} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <Field label="What you changed (for the approvers)" error={error ?? undefined} help={false}>{(a) => <Input {...a} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
        </div>
      </Dialog>
    </>
  );
}

/** Add a comment: the requester, approvers and CC participants are told. */
export function AddComment({ id }: { id: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form className="mt-4 grid gap-2" onSubmit={(e) => {
      e.preventDefault();
      start(async () => {
        const r = await commentRequestAction(id, body.trim());
        if (!r.ok) { setError(r.message); return; }
        setBody('');
        router.refresh();
      });
    }}>
      <Field label="Add a comment" error={error ?? undefined} help={false}>
        {(a) => <Textarea {...a} rows={2} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Everyone on the request is told." data-testid="comment-input" />}
      </Field>
      <div><Button type="submit" variant="secondary" size="sm" loading={pending} disabled={!body.trim()} data-testid="comment-send"><MessageSquarePlus className="size-4" /> Comment</Button></div>
    </form>
  );
}

'use client';
import { Alert, Button, Card, CardHeader, Dialog, Field, Textarea } from '@crew/ui';
import { Download, FileUp } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';
import type { WorkTaskDetail } from '@/lib/types';
import { seenTaskAction, taskProgressAction, taskReviewAction, uploadTaskDocumentAction, verifyTaskDocumentAction } from '../actions';
import { fmtDate, KIND_LABEL, PriorityBadge, StatusBadge, VerificationBadge } from '../task-ui';

const ACTION_LABEL: Record<string, string> = {
  assigned: 'Assigned', edited: 'Edited', progress: 'Progress updated', acknowledged: 'Acknowledged', accepted: 'Accepted', reopened: 'Reopened', cancelled: 'Cancelled',
  uploaded: 'Document uploaded', document_verified: 'Document verified', document_rejected: 'Document rejected',
};
const FORMAT_LABEL: Record<string, string> = { pdf: 'PDF', image: 'PNG, JPEG or WebP', word: 'Word (.doc, .docx)', excel: 'Excel (.xls, .xlsx)', text: 'plain text' };
const ACCEPT: Record<string, string> = { pdf: '.pdf,application/pdf', image: '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp', word: '.doc,.docx', excel: '.xls,.xlsx', text: '.txt,text/plain' };
const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

type Ask = null | { kind: 'reopen' | 'cancel' | 'reject' | 'review' | 'complete' | 'accept'; title: string; label: string; required: boolean; submit: string };

export function TaskDetail({ task }: { task: WorkTaskDetail }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');

  // Opening a new task clears its "new" mark (and the menu count).
  useEffect(() => {
    if (task.isMine && task.isNew) void seenTaskAction(task.id).then(() => router.refresh());
  }, [task.id, task.isMine, task.isNew, router]);

  const run = (fn: () => Promise<ActionResult<unknown>>) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message });
    if (r.ok) {
      setAsk(null);
      setText('');
      router.refresh();
    }
  });
  const submitAsk = () => {
    if (!ask) return;
    const remarks = text.trim() || undefined;
    if (ask.kind === 'reopen' || ask.kind === 'cancel') run(() => taskReviewAction(task.id, ask.kind as 'reopen' | 'cancel', remarks));
    if (ask.kind === 'accept') run(() => taskReviewAction(task.id, 'complete', remarks));
    if (ask.kind === 'reject') run(() => verifyTaskDocumentAction(task.id, 'reject', remarks));
    if (ask.kind === 'review') run(() => taskProgressAction(task.id, 'pending_review', remarks));
    if (ask.kind === 'complete') run(() => taskProgressAction(task.id, 'completed', remarks));
  };
  const upload = () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.set('file', f);
    if (text.trim()) fd.set('remarks', text.trim());
    run(async () => {
      const r = await uploadTaskDocumentAction(task.id, fd);
      if (r.ok && fileRef.current) fileRef.current.value = '';
      if (r.ok) setFileName('');
      return r;
    });
  };

  const closed = task.status === 'completed' || task.status === 'cancelled';
  const workable = task.isMine && !closed && task.status !== 'pending_review';
  const spec = task.document?.spec;
  const doc = task.document?.id ? task.document : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-6">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {task.requestId && (
          <Alert tone="info" title="Document request">
            This task comes from a document request. <Link className="font-medium text-accent hover:underline" href={`/documents/requests/${task.requestId}`}>Open the request</Link> to see every version, the verification and its history.
          </Alert>
        )}
        {task.reviewerRemarks && task.status === 'reopened' && <Alert tone="warning" title="Sent back to you">{task.reviewerRemarks}</Alert>}

        <Card>
          <CardHeader title="Details" />
          <div className="grid gap-4 px-5 pb-5">
            <div className="flex flex-wrap gap-1.5"><StatusBadge task={task} /><PriorityBadge priority={task.priority} /></div>
            {task.description ? <p className="whitespace-pre-wrap text-sm text-fg">{task.description}</p> : <p className="text-sm text-fg-muted">No description.</p>}
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-fg-subtle">Type</dt><dd>{task.category === 'hr' ? 'HR task' : 'Manager task'} · {KIND_LABEL[task.kind]}</dd></div>
              <div><dt className="text-xs text-fg-subtle">For</dt><dd>{task.employeeName}{task.employeeCode ? ` (${task.employeeCode})` : ''}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Assigned by</dt><dd>{task.assignedBy ?? '—'} on {fmtDate(task.assignedAt)}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Due</dt><dd className={task.overdue ? 'font-medium text-danger' : ''}>{task.dueOn ? fmtDate(task.dueOn) : 'No due date'}</dd></div>
              {task.completedAt && <div><dt className="text-xs text-fg-subtle">Completed</dt><dd>{fmtDate(task.completedAt)}</dd></div>}
              {task.employeeRemarks && <div className="sm:col-span-2"><dt className="text-xs text-fg-subtle">Employee remarks</dt><dd className="whitespace-pre-wrap">{task.employeeRemarks}</dd></div>}
              {task.reviewerRemarks && <div className="sm:col-span-2"><dt className="text-xs text-fg-subtle">Reviewer remarks</dt><dd className="whitespace-pre-wrap">{task.reviewerRemarks}</dd></div>}
            </dl>
          </div>
        </Card>

        {spec && (
          <Card>
            <CardHeader title="Document" description={`Accepted: ${spec.formats.map((f) => FORMAT_LABEL[f] ?? f).join(', ')}. Up to ${spec.maxMb} MB.`} />
            <div className="grid gap-4 px-5 pb-5">
              {doc ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{doc.fileName}</div>
                    <div className="text-xs text-fg-subtle">{doc.sizeBytes ? `${Math.max(1, Math.round(doc.sizeBytes / 1024))} KB` : ''}{task.submittedAt ? ` · uploaded ${fmtDate(task.submittedAt)}` : ''}</div>
                  </div>
                  <VerificationBadge status={doc.verificationStatus} />
                  <a className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline" href={`/files/${doc.id}`}><Download className="size-4" aria-hidden /> Download</a>
                </div>
              ) : (
                <p className="text-sm text-fg-muted">Nothing uploaded yet.</p>
              )}
              {doc?.verificationStatus === 'rejected' && doc.verificationRemarks && <Alert tone="danger" title="HR could not accept the last upload">{doc.verificationRemarks}</Alert>}
              {workable && (
                <div className="grid gap-3">
                  <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border-strong p-6 text-center hover:border-accent focus-within:border-accent">
                    <FileUp className="size-6 text-accent" aria-hidden />
                    <span className="text-sm font-medium">{fileName || (doc ? 'Choose a new file to upload again' : 'Choose a file to upload')}</span>
                    <span className="text-xs text-fg-subtle">{spec.formats.map((f) => FORMAT_LABEL[f] ?? f).join(', ')}, up to {spec.maxMb} MB</span>
                    <input ref={fileRef} type="file" className="sr-only" accept={spec.formats.map((f) => ACCEPT[f]).join(',')} onChange={(e) => setFileName(e.target.files?.[0]?.name ?? '')} data-testid="task-file" />
                  </label>
                  <Field label="Note for HR (optional)">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
                  <div><Button loading={pending} disabled={!fileName} onClick={upload}>Upload for verification</Button></div>
                </div>
              )}
              {task.canManage && task.status === 'pending_review' && doc?.verificationStatus === 'pending' && (
                <div className="flex flex-wrap gap-2">
                  <Button loading={pending} onClick={() => run(() => verifyTaskDocumentAction(task.id, 'verify'))}>Verify document</Button>
                  <Button variant="secondary" onClick={() => setAsk({ kind: 'reject', title: 'Reject the document', label: 'What should the employee fix?', required: true, submit: 'Reject' })}>Reject</Button>
                </div>
              )}
            </div>
          </Card>
        )}

        {(workable || (task.canManage && !closed) || (task.canManage && task.status === 'completed')) && (
          <Card>
            <CardHeader title="Actions" />
            <div className="flex flex-wrap gap-2 px-5 pb-5">
              {workable && task.kind !== 'document' && (
                <>
                  {task.status !== 'in_progress' && <Button variant="secondary" loading={pending} onClick={() => run(() => taskProgressAction(task.id, 'in_progress'))}>Start working on it</Button>}
                  {task.kind === 'acknowledgement' ? (
                    <Button onClick={() => setAsk({ kind: 'complete', title: 'Acknowledge', label: 'Comment (optional)', required: false, submit: 'I have read and acknowledge this' })}>Acknowledge</Button>
                  ) : (
                    <>
                      <Button onClick={() => setAsk({ kind: 'review', title: 'Send for review', label: 'What did you do? (optional)', required: false, submit: 'Send for review' })}>Send for review</Button>
                      <Button variant="secondary" onClick={() => setAsk({ kind: 'complete', title: 'Mark as completed', label: 'Remarks (optional)', required: false, submit: 'Mark completed' })}>Mark completed</Button>
                    </>
                  )}
                </>
              )}
              {workable && task.kind === 'document' && task.status !== 'in_progress' && <Button variant="secondary" loading={pending} onClick={() => run(() => taskProgressAction(task.id, 'in_progress'))}>Start working on it</Button>}
              {task.canManage && task.status === 'pending_review' && task.kind !== 'document' && (
                <Button onClick={() => setAsk({ kind: 'accept', title: 'Accept the work', label: 'Comment (optional)', required: false, submit: 'Accept' })}>Accept</Button>
              )}
              {task.canManage && (task.status === 'pending_review' || task.status === 'completed') && task.kind !== 'document' && (
                <Button variant="secondary" onClick={() => setAsk({ kind: 'reopen', title: 'Reopen the task', label: 'Why is it reopened?', required: true, submit: 'Reopen' })}>Reopen</Button>
              )}
              {task.canManage && !closed && <Button variant="ghost" onClick={() => setAsk({ kind: 'cancel', title: 'Cancel the task', label: 'Why is it cancelled?', required: true, submit: 'Cancel task' })}>Cancel task</Button>}
            </div>
          </Card>
        )}
      </div>

      <Card className="content-start self-start">
        <CardHeader title="History" />
        <ol className="grid gap-4 px-5 pb-5" aria-label="Task history">
          {[...task.history].reverse().map((h, i) => (
            <li key={i} className="relative border-l-2 border-border pl-4">
              <span className="absolute -left-[5px] top-1.5 size-2 rounded-full bg-accent" aria-hidden />
              <div className="text-sm font-medium">{ACTION_LABEL[h.action] ?? h.action}</div>
              <div className="text-xs text-fg-subtle">{h.by ?? 'Someone'} · {when(h.at)}</div>
              {h.remarks && <div className="mt-1 whitespace-pre-wrap text-xs text-fg-muted">{h.remarks}</div>}
            </li>
          ))}
        </ol>
      </Card>

      <Dialog
        open={!!ask}
        onClose={() => setAsk(null)}
        title={ask?.title ?? ''}
        footer={<><Button variant="secondary" onClick={() => setAsk(null)}>Back</Button><Button loading={pending} disabled={!!ask?.required && text.trim().length < 3} onClick={submitAsk}>{ask?.submit}</Button></>}
      >
        <Field label={ask?.label ?? ''} required={ask?.required}>{(p) => <Textarea {...p} rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      </Dialog>
    </div>
  );
}

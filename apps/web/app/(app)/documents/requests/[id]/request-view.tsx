'use client';
import { REQUEST_FILE_LABEL } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Textarea } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { cancelRequestAction, openedRequestAction, startReviewAction } from '../../actions';
import { fmtDate, fmtSize, fmtWhen } from '../../format';
import type { RequestDetail } from '../../types';
import { DecisionButtons, DocStatusBadge, FileActions, HistoryList, PreviewPanel, RequestStatusBadge, UploadBox } from '../../ui';

const AWAITING_UPLOAD = ['new_request', 'pending_submission', 'correction_required', 'rejected'];
const AWAITING_REVIEW = ['submitted', 'resubmitted', 'under_verification'];

export function RequestView({ r }: { r: RequestDetail }) {
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  const once = useRef(false);

  // Opening the request is part of its history: the person asked "opened" it, a reviewer "started verifying" it.
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (r.isMine && r.status === 'new_request') void openedRequestAction(r.id).then(() => router.refresh());
    else if (r.canReview && (r.status === 'submitted' || r.status === 'resubmitted')) void startReviewAction(r.id).then(() => router.refresh());
  }, [r.id, r.isMine, r.canReview, r.status, router]);

  const latest = r.versions[0] ?? null;
  const mayUpload = r.isMine && AWAITING_UPLOAD.includes(r.status);
  const reviewing = r.canReview && AWAITING_REVIEW.includes(r.status) && latest;
  const asked = r.targetType === 'hr_workspace' ? `${r.hrWorkspace?.name ?? 'HR Workspace'}${r.assignee?.name ? ` (${r.assignee.name})` : ''}` : r.employee?.name ?? 'Employee';

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
      <div className="grid content-start gap-5">
        {note && <Alert tone="success">{note}</Alert>}
        {r.status === 'correction_required' && r.reviewerComment && <Alert tone="warning" title="Correction required">{r.reviewerComment}</Alert>}
        {r.status === 'rejected' && r.reviewerComment && <Alert tone="danger" title="Rejected">{r.reviewerComment}{r.isMine ? ' Upload a new file below.' : ''}</Alert>}
        {r.status === 'cancelled' && <Alert tone="info" title="Cancelled">{r.cancelledReason ?? 'This request was called off.'}</Alert>}

        {mayUpload && (
          <Card>
            <CardHeader title={r.submissions ? 'Upload a new version' : 'Upload the document'} description="It goes straight to the level that asked for it to verify. Earlier versions are kept." />
            <div className="px-5 pb-5"><UploadBox r={r} onDone={() => { setNote('Submitted. It is now waiting for verification.'); router.refresh(); }} /></div>
          </Card>
        )}

        {latest && (
          <Card>
            <CardHeader title="Submitted document" description={`Version ${latest.version} of ${r.versions.length}, uploaded ${fmtWhen(latest.createdAt)}${latest.submittedBy ? ` by ${latest.submittedBy}` : ''}.`} action={<FileActions d={latest} />} />
            <div className="grid gap-4 px-5 pb-5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <DocStatusBadge status={latest.status} label={latest.statusLabel} />
                <span className="text-fg-muted">{latest.fileName} · {fmtSize(latest.sizeBytes)}</span>
                {latest.expiresOn && <span className="text-fg-muted">· expires {fmtDate(latest.expiresOn)}</span>}
                <Link className="text-accent hover:underline" href={`/documents/${latest.id}`}>Document page</Link>
              </div>
              {reviewing && <PreviewPanel d={latest} />}
              {reviewing && <DecisionButtons r={r} expiresOn={latest.expiresOn} onDone={(m) => { setNote(m); router.refresh(); }} />}
              {r.canReview && !reviewing && AWAITING_UPLOAD.includes(r.status) && <p className="text-sm text-fg-muted">Waiting for {asked} to upload a new version.</p>}
            </div>
          </Card>
        )}

        {r.versions.length > 1 && (
          <Card>
            <CardHeader title="Versions" description="Every file submitted for this request, newest first. Old versions are kept for the record." />
            <ul className="grid gap-2 px-5 pb-5 text-sm">
              {r.versions.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <span>v{d.version} · {fmtWhen(d.createdAt)} <DocStatusBadge status={d.status} label={d.statusLabel} />{d.verificationRemarks && <span className="block text-xs text-fg-muted">{d.verificationRemarks}</span>}</span>
                  <FileActions d={d} />
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title="Request history" description="Who did what and when. This record cannot be changed." />
          <HistoryList rows={r.history} />
        </Card>
      </div>

      <div className="grid content-start gap-5">
        <Card>
          <CardHeader title="Request details" />
          <dl className="grid gap-3 px-5 pb-5 text-sm">
            <Row k="Status"><RequestStatusBadge r={r} /></Row>
            <Row k="Document type">{r.typeName} <span className="text-fg-subtle">· {r.categoryName}</span></Row>
            <Row k="Asked of">{asked}</Row>
            <Row k="Requested by">{r.requestedBy.label}{r.requestedBy.name ? <span className="block text-xs text-fg-muted">{r.requestedBy.name}{r.requestedBy.designation ? `, ${r.requestedBy.designation}` : ''}</span> : null}</Row>
            <Row k="Reason">{r.reason}</Row>
            {r.instructions && <Row k="Instructions"><span className="whitespace-pre-wrap">{r.instructions}</span></Row>}
            <Row k="Deadline"><span className={r.overdue ? 'font-medium text-danger' : ''}>{r.dueOn ? fmtDate(r.dueOn) : 'No deadline'}</span>{r.overdue && <Badge tone="danger" className="ml-2">Overdue</Badge>}</Row>
            <Row k="Priority"><span className="capitalize">{r.priority}</span></Row>
            <Row k="Accepted files">{r.formats.map((f) => REQUEST_FILE_LABEL[f]).join(', ')}, up to {r.maxMb} MB</Row>
            {r.expiryRequired && <Row k="Expiry date">Needed with the upload</Row>}
            <Row k="Requested on">{fmtWhen(r.createdAt)}</Row>
            {r.reviewer?.name && <Row k="Verified by">{r.reviewer.name}{r.reviewer.designation ? `, ${r.reviewer.designation}` : ''}{r.decidedAt ? <span className="block text-xs text-fg-muted">{fmtWhen(r.decidedAt)}</span> : null}</Row>}
            {r.taskId && r.isMine && <Row k="Task"><Link className="text-accent hover:underline" href={`/tasks/${r.taskId}`}>Open in My tasks</Link></Row>}
          </dl>
        </Card>
        {r.approvalTrail.length > 0 && (
          <Card>
            <CardHeader title="Verification trail" description="Each submission's approval step and who decided it." />
            <ol className="grid gap-2 px-5 pb-5 text-sm">
              {r.approvalTrail.map((s, i) => (
                <li key={`${s.seq}-${i}`} className="rounded-lg border border-border px-3 py-2">
                  <span className="font-medium capitalize">{s.status.replace(/_/g, ' ')}</span>
                  <span className="block text-xs text-fg-muted">{s.decidedBy ? `${s.decidedBy}${s.decidedAt ? ` · ${fmtWhen(s.decidedAt)}` : ''}` : s.approver ? `Waiting for ${s.approver}` : ''}</span>
                  {s.comment && <span className="block text-xs text-fg-muted">{s.comment}</span>}
                </li>
              ))}
            </ol>
          </Card>
        )}
        {r.canCancel && <CancelRequest id={r.id} />}
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2">
      <dt className="text-fg-muted">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function CancelRequest({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <div><Button variant="secondary" onClick={() => setOpen(true)}>Cancel request</Button></div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Cancel this request?" description="The person is told and their task is closed. The history is kept."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Back</Button><Button variant="danger" loading={pending} disabled={reason.trim().length < 3} onClick={() => start(async () => {
          const res = await cancelRequestAction(id, reason.trim());
          if (!res.ok) return setError(res.message);
          setOpen(false);
          router.refresh();
        })}>Cancel request</Button></>}>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" required>{(p) => <Textarea {...p} rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      </Dialog>
    </>
  );
}

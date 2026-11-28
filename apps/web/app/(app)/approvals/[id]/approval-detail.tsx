'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, PageHeader, Textarea, cn } from '@crew/ui';
import { ArrowLeft, Check, FileText, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { useRefreshOn } from '@/components/live';
import { decideAction } from '../../leave/actions';
import { STATUS_LABEL, STATUS_TONE } from '../approvals-board';
import type { ApprovalDetail } from '../types';

const STEP_KIND: Record<string, string> = { manager: 'Reporting manager', skip_level_manager: "Manager's manager", role: 'Role', person: 'Looped in', hr_workspace: 'HR Workspace', super_workspace: 'Super Workspace' };
const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export function ApprovalDetailView({ d }: { d: ApprovalDetail }) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  useRefreshOn(['approvals.changed']);
  const decide = (decision: 'approve' | 'reject') => start(async () => {
    if (decision === 'reject' && !comment.trim()) {
      setResult({ tone: 'danger', text: 'Add remarks so the person knows why it was rejected.' });
      return;
    }
    const r = await decideAction(d.id, decision, comment.trim() || undefined);
    setResult(r.ok ? { tone: 'success', text: r.data?.status === 'pending' ? 'Approved. It moves to the next approver.' : decision === 'approve' ? 'Approved. The person has been told.' : 'Rejected. The person has been told, with your remarks.' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  const sameDay = (d.details as { sameDayLeave?: { appliedOn: string | null } } | null)?.sameDayLeave;
  // Requests (and the leave application made from one) carry their form: shown as the approver reads it.
  const requestForm = (d.details as { requestForm?: { label: string; value: string }[] } | null)?.requestForm;
  return (
    <>
      <Link href={d.mine ? '/approvals?view=mine' : '/approvals'} className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Approvals</Link>
      <PageHeader eyebrow={<span className="font-mono">{d.ref}</span>} title={d.label} description={d.summary} actions={<Badge tone={STATUS_TONE[d.status]}>{STATUS_LABEL[d.status] ?? d.status}</Badge>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-4">
          <div data-testid="approval-status-message"><Alert tone={d.status === 'approved' ? 'success' : d.status === 'rejected' ? 'danger' : d.status === 'pending' ? 'info' : 'warning'}>
            {d.mine ? d.statusMessage : d.status === 'pending' ? (d.canDecide ? 'This request is waiting for your decision.' : `Waiting for ${d.waitingOn ?? 'an approver'}.`) : d.statusMessage.replace('Your request', 'This request')}
          </Alert></div>
          <Card>
            <CardHeader title="Request details" />
            <CardBody>
              <dl className="grid gap-3 text-[0.8125rem] sm:grid-cols-2">
                <Item label="Request ID" value={<span className="font-mono">{d.ref}</span>} />
                <Item label="Request type" value={`${d.label} (${d.categoryLabel})`} />
                <Item label="Submitted" value={<span suppressHydrationWarning>{at(d.createdAt)}</span>} />
                <Item label="For" value={d.subjectName ?? '—'} />
                <Item label="Submitted by" value={d.requestedBy ?? '—'} />
                <Item label="Current status" value={STATUS_LABEL[d.status] ?? d.status} />
                <Item label="Approval authority" value={d.status === 'pending' ? d.waitingOn ?? 'Nobody yet' : d.finalDecision?.by ?? (d.autoApproved ? 'Approved automatically' : '—')} />
                {sameDay && <Item label="Same-day leave" value={`Applied on ${sameDay.appliedOn ?? 'the day'}`} />}
              </dl>
              {d.link && <Link href={d.link} className="mt-4 inline-block text-xs font-medium text-accent hover:underline">Open the record</Link>}
            </CardBody>
          </Card>
          {requestForm && (
            <section aria-label="What was asked" className="rounded-xl border border-accent/25 bg-accent-subtle/40 p-4" data-testid="request-form">
              <h2 className="mb-3 text-[0.8125rem] font-semibold text-fg">What was asked</h2>
              <dl className="grid gap-3 text-[0.8125rem] sm:grid-cols-2">
                {requestForm.map((f) => (
                  <div key={f.label} className={f.label === 'Reason' ? 'sm:col-span-2' : undefined}>
                    <dt className="text-xs text-fg-subtle">{f.label}</dt>
                    <dd className="whitespace-pre-line break-words font-medium text-fg">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
          <Card>
            <CardHeader title="Supporting documents" />
            <CardBody>
              {d.documents.length ? (
                <ul className="grid gap-2">{d.documents.map((doc) => <li key={doc.href}><a href={doc.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-[0.8125rem] text-accent hover:underline"><FileText className="size-4" /> {doc.name}</a></li>)}</ul>
              ) : <p className="text-[0.8125rem] text-fg-muted">No documents were attached.</p>}
            </CardBody>
          </Card>
          {d.canDecide && d.status === 'pending' && (
            <Card>
              <CardHeader title="Your decision" description="Your comment is shared with the person who asked. A comment is needed when you reject." />
              <CardBody className="grid gap-3">
                <Textarea aria-label="Remarks" placeholder="Write a comment (needed to reject)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={3} />
                <div className="flex gap-2">
                  <Button variant="secondary" loading={pending} onClick={() => decide('reject')}><X className="size-4" /> Reject</Button>
                  <Button loading={pending} onClick={() => decide('approve')}><Check className="size-4" /> Approve</Button>
                </div>
              </CardBody>
            </Card>
          )}
          {result && <Alert tone={result.tone}>{result.text}</Alert>}
        </div>
        <Card className="content-start">
          <CardHeader title="Approval history" />
          <CardBody>
            <ol className="relative grid gap-4 border-l border-border pl-5" data-testid="approval-trail">
              <li className="relative">
                <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full bg-accent" aria-hidden />
                <div className="text-[0.8125rem] font-medium">Submitted</div>
                <div className="text-xs text-fg-muted" suppressHydrationWarning>{d.requestedBy ?? 'Someone'} · {at(d.createdAt)}</div>
              </li>
              {d.trail.map((s) => (
                <li key={s.seq} className="relative">
                  <span className={cn('absolute -left-[1.6rem] top-1 size-2.5 rounded-full', s.status === 'approved' ? 'bg-success' : s.status === 'rejected' ? 'bg-danger' : s.status === 'pending' ? 'bg-warning' : 'bg-fg-subtle')} aria-hidden />
                  <div className="flex flex-wrap items-center gap-2 text-[0.8125rem] font-medium">
                    Step {s.seq}: {s.kind === 'role' ? (s.role ?? 'role').replace(/_/g, ' ') : STEP_KIND[s.kind]}
                    <Badge tone={s.status === 'approved' ? 'success' : s.status === 'rejected' ? 'danger' : s.status === 'pending' ? 'warning' : 'neutral'}>{s.status === 'waiting' ? 'Not reached yet' : s.status === 'pending' ? 'Waiting' : s.status[0]!.toUpperCase() + s.status.slice(1)}</Badge>
                  </div>
                  <div className="text-xs text-fg-muted" suppressHydrationWarning>{s.decidedBy ? `${s.decidedBy} · ${at(s.decidedAt)}` : s.approver ?? (s.status === 'pending' ? d.waitingOn ?? '' : '')}</div>
                  {s.comment && <blockquote className="mt-1 rounded-md bg-bg-subtle px-2.5 py-1.5 text-xs">“{s.comment}”</blockquote>}
                </li>
              ))}
              {d.finalDecision && (
                <li className="relative">
                  <span className={cn('absolute -left-[1.6rem] top-1 size-2.5 rounded-full', d.finalDecision.status === 'approved' ? 'bg-success' : d.finalDecision.status === 'rejected' ? 'bg-danger' : 'bg-fg-subtle')} aria-hidden />
                  <div className="text-[0.8125rem] font-semibold">Final decision: {STATUS_LABEL[d.finalDecision.status]}</div>
                  <div className="text-xs text-fg-muted" suppressHydrationWarning>{d.finalDecision.by ? `${d.finalDecision.by} · ` : ''}{at(d.finalDecision.at)}</div>
                  {d.finalDecision.remarks && <div className="mt-1 text-xs">Remarks: {d.finalDecision.remarks}</div>}
                </li>
              )}
            </ol>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-xs text-fg-subtle">{label}</dt><dd className="font-medium">{value}</dd></div>;
}

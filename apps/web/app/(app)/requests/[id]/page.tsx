import type { RequestEventView, RequestView } from '@crew/contracts';
import { REQUEST_WORKFLOW_LABELS, requestDateLabel, requestTimeLabel } from '@crew/contracts';
import { Alert, Avatar, cn } from '@crew/ui';
import { ArrowLeft, ArrowRight, Ban, Bell, Check, CheckCheck, Clock3, Eye, MessageSquare, Paperclip, RotateCcw, Send, X } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { KindTile, StatusChip } from '../kind-visual';
import { AddComment, CancelApprovedLeave, CancelRequest, DecisionBar, LiveRefresh, ResubmitRequest } from './request-actions';

export const metadata: Metadata = { title: 'Request' };

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

const EVENT: Record<RequestEventView['action'], { label: string; icon: typeof Check; cls: string }> = {
  submitted: { label: 'Submitted', icon: Send, cls: 'bg-accent text-accent-fg' },
  resubmitted: { label: 'Corrected and sent again', icon: Send, cls: 'bg-accent text-accent-fg' },
  approved: { label: 'Approved', icon: Check, cls: 'bg-success text-white' },
  rejected: { label: 'Rejected', icon: X, cls: 'bg-danger text-white' },
  changes_requested: { label: 'Changes requested', icon: RotateCcw, cls: 'bg-info text-white' },
  commented: { label: 'Comment', icon: MessageSquare, cls: 'bg-bg-subtle text-fg-muted' },
  cancelled: { label: 'Cancelled', icon: Ban, cls: 'bg-fg-subtle text-white' },
  completed: { label: 'Fully approved', icon: CheckCheck, cls: 'bg-success text-white' },
  reminded: { label: 'Approvers reminded', icon: Bell, cls: 'bg-warning text-white' },
  cancellation_requested: { label: 'Cancellation requested', icon: Ban, cls: 'bg-warning text-white' },
};

/** Submitted, Pending, then Approved, Rejected or Changes Requested: where the request is now. */
function Progress({ r }: { r: RequestView }) {
  const end = r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : r.status === 'changes_requested' ? 'Changes requested' : r.status === 'cancelled' ? 'Cancelled' : 'Decision';
  const steps = [{ label: 'Submitted', done: true }, { label: 'Pending', done: r.status !== 'pending', current: r.status === 'pending' }, { label: end, done: r.status !== 'pending', current: r.status !== 'pending' }];
  const tone = r.status === 'approved' ? 'bg-success' : r.status === 'rejected' ? 'bg-danger' : r.status === 'changes_requested' ? 'bg-info' : r.status === 'cancelled' ? 'bg-fg-subtle' : 'bg-accent';
  return (
    <ol className="flex items-center gap-2" aria-label="Progress" data-testid="request-progress">
      {steps.map((s, i) => (
        <li key={s.label} className="flex min-w-0 flex-1 items-center gap-2">
          <span className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[0.6875rem] font-bold', s.done || s.current ? `${i === 2 ? tone : 'bg-accent'} text-white` : 'bg-bg-subtle text-fg-muted')}>{i + 1}</span>
          <span className={cn('truncate text-xs font-medium', s.current ? 'text-fg' : 'text-fg-muted')}>{s.label}</span>
          {i < 2 && <span className={cn('h-0.5 flex-1 rounded', s.done ? 'bg-accent/60' : 'bg-border')} aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

export default async function RequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const r = await load<RequestView>(`/requests/${id}`);
  const p = r.requester;
  return (
    <>
      <LiveRefresh />
      <Link href="/requests/mine" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> My Requests</Link>
      {sp.sent && <Alert tone="success" className="mb-4" title={`${r.ref} submitted`}>It went to {r.approvers.map((a) => a.name).join(', ')}{r.cc.length ? `, with ${r.cc.map((c) => c.name).join(', ')} in CC` : ''}. You are told as it is decided.</Alert>}

      <header className="mb-5 flex flex-wrap items-start gap-4">
        <KindTile kind={r.kind} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{r.title}</h1>
            <StatusChip status={r.status} />
          </div>
          <p className="mt-1 text-[0.8125rem] text-fg-muted"><span className="font-mono font-semibold text-fg" data-testid="request-ref">{r.ref}</span> · Raised by {p.name} ({p.levelLabel}) on {at(r.createdAt)}{r.round > 1 ? ` · Round ${r.round}` : ''}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {r.can.resubmit && <ResubmitRequest r={r} />}
          {r.can.cancelApprovedLeave && <CancelApprovedLeave id={r.id} direct={false} />}
          {r.can.cancel && <CancelRequest id={r.id} />}
        </div>
      </header>

      <div className="mb-5 grid gap-4 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
        <Progress r={r} />
        <div className={cn('rounded-xl p-3 text-[0.8125rem]', r.status === 'approved' ? 'bg-success-subtle text-success' : r.status === 'rejected' ? 'bg-danger-subtle text-danger' : r.status === 'changes_requested' ? 'bg-info-subtle text-info' : r.status === 'pending' ? 'bg-warning-subtle text-warning' : 'bg-bg-subtle text-fg-muted')} data-testid="request-status-message">{r.statusMessage}</div>
        {r.can.decide && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/30 bg-accent-subtle/50 p-3">
            <p className="text-[0.8125rem] font-medium text-fg">This request is waiting for your decision.</p>
            <DecisionBar id={r.id} />
          </div>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 content-start gap-5">
          <section aria-labelledby="details" className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <h2 id="details" className="mb-4 text-[0.9375rem] font-semibold text-fg">Request details</h2>
            <dl className="grid gap-4 text-[0.8125rem] sm:grid-cols-2 lg:grid-cols-3">
              <Item label="Request ID" value={<span className="font-mono">{r.ref}</span>} />
              <Item label="Type" value={r.kindLabel} />
              <Item label="When" value={r.when} />
              <Item label="Employee" value={`${p.name}${p.employeeCode ? ` (${p.employeeCode})` : ''}`} />
              <Item label="Designation" value={p.designation ?? '—'} />
              <Item label="Department" value={p.department ?? '—'} />
              <Item label="Workspace" value={[p.levelLabel, p.workspace].filter(Boolean).join(', ')} />
              <Item label="Submitted" value={at(r.createdAt)} />
              {r.decidedAt && <Item label="Decided" value={at(r.decidedAt)} />}
              {r.workedOn && <Item label="Worked on" value={requestDateLabel(r.workedOn)} />}
              {r.leave && <Item label="Leave type" value={r.leave.leaveTypeName} />}
              {r.leave && <Item label="Duration" value={`${r.leave.duration === 'hours' ? `Hours${r.leave.startTime && r.leave.endTime ? `, ${requestTimeLabel(r.leave.startTime)} to ${requestTimeLabel(r.leave.endTime)}` : ''}` : r.leave.duration === 'half' ? 'Half day' : 'Full day'} · ${r.leave.days} day(s)`} />}
              {r.leave && <Item label="Leave status" value={<span className="capitalize">{r.leave.status}</span>} />}
              {r.leave?.contactDuringLeave && <Item label="Contact while on leave" value={r.leave.contactDuringLeave} />}
              {r.leave?.handoverTo && <Item label="Work handed over to" value={r.leave.handoverTo} />}
              {r.cancelsLeave && <Item label="Cancels leave" value={`${r.cancelsLeave.ref}, ${r.cancelsLeave.when}`} />}
              <div className="sm:col-span-2 lg:col-span-3"><dt className="text-xs text-fg-subtle">Reason</dt><dd className="mt-0.5 whitespace-pre-line break-words font-medium text-fg">{r.reason}</dd></div>
              {r.cancelReason && <div className="sm:col-span-2 lg:col-span-3"><dt className="text-xs text-fg-subtle">Why it was cancelled</dt><dd className="font-medium">{r.cancelReason}</dd></div>}
            </dl>
            {r.attachments.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-1.5 text-xs text-fg-subtle">Supporting documents</h3>
                <ul className="flex flex-wrap gap-2">
                  {r.attachments.map((f) => <li key={f.id}><a href={f.href} className="inline-flex items-center gap-1.5 rounded-full bg-bg-subtle px-2.5 py-1 text-xs font-medium text-fg hover:bg-border"><Paperclip className="size-3.5" />{f.name}</a></li>)}
                </ul>
              </div>
            )}
          </section>

          <section aria-labelledby="history" className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <h2 id="history" className="mb-4 text-[0.9375rem] font-semibold text-fg">History and comments</h2>
            <ol className="relative grid gap-4 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-border" data-testid="request-timeline">
              {r.events.map((e) => {
                const v = EVENT[e.action];
                const Icon = v.icon;
                return (
                  <li key={e.id} className="relative flex gap-3" data-testid={`event-${e.action}`}>
                    <span className={cn('relative z-10 inline-flex size-7 shrink-0 items-center justify-center rounded-full ring-4 ring-surface', v.cls)}><Icon className="size-3.5" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[0.8125rem]"><span className="font-semibold text-fg">{v.label}</span>{e.by ? <span className="text-fg-muted"> · {e.by}{e.byLevel ? ` (${e.byLevel})` : ''}</span> : null}</div>
                      <div className="text-[0.6875rem] text-fg-subtle">{at(e.at)}</div>
                      {e.comment && <blockquote className="mt-1.5 whitespace-pre-line break-words rounded-lg rounded-tl-none bg-bg-subtle px-3 py-2 text-[0.8125rem] text-fg">{e.comment}</blockquote>}
                    </div>
                  </li>
                );
              })}
            </ol>
            {r.can.comment && <AddComment id={r.id} />}
          </section>
        </div>

        <div className="grid content-start gap-5">
          <section aria-labelledby="approvers" className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <h2 id="approvers" className="text-[0.9375rem] font-semibold text-fg">Approvers</h2>
            <p className="mb-4 text-xs text-fg-muted">{REQUEST_WORKFLOW_LABELS[r.workflow]}</p>
            <ol className="grid gap-4" data-testid="request-approvers">
              {r.approvers.map((a) => (
                <li key={a.membershipId} className="flex gap-3">
                  <span className="relative shrink-0">
                    <Avatar name={a.name} size={36} />
                    <span className={cn('absolute -bottom-0.5 -right-0.5 inline-flex size-4 items-center justify-center rounded-full text-white ring-2 ring-surface', a.status === 'approved' ? 'bg-success' : a.status === 'rejected' ? 'bg-danger' : a.status === 'changes_requested' ? 'bg-info' : a.status === 'pending' ? 'bg-warning' : 'bg-fg-subtle')}>
                      {a.status === 'approved' ? <Check className="size-2.5" strokeWidth={3} /> : a.status === 'rejected' ? <X className="size-2.5" strokeWidth={3} /> : <Clock3 className="size-2.5" strokeWidth={3} />}
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate text-[0.8125rem] font-semibold text-fg">{a.name}</span>
                      <StatusChip status={a.status} />
                    </div>
                    <div className="truncate text-[0.6875rem] text-fg-muted">{a.part === 'primary' ? 'Primary approver' : 'Additional approver'} · {[a.levelLabel, a.designation].filter(Boolean).join(' · ')}{a.decidedAt ? ` · ${at(a.decidedAt)}` : ''}</div>
                    {a.comment && <blockquote className="mt-1.5 rounded-lg rounded-tl-none bg-bg-subtle px-3 py-2 text-[0.8125rem] text-fg" data-testid="approver-comment">“{a.comment}”</blockquote>}
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {r.cc.length > 0 && (
            <section aria-labelledby="cc" className="rounded-2xl border border-border bg-surface p-5 shadow-card">
              <h2 id="cc" className="mb-1 flex items-center gap-1.5 text-[0.9375rem] font-semibold text-fg"><Eye className="size-4 text-fg-subtle" /> CC participants</h2>
              <p className="mb-3 text-xs text-fg-muted">Told about the request and its decision; they do not approve.</p>
              <ul className="grid gap-2" data-testid="request-cc">
                {r.cc.map((c) => (
                  <li key={c.membershipId} className="flex items-center gap-2"><Avatar name={c.name} size={28} /><span className="min-w-0"><span className="block truncate text-[0.8125rem] font-medium">{c.name}</span><span className="block truncate text-[0.6875rem] text-fg-muted">{c.levelLabel}</span></span></li>
                ))}
              </ul>
            </section>
          )}
          {r.approvalId && (
            <Link href={`/approvals/${r.approvalId}`} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">Open in Approvals <ArrowRight className="size-3.5" /></Link>
          )}
        </div>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-fg-subtle">{label}</dt><dd className="mt-0.5 break-words font-medium text-fg">{value}</dd></div>;
}

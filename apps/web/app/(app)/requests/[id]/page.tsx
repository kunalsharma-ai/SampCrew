import type { RequestView } from '@crew/contracts';
import { requestDateLabel } from '@crew/contracts';
import { Alert, Avatar, cn } from '@crew/ui';
import { ArrowLeft, ArrowRight, CalendarCheck2, Check, Clock3, Plane, X } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { KindTile, StatusChip } from '../kind-visual';
import { CancelRequest, LiveRefresh } from './request-actions';

export const metadata: Metadata = { title: 'Request' };

const at = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export default async function RequestPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sent?: string; applied?: string }> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const r = await load<RequestView>(`/requests/${id}`);
  const first = r.requester.name.split(' ')[0];
  return (
    <>
      <LiveRefresh />
      <Link href="/requests" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Requests</Link>
      {sp.sent && <Alert tone="success" className="mb-4" title="Request sent">It is in the Approvals of {r.approvers.map((a) => a.name).join(', ')}. You will be notified as each of them decides.</Alert>}
      {sp.applied && <Alert tone="success" className="mb-4" title="Leave application sent">Your leave application went to {r.approvers.map((a) => a.name).join(', ')} in Approvals and by email. A copy is in your mailbox.</Alert>}

      <header className="mb-5 flex flex-wrap items-start gap-4">
        <KindTile kind={r.kind} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{r.title}</h1>
            <StatusChip status={r.status} />
          </div>
          <p className="mt-1 text-[0.8125rem] text-fg-muted"><span className="font-mono">{r.ref}</span> · Raised by {r.requester.name} ({r.requester.levelLabel}) on {at(r.createdAt)}</p>
        </div>
        {r.canCancel && <CancelRequest id={r.id} />}
      </header>

      {r.canApplyLeave && (
        <section aria-label="Apply for leave" className="relative mb-5 overflow-hidden rounded-2xl bg-gradient-to-br from-accent to-[#7c3aed] p-5 text-white shadow-pop" data-testid="apply-leave-banner">
          <div className="pointer-events-none absolute -right-10 -top-10 size-44 rounded-full bg-white/15 blur-2xl" aria-hidden />
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
            <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-2xl bg-white/20 shadow-inner" aria-hidden><CalendarCheck2 className="size-6" /></span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold">{first}, your request is approved. Please apply for your leave.</h2>
              <p className="text-[0.8125rem] text-white/85">The leave application form is already filled in with your details, your manager and HR, the days and the reason. It goes to the same people.</p>
            </div>
            <Link href={`/requests/${r.id}/apply`} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-[#3730a3] shadow-card hover:bg-white/90" data-testid="apply-leave-cta"><Plane className="size-4" /> Apply for leave</Link>
          </div>
        </section>
      )}
      {r.leaveApplication && (
        <Alert tone={r.leaveApplication.status === 'approved' ? 'success' : r.leaveApplication.status === 'rejected' ? 'danger' : 'info'} className="mb-5" title={`Leave application ${r.leaveApplication.ref}: ${r.leaveApplication.status}`}>
          {r.leaveApplication.leaveTypeName}, {r.leaveApplication.days} day(s). <Link className="font-medium underline" href={`/leave/requests/${r.leaveApplication.id}`}>Open the leave application</Link>
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="details" className="content-start rounded-2xl border border-border bg-surface p-5 shadow-card">
          <h2 id="details" className="mb-4 text-[0.9375rem] font-semibold text-fg">Request details</h2>
          <div className={cn('mb-4 rounded-xl p-3 text-[0.8125rem]', r.status === 'approved' ? 'bg-success-subtle text-success' : r.status === 'rejected' ? 'bg-danger-subtle text-danger' : r.status === 'pending' ? 'bg-warning-subtle text-warning' : 'bg-bg-subtle text-fg-muted')} data-testid="request-status-message">{r.statusMessage}</div>
          <dl className="grid gap-4 text-[0.8125rem] sm:grid-cols-2">
            <Item label="Type" value={r.kindLabel} />
            <Item label="When" value={r.when} />
            {r.workedOn && <Item label="Worked on" value={requestDateLabel(r.workedOn)} />}
            {r.leaveTypeName && <Item label="Leave type" value={r.leaveTypeName} />}
            <Item label="Days" value={String(r.days)} />
            {r.decidedAt && <Item label="Decided" value={at(r.decidedAt)} />}
            <div className="sm:col-span-2"><dt className="text-xs text-fg-subtle">Reason</dt><dd className="mt-0.5 whitespace-pre-line break-words font-medium text-fg">{r.reason}</dd></div>
            {r.cancelReason && <div className="sm:col-span-2"><dt className="text-xs text-fg-subtle">Why it was cancelled</dt><dd className="font-medium">{r.cancelReason}</dd></div>}
          </dl>
        </section>

        <section aria-labelledby="decisions" className="content-start rounded-2xl border border-border bg-surface p-5 shadow-card">
          <h2 id="decisions" className="mb-4 text-[0.9375rem] font-semibold text-fg">Approvers and comments</h2>
          <ol className="grid gap-4" data-testid="request-approvers">
            {r.approvers.map((a) => (
              <li key={a.membershipId} className="flex gap-3">
                <span className="relative shrink-0">
                  <Avatar name={a.name} size={36} />
                  <span className={cn('absolute -bottom-0.5 -right-0.5 inline-flex size-4 items-center justify-center rounded-full ring-2 ring-surface text-white', a.status === 'approved' ? 'bg-success' : a.status === 'rejected' ? 'bg-danger' : a.status === 'pending' ? 'bg-warning' : 'bg-fg-subtle')}>
                    {a.status === 'approved' ? <Check className="size-2.5" strokeWidth={3} /> : a.status === 'rejected' ? <X className="size-2.5" strokeWidth={3} /> : <Clock3 className="size-2.5" strokeWidth={3} />}
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-[0.8125rem] font-semibold text-fg">{a.name}</span>
                    <StatusChip status={a.status === 'cancelled' && r.status === 'rejected' ? 'waiting' : a.status} />
                  </div>
                  <div className="truncate text-[0.6875rem] text-fg-muted">{[a.levelLabel, a.designation].filter(Boolean).join(' · ')}{a.decidedAt ? ` · ${at(a.decidedAt)}` : ''}</div>
                  {a.comment && <blockquote className="mt-1.5 rounded-lg rounded-tl-none bg-bg-subtle px-3 py-2 text-[0.8125rem] text-fg" data-testid="approver-comment">“{a.comment}”</blockquote>}
                </div>
              </li>
            ))}
          </ol>
          {r.approvalId && (
            <Link href={`/approvals/${r.approvalId}`} className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">Open in Approvals <ArrowRight className="size-3.5" /></Link>
          )}
        </section>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-fg-subtle">{label}</dt><dd className="mt-0.5 break-words font-medium text-fg">{value}</dd></div>;
}

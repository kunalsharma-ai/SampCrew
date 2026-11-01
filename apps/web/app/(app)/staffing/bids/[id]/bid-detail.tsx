'use client';
import { formatAmount } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, PageHeader, Table, TBody, TD, TH, THead, TR, Textarea, buttonClass, cn } from '@crew/ui';
import { AlertTriangle, Check, Clock, Download, Mail, Pencil, Send, Trash2, Trophy, Undo2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { InboxItem } from '@/lib/types';
import { decideAction } from '../../../leave/actions';
import { bidAction, bidOutcomeAction, cancelBidEmailAction, sendBidAction } from '../../actions';
import { BID_STATUS_LABEL, BID_STATUS_TONE, type Bid } from '../../types';

const dt = (s: string) => new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function emailState(e: Bid['emails'][number]): { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; cancellable: boolean } {
  if (e.cancelledAt) return { label: 'Cancelled', tone: 'neutral', cancellable: false };
  const st = e.delivery.map((d) => d.status);
  if (st.length && st.every((s) => s === 'sent')) return { label: `Delivered ${e.delivery[0]?.sentAt ? dt(e.delivery[0].sentAt) : ''}`.trim(), tone: 'success', cancellable: false };
  if (st.some((s) => s === 'failed')) return { label: 'Failed', tone: 'danger', cancellable: false };
  if (st.some((s) => s === 'skipped')) return { label: 'Not delivered: email sending is not set up', tone: 'warning', cancellable: false };
  const queued = st.every((s) => s === 'queued');
  if (queued && new Date(e.sendAt) > new Date()) return { label: `Scheduled for ${dt(e.sendAt)}`, tone: 'warning', cancellable: true };
  return { label: 'Sending', tone: 'info', cancellable: queued };
}

export function BidDetail({ bid, myApproval, notice, senderName, workspace }: { bid: Bid; myApproval: InboxItem | null; notice: string | null; senderName: string; workspace: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(notice ? { tone: 'warning', text: notice } : null);
  const [sendOpen, setSendOpen] = useState(false);
  const [outcome, setOutcome] = useState<'won' | 'lost' | 'withdrawn' | null>(null);
  const [comment, setComment] = useState('');
  const [pdfKey, setPdfKey] = useState(0);
  const money = (v: string) => `${bid.currency} ${formatAmount(v, bid.currency)}`;
  const p = bid.pricing;
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) => start(async () => {
    const r = await fn();
    setMsg(r.ok ? (r.message ? { tone: 'success', text: r.message } : null) : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    if (r.ok) { after?.(); router.refresh(); setPdfKey((k) => k + 1); }
  });
  const sentVersions = bid.versions.filter((v) => v.event === 'sent');

  return (
    <>
      <PageHeader
        eyebrow={<Link href="/staffing/bids" className="hover:underline">Staffing bids</Link>}
        title={bid.title}
        description={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{bid.code}</span> · version {bid.version} · {bid.clientName} · {bid.mode === 'quick' ? 'Quick Bid' : 'Advanced Bid'} by {bid.ownerName} <Badge tone={BID_STATUS_TONE[bid.status]} dot>{BID_STATUS_LABEL[bid.status]}</Badge></span>}
        actions={(
          <div className="flex flex-wrap gap-2">
            {bid.can.edit && <Link href={`/staffing/bids/${bid.id}/edit`} className={buttonClass('secondary')}><Pencil className="size-4" /> Edit</Link>}
            {bid.can.submit && <Button onClick={() => run(() => bidAction(bid.id, 'submit'))} loading={pending}><Check className="size-4" /> Submit for approval</Button>}
            {bid.can.send && <Button onClick={() => setSendOpen(true)}><Send className="size-4" /> {bid.status === 'sent' ? 'Send again' : 'Send proposal'}</Button>}
            {bid.can.decide && <Button variant="secondary" onClick={() => setOutcome('won')}><Trophy className="size-4" /> Mark won</Button>}
            {bid.can.decide && <Button variant="secondary" onClick={() => setOutcome('lost')}>Mark lost</Button>}
            {bid.can.withdraw && <Button variant="ghost" onClick={() => setOutcome('withdrawn')}><Undo2 className="size-4" /> Withdraw</Button>}
            {bid.can.delete && <Button variant="ghost" onClick={() => { if (confirm('Delete this draft?')) start(async () => { const r = await bidAction(bid.id, 'delete'); if (r.ok) router.push('/staffing/bids'); else setMsg({ tone: 'danger', text: r.message }); }); }}><Trash2 className="size-4" /> Delete</Button>}
          </div>
        )}
      />
      {msg && <Alert tone={msg.tone} className="mb-4">{msg.text}</Alert>}
      {bid.status === 'rejected' && <Alert tone="danger" className="mb-4" title="Finance asked for changes">{bid.approval?.steps.find((s) => s.status === 'rejected')?.comment ?? 'Edit the bid and submit it again.'}</Alert>}
      {bid.status === 'pending_approval' && !myApproval && <Alert tone="info" className="mb-4">Waiting for Finance to approve. The proposal can be sent once it is approved.</Alert>}
      {(bid.status === 'won' || bid.status === 'lost' || bid.status === 'withdrawn') && bid.outcomeReason && <Alert tone={bid.status === 'won' ? 'success' : 'info'} className="mb-4">{BID_STATUS_LABEL[bid.status]}: {bid.outcomeReason}</Alert>}

      {myApproval && (
        <Card className="mb-5 border-warning/40 p-5" aria-label="Your approval">
          <h2 className="text-sm font-semibold">Your approval is needed</h2>
          <p className="mt-1 text-sm text-fg-muted">{myApproval.summary}</p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
            <Textarea aria-label="Comment" placeholder="Comment (optional, shared with the bid owner)" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={1} className="min-h-9 flex-1" />
            <div className="flex gap-2">
              <Button variant="secondary" loading={pending} onClick={() => run(async () => { const r = await decideAction(myApproval.id, 'reject', comment.trim() || undefined); return r.ok ? { ok: true, message: 'Sent back for changes' } : r; })}><X className="size-4" /> Reject</Button>
              <Button loading={pending} onClick={() => run(async () => { const r = await decideAction(myApproval.id, 'approve', comment.trim() || undefined); return r.ok ? { ok: true, message: 'Bid approved' } : r; })}><Check className="size-4" /> Approve bid</Button>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_26rem]">
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure label="Contract value" value={money(p.contractRevenue)} />
            <Figure label="Monthly billing" value={money(p.monthlyRevenue)} />
            <Figure label="Contract margin" value={money(p.contractMargin)} />
            <Figure label="Margin" value={<Badge tone={p.lossMaking ? 'danger' : p.belowTarget ? 'warning' : 'success'}>{p.marginPct}% (target {bid.targetMarginPct}%)</Badge>} />
          </div>
          {p.belowTarget && <Alert tone={p.lossMaking ? 'danger' : 'warning'}><span className="inline-flex items-center gap-1.5"><AlertTriangle className="size-4" />{p.lossMaking ? 'This bid costs more than it earns.' : `The margin is below the ${bid.targetMarginPct}% target. Finance sees this when approving.`}</span></Alert>}

          <Card>
            <CardHeader title="Pricing" description={`Internal view: on-costs ${bid.onCostPct}%, overhead ${bid.overheadPct}%. ${bid.durationMonths} months from ${bid.startDate}. Billing entity ${bid.legalEntityName}.`} />
            <div className="overflow-x-auto">
              <Table>
                <THead><TR><TH>Role</TH><TH className="text-right">People</TH><TH className="text-right">Pay</TH><TH className="text-right">Loaded cost</TH><TH className="text-right">Bill rate</TH><TH className="text-right">Margin</TH><TH className="text-right">Per month</TH></TR></THead>
                <TBody>
                  {p.lines.map((l, i) => (
                    <TR key={i}>
                      <TD><span className="block font-medium">{l.roleTitle}</span><span className="block text-xs text-fg-subtle">{l.location ?? 'No location'}{l.billDerived ? ' · rate from target margin' : ''}</span></TD>
                      <TD className="text-right tabular-nums">{l.headcount}</TD>
                      <TD className="text-right tabular-nums whitespace-nowrap">{money(l.payMonthly)}</TD>
                      <TD className="text-right tabular-nums whitespace-nowrap">{money(l.loadedCostMonthly)}</TD>
                      <TD className="text-right tabular-nums whitespace-nowrap">{money(l.billMonthly)}</TD>
                      <TD className={cn('text-right tabular-nums', l.belowTarget && 'text-warning')}>{l.marginPct}%</TD>
                      <TD className="text-right tabular-nums whitespace-nowrap">{money(l.monthlyRevenue)}</TD>
                    </TR>
                  ))}
                  <TR><TD className="font-medium">Total</TD><TD className="text-right tabular-nums font-medium">{p.headcount}</TD><TD /><TD className="text-right tabular-nums">{money(p.monthlyCost)}</TD><TD /><TD className="text-right tabular-nums font-medium">{p.marginPct}%</TD><TD className="text-right tabular-nums font-medium whitespace-nowrap">{money(p.monthlyRevenue)}</TD></TR>
                </TBody>
              </Table>
            </div>
          </Card>

          <Card>
            <CardHeader title="Proposal emails" description="Each email carries the PDF of the version it was sent with." />
            {bid.emails.length ? (
              <ul className="divide-y divide-border">
                {bid.emails.map((e) => {
                  const s = emailState(e);
                  return (
                    <li key={e.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
                      <Mail className="hidden size-4 text-fg-subtle sm:block" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{e.subject}</p>
                        <p className="truncate text-xs text-fg-subtle">To {e.to}{e.cc.length ? `, cc ${e.cc.join(', ')}` : ''} · version {bid.versions.find((v) => v.id === e.versionId)?.version ?? '?'}</p>
                      </div>
                      <Badge tone={s.tone}>{s.label}</Badge>
                      {s.cancellable && bid.can.send && <Button size="sm" variant="secondary" loading={pending} onClick={() => run(() => cancelBidEmailAction(bid.id, e.id))}>Cancel email</Button>}
                    </li>
                  );
                })}
              </ul>
            ) : <p className="px-5 pb-5 text-sm text-fg-muted">{bid.can.send ? 'Not sent yet. Use Send proposal to email it now or at a set time.' : 'Nothing sent yet.'}</p>}
          </Card>

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Approval" />
              {bid.approval ? (
                <ol className="space-y-3 px-5 pb-5">
                  {bid.approval.steps.map((s) => (
                    <li key={s.seq} className="text-sm">
                      <div className="flex items-center gap-2">
                        <Badge tone={s.status === 'approved' ? 'success' : s.status === 'rejected' ? 'danger' : s.status === 'pending' ? 'warning' : 'neutral'}>{s.status}</Badge>
                        <span>{s.decidedBy ?? s.approver ?? (s.role ? s.role.replace(/_/g, ' ') : 'Approver')}</span>
                      </div>
                      {s.decidedAt && <p className="mt-1 text-xs text-fg-subtle">{dt(s.decidedAt)}{s.comment ? `: “${s.comment}”` : ''}</p>}
                    </li>
                  ))}
                </ol>
              ) : <p className="px-5 pb-5 text-sm text-fg-muted">Not submitted yet.</p>}
            </Card>
            <Card>
              <CardHeader title="History" description="Every submitted or sent version is kept." />
              {bid.versions.length ? (
                <ul className="space-y-2 px-5 pb-5 text-sm">
                  {bid.versions.map((v) => (
                    <li key={v.id} className="flex items-center gap-2">
                      <Clock className="size-3.5 text-fg-subtle" />
                      <span className="flex-1">Version {v.version} {v.event} {dt(v.createdAt)}{v.createdBy ? ` by ${v.createdBy}` : ''} · {money(v.pricing.contractRevenue)}</span>
                      {v.hasPdf && <a href={`/staffing-pdf/${bid.id}?version=${v.id}`} target="_blank" rel="noreferrer" className="text-accent hover:underline" aria-label={`PDF of version ${v.version}`}>PDF</a>}
                    </li>
                  ))}
                </ul>
              ) : <p className="px-5 pb-5 text-sm text-fg-muted">No versions yet.</p>}
            </Card>
          </div>
        </div>

        <Card className="xl:sticky xl:top-4 xl:self-start">
          <CardHeader
            title="Client proposal"
            description="What the client sees: roles, rates and totals, never costs or margins."
            action={<a href={`/staffing-pdf/${bid.id}`} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm')}><Download className="size-3.5" /> Open PDF</a>}
          />
          <iframe key={pdfKey} title="Proposal preview" src={`/staffing-pdf/${bid.id}#view=FitH`} className="h-[36rem] w-full border-t border-border bg-bg-subtle" />
        </Card>
      </div>

      <SendDialog key={sendOpen ? `send-${bid.version}` : "send-closed"} open={sendOpen} onClose={() => setSendOpen(false)} bid={bid} senderName={senderName} workspace={workspace} again={sentVersions.length > 0} onDone={(text) => { setMsg({ tone: 'success', text }); router.refresh(); }} />
      <OutcomeDialog outcome={outcome} onClose={() => setOutcome(null)} onConfirm={(reason) => run(() => bidOutcomeAction(bid.id, outcome!, reason), () => setOutcome(null))} pending={pending} />
    </>
  );
}

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-fg-subtle">{label}</p>
      <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
    </Card>
  );
}

function SendDialog({ open, onClose, bid, senderName, workspace, again, onDone }: { open: boolean; onClose: () => void; bid: Bid; senderName: string; workspace: string; again: boolean; onDone: (text: string) => void }) {
  const [pending, start] = useTransition();
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const greeting = bid.clientContact ? `Dear ${bid.clientContact.split(' ')[0]},` : 'Hello,';
  const defaultMessage = `${greeting}\n\nPlease find attached our proposal for ${bid.title}.\n\nWe would be glad to walk you through it and answer any questions.\n\nRegards,\n${senderName}\n${workspace}`;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={again ? 'Send the proposal again' : 'Send the proposal'}
      description={`The PDF of version ${bid.version} is attached. It is kept with the bid, so you can always see exactly what the client received.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="send-form" loading={pending}><Send className="size-4" /> {when === 'now' ? 'Send now' : 'Schedule email'}</Button></>}
    >
      <form
        id="send-form"
        className="grid grid-cols-1 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const cc = String(f.get('cc') ?? '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
          const at = String(f.get('sendAt') ?? '');
          if (when === 'later' && !at) { setFe({ sendAt: 'Choose when to send' }); return; }
          const body = { to: String(f.get('to') ?? '').trim(), cc, subject: String(f.get('subject') ?? '').trim(), message: String(f.get('message') ?? '').trim(), sendAt: when === 'later' ? new Date(at).toISOString() : undefined };
          setError(null); setFe({});
          start(async () => {
            const r = await sendBidAction(bid.id, body);
            if (r.ok) { onClose(); onDone(when === 'now' ? `Proposal sent to ${body.to}${cc.length ? ` and ${cc.length} more` : ''}` : `Email scheduled for ${new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`); } else { setError(r.message); setFe(r.fieldErrors ?? {}); }
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="To" required error={fe.to}>{(f) => <Input {...f} name="to" type="email" defaultValue={bid.clientEmail ?? ''} required />}</Field>
          <Field label="Cc" hint="Up to 5, separated by commas" error={fe.cc}>{(f) => <Input {...f} name="cc" />}</Field>
        </div>
        <Field label="Subject" required error={fe.subject}>{(f) => <Input {...f} name="subject" defaultValue={`Staffing proposal ${bid.code}: ${bid.title}`} required maxLength={200} />}</Field>
        <Field label="Message" required error={fe.message}>{(f) => <Textarea {...f} name="message" rows={8} defaultValue={defaultMessage} required maxLength={4000} />}</Field>
        <fieldset className="space-y-2">
          <legend className="text-[0.8125rem] font-medium">When</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> Send now</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> Schedule for later</label>
          {when === 'later' && <Field label="Send at" error={fe.sendAt}>{(f) => <Input {...f} name="sendAt" type="datetime-local" className="sm:w-64" />}</Field>}
        </fieldset>
      </form>
    </Dialog>
  );
}

function OutcomeDialog({ outcome, onClose, onConfirm, pending }: { outcome: 'won' | 'lost' | 'withdrawn' | null; onClose: () => void; onConfirm: (reason: string) => void; pending: boolean }) {
  const [reason, setReason] = useState('');
  const title = outcome === 'won' ? 'Mark this bid as won' : outcome === 'lost' ? 'Mark this bid as lost' : 'Withdraw this bid';
  return (
    <Dialog
      open={outcome !== null}
      onClose={onClose}
      title={title}
      description={outcome === 'withdrawn' ? 'Any approval still waiting is cancelled, and scheduled emails that have not gone are stopped.' : 'This closes the bid and counts towards your win rate.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => onConfirm(reason.trim())}>{outcome === 'withdrawn' ? 'Withdraw' : 'Confirm'}</Button></>}
    >
      <Field label={outcome === 'won' ? 'Notes' : 'Reason'} hint="Optional">{(f) => <Textarea {...f} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
    </Dialog>
  );
}

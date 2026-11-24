'use client';
import type { CreditNoteView } from '@crew/contracts';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { ReceiptText, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { refundAction, voidCreditNoteAction } from '@/app/(console)/console-actions';
import { LocalTime } from './local-time';
import { fmtMoney } from '@/lib/format';

const METHOD: Record<CreditNoteView['method'], string> = { gateway: 'Back to the card or account (gateway)', bank_transfer: 'Bank transfer', account_credit: 'Account credit' };

/**
 * Refund a paid invoice, in full or in part. A gateway refund goes back through Razorpay or Stripe; a bank-transfer
 * refund records the transfer reference. Either way a credit note is issued, the client is told and it is audited.
 */
export function RefundButton({ invoice }: { invoice: { id: string; number: string | null; total: string; currency: string; provider: string; refunded?: string } }) {
  const router = useRouter();
  const left = Math.max(0, Number(invoice.total) - Number(invoice.refunded ?? 0));
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(left.toFixed(2));
  const [method, setMethod] = useState<'gateway' | 'bank_transfer'>(invoice.provider === 'manual' ? 'bank_transfer' : 'gateway');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ok = /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && Number(amount) <= left && reason.trim().length >= 3 && (method !== 'bank_transfer' || reference.trim().length > 0);
  if (left <= 0) return <Badge>Refunded</Badge>;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid={`refund-${invoice.number ?? invoice.id}`}><Undo2 className="size-3.5" aria-hidden />Refund</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title={`Refund invoice ${invoice.number ?? ''}`} description={`Up to ${fmtMoney(left, invoice.currency, 2)} can still be refunded. A credit note is issued and the client's Super Workspace Admins are told.`}
          footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" disabled={!ok} loading={pending} data-testid="refund-confirm" onClick={() => start(async () => {
            const r = await refundAction({ invoiceId: invoice.id, amount, method, reason: reason.trim(), ...(method === 'bank_transfer' ? { reference: reference.trim() } : {}) });
            if (!r.ok) { setError(r.message ?? 'Not refunded'); return; }
            setOpen(false);
            router.refresh();
          })}>Refund {/^\d/.test(amount) ? fmtMoney(amount, invoice.currency, 2) : ''}</Button></>}>
          <div className="grid gap-3">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="Amount" hint={`${invoice.currency}, at most ${left.toFixed(2)}`} required>{(p) => <Input {...p} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />}</Field>
            <Field label="How">{(p) => <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'gateway' | 'bank_transfer')}>{invoice.provider !== 'manual' && <option value="gateway">{METHOD.gateway}</option>}<option value="bank_transfer">{METHOD.bank_transfer}</option></Select>}</Field>
            {method === 'bank_transfer' && <Field label="Transfer reference" hint="The UTR or bank reference of the money you sent back" required>{(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />}</Field>}
            <Field label="Reason" hint="Shown on the credit note and in the audit log" required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />}</Field>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function CreditNotesTable({ notes, canRefund, showWorkspace = true }: { notes: CreditNoteView[]; canRefund: boolean; showWorkspace?: boolean }) {
  const router = useRouter();
  const [voiding, setVoiding] = useState<CreditNoteView | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!notes.length) return <EmptyState icon={<ReceiptText className="size-6" />} title="No refunds or credit notes" />;
  return (
    <>
      <Table aria-label="Credit notes">
        <THead><TR><TH>Credit note</TH>{showWorkspace && <TH>Workspace</TH>}<TH>Invoice</TH><TH>How</TH><TH className="text-right">Amount</TH><TH>Status</TH><TH>Issued</TH><TH /></TR></THead>
        <TBody>
          {notes.map((n) => (
            <TR key={n.id} data-testid="credit-note-row">
              <TD><span className="font-mono text-[12px]">{n.number}</span><span className="block text-[11.5px] text-fg-subtle">{n.reason}</span></TD>
              {showWorkspace && <TD>{n.clientId ? <Link href={`/clients/${n.clientId}/billing`} className="hover:underline">{n.workspace}</Link> : n.workspace}</TD>}
              <TD className="font-mono text-[12px]">{n.invoiceNumber ?? '—'}</TD>
              <TD className="text-[12.5px]">{METHOD[n.method]}{n.providerRef && <span className="block font-mono text-[11px] text-fg-subtle">{n.providerRef}</span>}</TD>
              <TD className="text-right tabular">{fmtMoney(n.amount, n.currency, 2)}</TD>
              <TD><Badge tone={n.status === 'void' ? 'neutral' : 'success'}>{n.status === 'void' ? 'Void' : 'Issued'}</Badge>{n.voidReason && <span className="block text-[11px] text-fg-subtle">{n.voidReason}</span>}</TD>
              <TD className="whitespace-nowrap text-fg-muted"><LocalTime value={n.createdAt} dateOnly />{n.createdBy && <span className="block text-[11px]">{n.createdBy}</span>}</TD>
              <TD className="text-right">{canRefund && n.status === 'issued' && n.method === 'bank_transfer' && <Button size="sm" variant="ghost" onClick={() => { setVoiding(n); setReason(''); setError(null); }}>Void</Button>}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
      {voiding && (
        <Dialog open onClose={() => setVoiding(null)} title={`Void credit note ${voiding.number}`} description="Only for a bank-transfer refund that was recorded by mistake. The note stays in the records, marked void; the invoice can be refunded again."
          footer={<><Button variant="ghost" onClick={() => setVoiding(null)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} loading={pending} onClick={() => start(async () => {
            const r = await voidCreditNoteAction(voiding.id, reason.trim());
            if (!r.ok) { setError(r.message ?? 'Not voided'); return; }
            setVoiding(null);
            router.refresh();
          })}>Void</Button></>}>
          {error && <Alert tone="danger" className="mb-3">{error}</Alert>}
          <Field label="Reason" required>{(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} />}</Field>
        </Dialog>
      )}
    </>
  );
}

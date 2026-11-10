'use client';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Download, FileText } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { markInvoicePaidAction, voidInvoiceAction } from '../app/(console)/actions';

export interface ConsoleInvoice {
  id: string; number: string | null; tenantId: string; tenant: string; kind: string; status: string; currency: string; subtotal: string; tax: string; total: string;
  issuedAt: string | null; dueAt: string | null; paidAt: string | null; provider: string; reference: string | null; periodStart: string | null; periodEnd: string | null;
  overdue: boolean; voidReason: string | null;
}

export const money = (amount: string | number, currency: string) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount));
export const day = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? `${d}T00:00:00Z` : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const KIND: Record<string, string> = { subscription: 'Subscription', renewal: 'Renewal', upgrade: 'Plan change', addon: 'Add-on', overage: 'Overage', manual: 'By hand' };
const PROVIDER: Record<string, string> = { razorpay: 'Razorpay', stripe: 'Stripe', manual: 'Bank transfer' };

/** Invoices with the actions billing staff take on them: record a bank transfer, void, download. */
export function InvoiceTable({ invoices, canManage, showWorkspace }: { invoices: ConsoleInvoice[]; canManage: boolean; showWorkspace: boolean }) {
  const router = useRouter();
  const [paying, setPaying] = useState<ConsoleInvoice | null>(null);
  const [voiding, setVoiding] = useState<ConsoleInvoice | null>(null);
  const [note, setNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const done = (r: { ok: boolean; message?: string }) => {
    setNote(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message ?? 'Something went wrong' });
    setPaying(null);
    setVoiding(null);
    if (r.ok) router.refresh();
  };
  if (invoices.length === 0) return <EmptyState icon={<FileText className="size-6" />} title="No invoices" />;
  return (
    <div className="grid gap-3">
      {note && <Alert tone={note.tone}>{note.text}</Alert>}
      <div className="overflow-x-auto">
        <Table aria-label="Invoices">
          <THead>
            <TR><TH>Number</TH>{showWorkspace && <TH>Workspace</TH>}<TH>For</TH><TH>Issued</TH><TH>Status</TH><TH className="text-right">Total</TH><TH><span className="sr-only">Actions</span></TH></TR>
          </THead>
          <TBody>
            {invoices.map((i) => (
              <TR key={i.id} data-testid={`console-invoice-${i.number ?? i.id}`}>
                <TD className="font-mono text-xs">{i.number ?? 'Draft'}</TD>
                {showWorkspace && <TD><Link href={`/tenants/${i.tenantId}/billing`} className="text-accent hover:underline">{i.tenant}</Link></TD>}
                <TD>{KIND[i.kind] ?? i.kind}</TD>
                <TD className="text-[0.8125rem]">{day(i.issuedAt)}</TD>
                <TD>
                  <Badge tone={i.status === 'paid' ? 'success' : i.status === 'void' ? 'neutral' : i.overdue ? 'danger' : 'warning'}>{i.status === 'open' && i.overdue ? 'overdue' : i.status}</Badge>
                  <div className="mt-0.5 text-xs text-fg-muted">
                    {i.status === 'open' && i.dueAt ? `due ${day(i.dueAt)}` : i.status === 'paid' ? `${PROVIDER[i.provider] ?? i.provider}${i.reference ? ` · ${i.reference}` : ''}` : i.voidReason ?? ''}
                  </div>
                </TD>
                <TD className="text-right tabular">{money(i.total, i.currency)}<div className="text-xs text-fg-muted">tax {money(i.tax, i.currency)}</div></TD>
                <TD className="whitespace-nowrap text-right">
                  <div className="flex justify-end gap-1">
                    {canManage && i.status === 'open' && <Button size="sm" variant="secondary" onClick={() => setPaying(i)} data-testid="invoice-mark-paid">Mark paid</Button>}
                    {canManage && i.status === 'open' && <Button size="sm" variant="ghost" onClick={() => setVoiding(i)} data-testid="invoice-void">Void</Button>}
                    {i.number && <a href={`/invoice-pdf/${i.id}`} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-accent hover:bg-bg-subtle"><Download className="size-3.5" aria-hidden /> PDF</a>}
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      {paying && <MarkPaidDialog invoice={paying} onClose={() => setPaying(null)} onDone={done} />}
      {voiding && <VoidDialog invoice={voiding} onClose={() => setVoiding(null)} onDone={done} />}
    </div>
  );
}

function MarkPaidDialog({ invoice, onClose, onDone }: { invoice: ConsoleInvoice; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`Record payment for ${invoice.number}`} description={`${money(invoice.total, invoice.currency)} from ${invoice.tenant}. If nothing else is overdue, the workspace's past-due state and read-only lock are lifted.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={pending} disabled={reference.trim().length < 2} data-testid="mark-paid-confirm" onClick={() => start(async () => {
        const r = await markInvoicePaidAction(invoice.id, { reference: reference.trim(), paidOn });
        if (!r.ok) setError(r.message); else onDone(r);
      })}>Record payment</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Bank reference" required hint="UTR, cheque number or remittance reference">{(p) => <Input {...p} value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} data-testid="mark-paid-reference" />}</Field>
        <Field label="Received on">{(p) => <Input {...p} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

function VoidDialog({ invoice, onClose, onDone }: { invoice: ConsoleInvoice; onClose: () => void; onDone: (r: { ok: boolean; message?: string }) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`Void ${invoice.number}`} description="The invoice keeps its number but no longer needs paying. Issue a new one if an amount is still owed."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={pending} disabled={reason.trim().length < 5} onClick={() => start(async () => {
        const r = await voidInvoiceAction(invoice.id, reason.trim());
        if (!r.ok) setError(r.message); else onDone(r);
      })}>Void invoice</Button></>}>
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason" required>{(p) => <Input {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

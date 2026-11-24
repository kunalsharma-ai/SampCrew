import type { CreditNoteView } from '@crew/contracts';
import { Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import Link from 'next/link';
import type { ConsoleInvoice } from '@/components/invoice-table';
import { LocalTime } from '@/components/local-time';
import { CreditNotesTable, RefundButton } from '@/components/refunds';
import { fmtMoney } from '@/lib/format';

/** Refunds and credit notes across SampCrew, and the paid invoices that can still be refunded. */
export function RefundsPanel({ notes, paid, canRefund }: { notes: CreditNoteView[]; paid: ConsoleInvoice[]; canRefund: boolean }) {
  const refunded = new Map<string, number>();
  for (const n of notes) if (n.invoiceId && n.status === 'issued') refunded.set(n.invoiceId, (refunded.get(n.invoiceId) ?? 0) + Number(n.amount));
  const open = paid.filter((i) => Number(i.total) > (refunded.get(i.id) ?? 0)).slice(0, 50);
  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader title="Credit notes" description="Every refund issues a numbered credit note. A gateway refund goes back through Razorpay or Stripe; a bank-transfer refund records your transfer reference." />
        <CreditNotesTable notes={notes} canRefund={canRefund} />
      </Card>
      {canRefund && (
        <Card>
          <CardHeader title="Refund a paid invoice" description="The latest paid invoices with an amount left to refund." />
          {!open.length ? <EmptyState title="No paid invoices to refund" /> : (
            <Table aria-label="Paid invoices">
              <THead><TR><TH>Invoice</TH><TH>Workspace</TH><TH>Paid</TH><TH className="text-right">Total</TH><TH className="text-right">Refunded</TH><TH /></TR></THead>
              <TBody>
                {open.map((i) => (
                  <TR key={i.id}>
                    <TD className="font-mono text-[12px]">{i.number}</TD>
                    <TD><Link href={`/tenants/${i.tenantId}/billing`} className="hover:underline">{i.tenant}</Link></TD>
                    <TD className="whitespace-nowrap text-fg-muted">{i.paidAt ? <LocalTime value={i.paidAt} dateOnly /> : '—'}</TD>
                    <TD className="text-right tabular">{fmtMoney(i.total, i.currency, 2)}</TD>
                    <TD className="text-right tabular">{refunded.get(i.id) ? fmtMoney(refunded.get(i.id)!, i.currency, 2) : '—'}</TD>
                    <TD className="text-right"><RefundButton invoice={{ ...i, refunded: String(refunded.get(i.id) ?? 0) }} /></TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}

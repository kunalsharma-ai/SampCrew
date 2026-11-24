import type { CreditNoteView } from '@crew/contracts';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { FileText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ConsoleInvoice } from '@/components/invoice-table';
import { LocalTime } from '@/components/local-time';
import { CreditNotesTable, RefundButton } from '@/components/refunds';
import { load } from '@/lib/api';
import { fmtMoney, fmtMoneyMap } from '@/lib/format';
import { ClientHeader } from '../client-header';
import { loadClient } from '../load-client';

export const metadata: Metadata = { title: 'Company billing' };

/** The company's subscriptions, invoices across its Super Workspaces, refunds and credit notes. */
export default async function ClientBillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await loadClient(id);
  if (!r) notFound();
  const { c, caps } = r;
  if (!caps.includes('billing:read')) return <><ClientHeader c={c} current="billing" caps={caps} /><Alert tone="warning">Your role cannot see billing.</Alert></>;
  const [invoices, notes] = await Promise.all([
    Promise.all(c.workspaces.map((w) => load<ConsoleInvoice[]>(`/platform/billing/invoices?tenantId=${w.id}`).catch(() => []))).then((x) => x.flat().sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''))),
    load<CreditNoteView[]>(`/platform/credit-notes?clientId=${id}`).catch(() => []),
  ]);
  const refunded = new Map<string, number>();
  for (const n of notes) if (n.invoiceId && n.status === 'issued') refunded.set(n.invoiceId, (refunded.get(n.invoiceId) ?? 0) + Number(n.amount));
  const canRefund = caps.includes('billing:refund');
  return (
    <>
      <ClientHeader c={c} current="billing" caps={caps} />
      <div className="grid gap-5">
        {c.money && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Card><CardBody><div className="text-[12px] text-fg-subtle">Monthly recurring</div><div className="text-[20px] font-semibold tabular">{fmtMoneyMap(c.money.mrr)}</div></CardBody></Card>
            <Card><CardBody><div className="text-[12px] text-fg-subtle">Paid to date</div><div className="text-[20px] font-semibold tabular">{fmtMoneyMap(c.money.revenue)}</div></CardBody></Card>
            <Card><CardBody><div className="text-[12px] text-fg-subtle">Outstanding</div><div className="text-[20px] font-semibold tabular">{fmtMoneyMap(c.money.outstanding, 'Nothing due')}</div></CardBody></Card>
          </div>
        )}
        <Card>
          <CardHeader title="Subscriptions" description="Change a plan, seats, add-ons or contract terms on each Super Workspace's billing page." />
          <Table aria-label="Subscriptions">
            <THead><TR><TH>Super Workspace</TH><TH>Plan</TH><TH>Status</TH><TH className="text-right">Seats</TH><TH>Cycle</TH><TH className="text-right">MRR</TH><TH>Renewal</TH><TH /></TR></THead>
            <TBody>
              {c.workspaces.map((w) => (
                <TR key={w.id}>
                  <TD className="font-medium">{w.name}</TD>
                  <TD>{w.plan?.name ?? '—'}</TD>
                  <TD><Badge tone={w.subscription?.status === 'active' ? 'success' : w.subscription?.status === 'past_due' ? 'warning' : 'neutral'}>{w.subscription?.status.replace('_', ' ') ?? 'none'}</Badge></TD>
                  <TD className="text-right tabular">{w.subscription?.seats ?? '—'}</TD>
                  <TD>{w.subscription?.billingCycle ?? '—'}</TD>
                  <TD className="text-right tabular">{w.subscription?.mrr ? fmtMoney(w.subscription.mrr, w.subscription.currency) : '—'}</TD>
                  <TD className="whitespace-nowrap text-fg-muted">{w.subscription ? (w.subscription.status === 'trialing' ? `Trial to ${w.subscription.trialEndsOn}` : w.subscription.cancelAtPeriodEnd ? `Ends ${w.subscription.currentPeriodEnd}` : w.subscription.currentPeriodEnd) : '—'}</TD>
                  <TD className="text-right"><Link href={`/tenants/${w.id}/billing`} className="text-[12.5px] text-accent hover:underline">Manage</Link></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Invoices" description={canRefund ? 'Paid invoices can be refunded in full or in part.' : undefined} />
          {!invoices.length ? <EmptyState icon={<FileText className="size-6" />} title="No invoices yet" /> : (
            <Table aria-label="Invoices">
              <THead><TR><TH>Invoice</TH><TH>Workspace</TH><TH>Status</TH><TH className="text-right">Total</TH><TH>Issued</TH><TH>Paid</TH><TH /></TR></THead>
              <TBody>
                {invoices.map((i) => (
                  <TR key={i.id} data-testid="client-invoice">
                    <TD className="font-mono text-[12px]">{i.number ?? 'Draft'}</TD>
                    <TD>{i.tenant}</TD>
                    <TD><Badge tone={i.status === 'paid' ? 'success' : i.overdue ? 'danger' : i.status === 'void' ? 'neutral' : 'warning'}>{i.overdue && i.status === 'open' ? 'overdue' : i.status}</Badge>{refunded.get(i.id) ? <span className="block text-[11px] text-fg-subtle">{fmtMoney(refunded.get(i.id)!, i.currency, 2)} refunded</span> : null}</TD>
                    <TD className="text-right tabular">{fmtMoney(i.total, i.currency, 2)}</TD>
                    <TD className="whitespace-nowrap text-fg-muted">{i.issuedAt ? <LocalTime value={i.issuedAt} dateOnly /> : '—'}</TD>
                    <TD className="whitespace-nowrap text-fg-muted">{i.paidAt ? <LocalTime value={i.paidAt} dateOnly /> : '—'}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {i.number && <a href={`/invoice-pdf/${i.id}`} className="mr-2 text-[12.5px] text-accent hover:underline">PDF</a>}
                      {canRefund && i.status === 'paid' && Number(i.total) > 0 && <RefundButton invoice={{ ...i, refunded: String(refunded.get(i.id) ?? 0) }} />}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Refunds and credit notes" />
          <CreditNotesTable notes={notes} canRefund={canRefund} showWorkspace={c.workspaces.length > 1} />
        </Card>
      </div>
    </>
  );
}

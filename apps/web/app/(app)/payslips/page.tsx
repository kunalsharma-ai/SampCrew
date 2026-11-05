import { Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { FileText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import { amount, monthLabel } from '../payroll/labels';
import type { PayslipRow } from '../payroll/types';

export const metadata: Metadata = { title: 'Payslips' };

export default async function PayslipsPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  const me = await load<Me>('/me');
  const broad = me.permissions['payslips:read'] && me.permissions['payslips:read'] !== 'own';
  const all = broad && view === 'all';
  const rows = await load<PayslipRow[]>(`/payslips${all ? '' : '?mine=true'}`);
  return (
    <>
      <PageHeader title="Payslips" description="Payslips from finalised payroll. Open one to see how every amount was worked out, or print it." />
      {broad && (
        <div className="mb-4 flex gap-2">
          {[{ v: '', l: 'Mine' }, { v: 'all', l: 'Everyone I can see' }].map((f) => (
            <Link key={f.v} href={f.v ? '/payslips?view=all' : '/payslips'} className={`rounded-full px-3 py-1 text-[13px] font-medium ${(all ? 'all' : '') === f.v ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg'}`}>{f.l}</Link>
          ))}
        </div>
      )}
      <Card>
        <CardHeader title={all ? 'All payslips' : 'Your payslips'} />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Month</TH>{all && <TH>Employee</TH>}<TH>Paid by</TH><TH>Pay date</TH><TH className="text-right">Gross</TH><TH className="text-right">Deductions</TH><TH className="text-right">Net pay</TH></tr></THead>
            <TBody>
              {rows.map((p) => (
                <TR key={p.id}>
                  <TD><Link className="font-medium text-accent hover:underline" href={`/payslips/${p.id}`}>{monthLabel(p.month)}</Link></TD>
                  {all && <TD>{p.name} <span className="font-mono text-xs text-fg-muted">{p.code}</span></TD>}
                  <TD>{p.legalEntityName}</TD>
                  <TD className="text-fg-muted">{p.payDate}</TD>
                  <TD className="text-right tabular-nums">{amount(p.gross, p.currency)}</TD>
                  <TD className="text-right tabular-nums">{amount(p.deductions, p.currency)}</TD>
                  <TD className="text-right font-medium tabular-nums">{amount(p.net, p.currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<FileText className="size-5" />} title="No payslips yet" description="Payslips appear here once a payroll run that includes you is finalised." />
        )}
      </Card>
    </>
  );
}

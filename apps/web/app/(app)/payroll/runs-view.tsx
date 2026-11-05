'use client';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { LegalEntity } from '@/lib/types';
import { createRunAction } from './actions';
import { amount, monthLabel, RUN_STATUS, RUN_TONE } from './labels';
import type { PayrollRun } from './types';

const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const monthEnd = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export function RunsView({ runs, entities, configured, canRun, canConfigure }: { runs: PayrollRun[]; entities: LegalEntity[]; configured: string[]; canRun: boolean; canConfigure: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const missing = entities.filter((e) => !configured.includes(e.id));
  const month = lastMonth();
  return (
    <div className="grid gap-6">
      {missing.length > 0 && (
        <Alert tone="warning" title="Statutory settings to review">
          {missing.map((e) => e.name).join(', ')} {missing.length === 1 ? 'has' : 'have'} no saved statutory settings, so payroll cannot be computed there yet.{' '}
          {canConfigure ? <Link className="font-medium underline" href="/settings/payroll">Review and save them</Link> : 'Ask a payroll administrator to review and save them.'}
        </Alert>
      )}
      <Card>
        <CardHeader
          title="Payroll runs"
          action={canRun && entities.length > 0 && <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> New payroll run</Button>}
        />
        {runs.length ? (
          <Table>
            <THead><tr><TH>Month</TH><TH>Legal entity</TH><TH>Status</TH><TH className="text-right">Employees</TH><TH className="text-right">Gross</TH><TH className="text-right">Net pay</TH><TH>Pay date</TH></tr></THead>
            <TBody>
              {runs.map((r) => (
                <TR key={r.id} className="cursor-pointer" onClick={() => router.push(`/payroll/runs/${r.id}`)}>
                  <TD><Link className="font-medium text-accent hover:underline" href={`/payroll/runs/${r.id}`}>{monthLabel(r.month)}</Link></TD>
                  <TD>{r.legalEntityName}</TD>
                  <TD><Badge tone={RUN_TONE[r.status] ?? 'neutral'} dot>{RUN_STATUS[r.status] ?? r.status}</Badge></TD>
                  <TD className="text-right tabular-nums">{r.status === 'draft' ? '–' : r.employeeCount}</TD>
                  <TD className="text-right tabular-nums">{r.status === 'draft' ? '–' : amount(r.gross, r.currency)}</TD>
                  <TD className="text-right tabular-nums font-medium">{r.status === 'draft' ? '–' : amount(r.net, r.currency)}</TD>
                  <TD className="text-fg-muted">{r.payDate}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<Wallet className="size-5" />} title="No payroll runs yet" description={canRun ? 'Assign salaries, review statutory settings, then start a run for a month.' : 'Payroll runs appear here once a payroll administrator starts one.'} />
        )}
      </Card>
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="New payroll run"
        description="One run covers one legal entity for one calendar month."
        submitLabel="Create run"
        initial={{ legalEntityId: entities[0]?.id, month, payDate: monthEnd(month) }}
        fields={[
          { name: 'legalEntityId', label: 'Legal entity', type: 'select', required: true, options: entities.map((e) => ({ value: e.id, label: e.name })) },
          { name: 'month', label: 'Month', required: true, placeholder: 'YYYY-MM', hint: 'For example 2026-09', half: true },
          { name: 'payDate', label: 'Pay date', type: 'date', required: true, half: true },
        ]}
        onSubmit={async (v) => {
          const r = await createRunAction(v);
          if (r.ok && r.data) router.push(`/payroll/runs/${(r.data as { id: string }).id}`);
          return r;
        }}
      />
    </div>
  );
}

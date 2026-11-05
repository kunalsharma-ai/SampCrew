import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { monthLabel } from '../../labels';
import type { PayrollRunDetail } from '../../types';
import { RunView } from './run-view';

export const metadata: Metadata = { title: 'Payroll run' };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await load<PayrollRunDetail>(`/payroll/runs/${id}`);
  const people = run.can.compute ? await loadOptional<{ id: string; code: string; name: string }[]>(`/payroll/runs/${id}/employees`) : null;
  return (
    <>
      <PageHeader
        eyebrow={run.legalEntityName}
        title={`Payroll for ${monthLabel(run.month)}`}
        description={`${run.periodStart} to ${run.periodEnd} · paid on ${run.payDate}${run.statutoryEffectiveFrom ? ` · statutory settings from ${run.statutoryEffectiveFrom}` : ''}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/payroll">All runs</Link>}
      />
      <RunView run={run} people={people ?? []} />
    </>
  );
}

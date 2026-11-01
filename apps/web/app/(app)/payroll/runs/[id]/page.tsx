import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { monthLabel } from '../../labels';
import type { PayrollRunDetail } from '../../types';
import type { PayrollChecks } from '../../../insights/types';
import { PayChecks } from './pay-checks';
import { RunStepper } from './run-stepper';
import { RunView } from './run-view';

export const metadata: Metadata = { title: 'Payroll run' };

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await load<PayrollRunDetail>(`/payroll/runs/${id}`);
  const computed = run.status !== 'draft' && run.status !== 'cancelled';
  const [people, checks] = await Promise.all([
    run.can.compute ? loadOptional<{ id: string; code: string; name: string }[]>(`/payroll/runs/${id}/employees`) : null,
    computed ? loadOptional<PayrollChecks>(`/insights/payroll-runs/${id}`) : null,
  ]);
  return (
    <>
      <PageHeader
        eyebrow={run.legalEntityName}
        title={`Payroll for ${monthLabel(run.month)}`}
        description={`${run.periodStart} to ${run.periodEnd} · paid on ${run.payDate}${run.statutoryEffectiveFrom ? ` · statutory settings from ${run.statutoryEffectiveFrom}` : ''}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/payroll">All runs</Link>}
      />
      <div className="grid gap-6">
        <RunStepper run={run} checks={checks} />
        {checks && <PayChecks runId={id} checks={checks} finalised={run.status === 'finalised'} />}
        <RunView run={run} people={people ?? []} />
      </div>
    </>
  );
}

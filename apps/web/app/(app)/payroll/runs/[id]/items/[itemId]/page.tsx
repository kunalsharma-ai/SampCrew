import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { monthLabel } from '../../../../labels';
import type { PayrollItemDetail, PayrollRunDetail } from '../../../../types';
import { ItemView } from './item-view';

export const metadata: Metadata = { title: 'Payslip calculation' };

export default async function ItemPage({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await params;
  const [run, item] = await Promise.all([load<PayrollRunDetail>(`/payroll/runs/${id}`), load<PayrollItemDetail>(`/payroll/runs/${id}/items/${itemId}`)]);
  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono">{item.code}</span>}
        title={item.name}
        description={`Pay for ${monthLabel(run.month)} · ${run.legalEntityName}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={`/payroll/runs/${id}`}>Back to the run</Link>}
      />
      <ItemView runId={id} currency={run.currency} item={item} editable={run.can.compute} />
    </>
  );
}

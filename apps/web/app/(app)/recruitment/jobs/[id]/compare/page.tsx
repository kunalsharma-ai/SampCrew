import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import type { Pipeline, RequisitionDetail } from '@/lib/types';
import { type Comparison, CompareView } from './compare-view';

export const metadata: Metadata = { title: 'Compare candidates' };

export default async function ComparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ applications?: string }> }) {
  const { id } = await params;
  const { applications } = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id) || !applications || !/^[0-9a-f-]{36}(,[0-9a-f-]{36}){1,3}$/.test(applications)) notFound();
  const [req, data, pipeline] = await Promise.all([
    load<RequisitionDetail>(`/recruitment/requisitions/${id}`),
    loadOptional<Comparison>(`/recruitment/requisitions/${id}/compare?applications=${applications}`),
    loadOptional<Pipeline>(`/recruitment/requisitions/${id}/pipeline`),
  ]);
  if (!data) notFound();
  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono">{req.code}</span>}
        title={`Compare candidates for ${req.title}`}
        description="Interview scores are averaged across submitted scorecards, from 1 (weak) to 4 (strong)."
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={`/recruitment/jobs/${id}`}>Back to the pipeline</Link>}
      />
      <CompareView data={data} stages={(pipeline?.stages ?? []).filter((s) => s.kind !== 'hired')} canMove={req.can.manageCandidates} path={`/recruitment/jobs/${id}/compare?applications=${applications}`} />
    </>
  );
}

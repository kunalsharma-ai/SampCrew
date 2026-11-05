import { Card, EmptyState, PageHeader, buttonClass } from '@crew/ui';
import { Columns3 } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, load, loadOptional } from '@/lib/api';
import type { Pipeline, RequisitionDetail } from '@/lib/types';
import { type Comparison, CompareView } from './compare-view';

export const metadata: Metadata = { title: 'Compare candidates' };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export default async function ComparePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ applications?: string }> }) {
  const { id } = await params;
  const { applications } = await searchParams;
  if (!new RegExp(`^${UUID}$`).test(id)) notFound();
  const req = await load<RequisitionDetail>(`/recruitment/requisitions/${id}`);
  const header = (
    <PageHeader
      eyebrow={<span className="font-mono">{req.code}</span>}
      title={`Compare candidates for ${req.title}`}
      description="Interview scores are averaged across submitted scorecards, from 1 (weak) to 4 (strong)."
      actions={<Link className="text-sm font-medium text-accent hover:underline" href={`/recruitment/jobs/${id}`}>Back to the pipeline</Link>}
    />
  );
  // Opened without a valid pick (a bookmark, a shared link, a hand-typed address): explain how to pick instead of
  // showing "page not found".
  const picked = applications && new RegExp(`^${UUID}(,${UUID}){1,3}$`).test(applications) ? applications : null;
  const [data, pipeline] = picked
    ? await Promise.all([
        // A pick that is not on this job is refused with 400 (not_in_job): shown as a bad pick, not an error page.
        loadOptional<Comparison>(`/recruitment/requisitions/${id}/compare?applications=${picked}`).catch((e) => {
          if (e instanceof ApiError && e.status === 400) return null;
          throw e;
        }),
        loadOptional<Pipeline>(`/recruitment/requisitions/${id}/pipeline`),
      ])
    : [null, null];
  if (!data) {
    return (
      <>
        {header}
        <Card data-testid="compare-pick">
          <EmptyState
            icon={<Columns3 className="size-5" />}
            title={picked ? 'These candidates cannot be compared' : 'Pick candidates to compare'}
            description={
              picked
                ? 'One or more of them is not on this job, or you cannot see their application. Pick them again on the pipeline.'
                : 'Tick two to four candidates on the job’s pipeline, then press Compare to see their scores side by side.'
            }
            action={<Link href={`/recruitment/jobs/${id}`} className={buttonClass('primary', 'sm')}>Open the pipeline</Link>}
          />
        </Card>
      </>
    );
  }
  return (
    <>
      {header}
      <CompareView data={data} stages={(pipeline?.stages ?? []).filter((s) => s.kind !== 'hired')} canMove={req.can.manageCandidates} path={`/recruitment/jobs/${id}/compare?applications=${picked}`} />
    </>
  );
}

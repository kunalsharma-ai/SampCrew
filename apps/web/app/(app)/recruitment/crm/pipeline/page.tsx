import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { CrmContext, CrmRow } from '../crm-types';
import { PipelineBoard, type PipelineStage } from './pipeline-board';

export const metadata: Metadata = { title: 'Recruitment Pipeline · Candidate CRM' };

export default async function CrmPipelinePage({ searchParams }: { searchParams: Promise<{ q?: string; recruiter?: string; layout?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  if (sp.q) qs.set('q', sp.q.slice(0, 120));
  if (sp.recruiter && /^(me|none|[0-9a-f-]{36})$/.test(sp.recruiter)) qs.set('recruiter', sp.recruiter);
  const [ctx, data] = await Promise.all([
    load<CrmContext>('/recruitment/crm/context'),
    load<{ total: number; stages: (PipelineStage & { candidates: CrmRow[] })[] }>(`/recruitment/crm/pipeline?${qs}`),
  ]);
  const layout = sp.layout === 'table' || sp.layout === 'list' ? sp.layout : 'board';
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/pipeline" title="Recruitment Pipeline" description={`${data.total} candidate${data.total === 1 ? '' : 's'} across the stages. Drag a card to another stage to move the candidate.`}>
      <PipelineBoard ctx={ctx} stages={data.stages} layout={layout} q={sp.q ?? ''} recruiter={qs.get('recruiter') ?? ''} />
    </CrmShell>
  );
}

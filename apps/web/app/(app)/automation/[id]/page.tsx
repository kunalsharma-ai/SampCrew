import { automation } from '@crew/contracts';
import { Badge, buttonClass, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { AiStatus } from '../../ai/types';
import { WorkflowEditor } from '../editor';
import { WORKFLOW_STATUS } from '../labels';
import type { Catalogue, RunRow, WorkflowDetail } from '../types';
import { WorkflowControls } from './workflow-controls';

export const metadata: Metadata = { title: 'Workflow' };

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [workflow, catalogue, runs, ai] = await Promise.all([
    load<WorkflowDetail>(`/automation/workflows/${id}`),
    load<Catalogue>('/automation/catalogue'),
    load<RunRow[]>(`/automation/runs?workflowId=${id}`),
    loadOptional<AiStatus>('/ai/status'),
  ]);
  const st = WORKFLOW_STATUS[workflow.status];
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/automation" className="hover:underline">Automation Studio</Link>}
        title={<span className="inline-flex flex-wrap items-center gap-3">{workflow.name}<Badge tone={st.tone} dot>{st.label}</Badge></span>}
        description={`${automation.TRIGGERS[workflow.trigger]?.label ?? workflow.trigger}. Runs as ${workflow.ownerName}.`}
        actions={<Link className={buttonClass('secondary')} href={`/automation/runs?workflowId=${id}`}>Runs</Link>}
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <WorkflowEditor key={workflow.latest.id} catalogue={catalogue} workflow={workflow} aiDraft={ai?.configured ? ai.features.workflow_draft : null} />
        <WorkflowControls workflow={workflow} catalogue={catalogue} recentRuns={runs.slice(0, 8)} />
      </div>
    </>
  );
}

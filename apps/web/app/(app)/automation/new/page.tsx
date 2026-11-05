import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { AiStatus } from '../../ai/types';
import { WorkflowEditor } from '../editor';
import type { Catalogue } from '../types';

export const metadata: Metadata = { title: 'New workflow' };

export default async function NewWorkflowPage() {
  const [catalogue, ai] = await Promise.all([load<Catalogue>('/automation/catalogue'), loadOptional<AiStatus>('/ai/status')]);
  return (
    <>
      <PageHeader eyebrow="Automation Studio" title="New workflow" description="Choose what starts it and add its steps. It is saved inactive; test it, then activate it." />
      <WorkflowEditor catalogue={catalogue} aiDraft={ai?.configured ? ai.features.workflow_draft : null} />
    </>
  );
}

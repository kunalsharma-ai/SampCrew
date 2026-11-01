'use server';
import type { WorkflowDefinition } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { RunDetail, TestResult, WorkflowDetail, WorkflowDraft } from './types';

interface SaveBody { name: string; description: string; definition: WorkflowDefinition; aiInteractionId?: string }

export async function createWorkflowAction(body: SaveBody) {
  const r = await act(() => api<WorkflowDetail>('/automation/workflows', { method: 'POST', body }), 'Workflow saved as version 1. Test it before activating.');
  revalidatePath('/automation');
  return r;
}

export async function saveWorkflowAction(id: string, body: SaveBody) {
  const r = await act(() => api<WorkflowDetail>(`/automation/workflows/${id}`, { method: 'PUT', body }), 'New version saved. Test it before activating.');
  revalidatePath(`/automation/${id}`);
  return r;
}

export async function testWorkflowAction(id: string, body: { sample: Record<string, string | number | boolean | null>; approvals: 'approve' | 'reject' }) {
  const r = await act(() => api<TestResult>(`/automation/workflows/${id}/test`, { method: 'POST', body }));
  revalidatePath(`/automation/${id}`);
  return r;
}

export async function workflowStatusAction(id: string, action: 'activate' | 'pause' | 'archive') {
  const msg = { activate: 'Workflow active. It now runs with your permissions.', pause: 'Workflow paused.', archive: 'Workflow archived.' }[action];
  const r = await act(() => api<WorkflowDetail>(`/automation/workflows/${id}/${action}`, { method: 'POST' }), msg);
  revalidatePath('/automation');
  revalidatePath(`/automation/${id}`);
  return r;
}

export async function draftWorkflowAction(description: string) {
  return act(() => api<WorkflowDraft>('/automation/drafts', { method: 'POST', body: { description } }));
}

export async function runAction(id: string, action: 'retry' | 'cancel') {
  const r = await act(() => api<RunDetail>(`/automation/runs/${id}/${action}`, { method: 'POST' }), action === 'retry' ? 'Retrying from the step that failed.' : 'Run cancelled.');
  revalidatePath(`/automation/runs/${id}`);
  revalidatePath('/automation/runs');
  return r;
}

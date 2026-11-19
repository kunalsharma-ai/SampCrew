'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { AppraisalCycle, AppraisalDetail, AppraisalForm } from '@/lib/types';

const refresh = (id?: string) => {
  revalidatePath('/appraisal');
  revalidatePath('/settings/appraisals');
  if (id) revalidatePath(`/appraisal/${id}`);
};

export async function saveAppraisalAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api<AppraisalDetail>(`/appraisals/${id}/answers`, { method: 'PUT', body }), 'Draft saved.');
  refresh(id);
  return r;
}

export async function submitAppraisalAction(id: string, body: Record<string, unknown>) {
  const saved = await act(() => api<AppraisalDetail>(`/appraisals/${id}/answers`, { method: 'PUT', body }));
  if (!saved.ok) return saved;
  const r = await act(() => api<AppraisalDetail>(`/appraisals/${id}/submit`, { method: 'POST' }));
  if (r.ok) r.message = r.data?.stage === 'finalized' ? 'Appraisal finalised. Publish it to share the result with the employee.' : 'Submitted. It is locked now and has moved to the next stage.';
  refresh(id);
  return r;
}

export async function publishAppraisalAction(id: string) {
  const r = await act(() => api<AppraisalDetail>(`/appraisals/${id}/publish`, { method: 'POST' }), 'Published. The employee has been told.');
  refresh(id);
  return r;
}

export async function reopenAppraisalAction(id: string, stage: string, reason: string) {
  const r = await act(() => api<AppraisalDetail>(`/appraisals/${id}/reopen`, { method: 'POST', body: { stage, reason } }), 'Reopened. The person has been told.');
  refresh(id);
  return r;
}

export async function addTemplateAction(key: string) {
  const r = await act(() => api<AppraisalForm>('/appraisals/forms/from-template', { method: 'POST', body: { key } }), 'Template added as a form. You can change it now.');
  refresh();
  return r;
}

export async function saveFormAction(id: string | null, body: Record<string, unknown>) {
  const r = await act(() => (id ? api<AppraisalForm>(`/appraisals/forms/${id}`, { method: 'PUT', body }) : api<AppraisalForm>('/appraisals/forms', { method: 'POST', body })), 'Form saved.');
  refresh();
  if (id) revalidatePath(`/settings/appraisals/forms/${id}`);
  return r;
}

export async function duplicateFormAction(id: string) {
  const r = await act(() => api<AppraisalForm>(`/appraisals/forms/${id}/duplicate`, { method: 'POST' }), 'Form copied.');
  refresh();
  return r;
}

export async function archiveFormAction(id: string) {
  const r = await act(() => api(`/appraisals/forms/${id}`, { method: 'DELETE' }), 'Form removed.');
  refresh();
  return r;
}

export async function saveCycleAction(id: string | null, body: Record<string, unknown>) {
  const r = await act(() => (id ? api<AppraisalCycle>(`/appraisals/cycles/${id}`, { method: 'PUT', body }) : api<AppraisalCycle>('/appraisals/cycles', { method: 'POST', body })), 'Cycle saved.');
  refresh();
  return r;
}

export async function cycleCommandAction(id: string, command: 'launch' | 'publish' | 'close') {
  const r = await act(() => api<{ created?: number; skipped?: { noLogin: number; noForm: number }; published?: number }>(`/appraisals/cycles/${id}/${command}`, { method: 'POST' }));
  if (r.ok) {
    const d = r.data!;
    r.message = command === 'launch'
      ? `Launched: ${d.created} appraisals created.${d.skipped?.noLogin ? ` ${d.skipped.noLogin} people without a login were left out.` : ''}${d.skipped?.noForm ? ` ${d.skipped.noForm} people had no matching form.` : ''}`
      : command === 'publish' ? `${d.published} appraisals published.` : 'Cycle closed.';
  }
  refresh();
  revalidatePath(`/settings/appraisals/cycles/${id}`);
  return r;
}

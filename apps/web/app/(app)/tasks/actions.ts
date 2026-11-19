'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';
import type { WorkTask, WorkTaskDetail } from '@/lib/types';

const refresh = (id?: string) => {
  revalidatePath('/tasks');
  revalidatePath('/');
  revalidatePath('/approvals');
  if (id) revalidatePath(`/tasks/${id}`);
};

export async function assignTaskAction(body: Record<string, unknown>) {
  const r = await act(() => api<WorkTask[]>('/tasks', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  if (r.ok) r.message = r.data && r.data.length > 1 ? `Task assigned to ${r.data.length} people. They have been notified.` : 'Task assigned. They have been notified.';
  refresh();
  return r;
}

export async function seenTaskAction(id: string) {
  await act(() => api(`/tasks/${id}/seen`, { method: 'POST' }));
  revalidatePath('/tasks');
}

export async function taskProgressAction(id: string, status: string, remarks?: string) {
  const msg: Record<string, string> = { in_progress: 'Marked as in progress.', not_started: 'Marked as not started.', pending_review: 'Sent for review.', completed: 'Done. The person who assigned it has been told.' };
  const r = await act(() => api<WorkTask>(`/tasks/${id}/progress`, { method: 'POST', body: { status, ...(remarks ? { remarks } : {}) } }), msg[status]);
  refresh(id);
  return r;
}

export async function taskReviewAction(id: string, action: 'complete' | 'reopen' | 'cancel', remarks?: string) {
  const msg = { complete: 'Task accepted.', reopen: 'Task reopened. The employee has been told why.', cancel: 'Task cancelled.' };
  const r = await act(() => api<WorkTask>(`/tasks/${id}/review`, { method: 'POST', body: { action, ...(remarks ? { remarks } : {}) } }), msg[action]);
  refresh(id);
  return r;
}

export async function uploadTaskDocumentAction(id: string, form: FormData) {
  const r = await act(() => apiForm<WorkTask>(`/tasks/${id}/document`, form), 'Uploaded. HR will verify it and you will be told the result.');
  refresh(id);
  return r;
}

export async function verifyTaskDocumentAction(id: string, decision: 'verify' | 'reject', remarks?: string) {
  const r = await act(() => api<WorkTaskDetail>(`/tasks/${id}/verify`, { method: 'POST', body: { decision, ...(remarks ? { remarks } : {}) } }), decision === 'verify' ? 'Document verified. The task is complete.' : 'Document rejected. The employee can upload it again.');
  refresh(id);
  return r;
}

'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

const refresh = (id?: string) => {
  revalidatePath('/employees');
  if (id) revalidatePath(`/employees/${id}`);
};

export async function hireAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ employee: { id: string }; inviteUrl?: string }>('/employees', { method: 'POST', body: values, idempotencyKey: crypto.randomUUID() }));
  refresh();
  return r;
}

export async function updateEmployeeAction(id: string, values: Record<string, unknown>) {
  const r = await act(() => api(`/employees/${id}`, { method: 'PATCH', body: values }), 'Profile saved');
  refresh(id);
  return r;
}

export async function sensitiveAction(id: string) {
  return act(() => api<Record<string, string | null>>(`/employees/${id}/sensitive`));
}

export async function saveSensitiveAction(id: string, values: Record<string, unknown>) {
  return act(() => api(`/employees/${id}/sensitive`, { method: 'PUT', body: values }), 'Saved securely');
}

export async function jobChangeAction(id: string, values: Record<string, unknown>) {
  const r = await act(() => api(`/employees/${id}/job-changes`, { method: 'POST', body: values }), 'Job change recorded');
  refresh(id);
  return r;
}

export async function lifecycleAction(id: string, action: 'confirm' | 'extend-probation' | 'exit' | 'withdraw-exit', values: Record<string, unknown> = {}) {
  const r = await act(() => api(`/employees/${id}/${action}`, { method: 'POST', body: values }), 'Done');
  refresh(id);
  return r;
}

export async function uploadDocumentAction(id: string, form: FormData) {
  const r = await act(() => apiForm(`/employees/${id}/documents`, form), 'Uploaded');
  refresh(id);
  return r;
}

export async function archiveDocumentAction(employeeId: string, documentId: string) {
  const r = await act(() => api(`/documents/${documentId}`, { method: 'DELETE' }), 'Archived');
  refresh(employeeId);
  return r;
}

export async function taskStatusAction(taskId: string, status: 'open' | 'done' | 'skipped') {
  const r = await act(() => api(`/onboarding/tasks/${taskId}`, { method: 'PATCH', body: { status } }));
  revalidatePath('/tasks');
  revalidatePath('/employees', 'layout');
  return r;
}

export async function linkLoginAction(id: string, membershipId: string) {
  const r = await act(() => api(`/employees/${id}/link-login`, { method: 'POST', body: { membershipId } }), 'Login linked');
  refresh(id);
  return r;
}

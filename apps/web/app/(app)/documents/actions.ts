'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { RequestRow } from './types';

const refresh = (id?: string) => {
  revalidatePath('/documents');
  revalidatePath('/tasks');
  revalidatePath('/approvals');
  if (id) revalidatePath(`/documents/requests/${id}`);
};

export async function requestDocumentAction(body: Record<string, unknown>) {
  const r = await act(() => api<RequestRow[]>('/document-requests', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  if (r.ok) r.message = r.data && r.data.length > 1 ? `Requested from ${r.data.length} people. Each has a task and a notification.` : 'Requested. They have a task and a notification.';
  refresh();
  revalidatePath('/employees');
  revalidatePath('/hr-workspaces');
  return r;
}

export async function openedRequestAction(id: string) {
  await act(() => api(`/document-requests/${id}/opened`, { method: 'POST' }));
}

export async function startReviewAction(id: string) {
  const r = await act(() => api<{ status: string }>(`/document-requests/${id}/review`, { method: 'POST' }));
  return r;
}

export async function decideDocumentAction(id: string, decision: 'approve' | 'reject' | 'correction', comment?: string, expiresOn?: string) {
  const msg = { approve: 'Approved. The document is now in the profile and the request is complete.', reject: 'Rejected. They have been told the reason and can upload again.', correction: 'Sent back for correction with your instructions.' };
  const r = await act(() => api(`/document-requests/${id}/decision`, { method: 'POST', body: { decision, ...(comment ? { comment } : {}), ...(expiresOn ? { expiresOn } : {}) } }), msg[decision]);
  refresh(id);
  return r;
}

export async function cancelRequestAction(id: string, reason: string) {
  const r = await act(() => api(`/document-requests/${id}/cancel`, { method: 'POST', body: { reason } }), 'Request cancelled. They have been told.');
  refresh(id);
  return r;
}

export async function saveAccessAction(scope: string, body: Record<string, unknown>) {
  const r = await act(() => api(`/documents/access/${scope}`, { method: 'PUT', body }), 'Saved. The change applies straight away and the HR Workspace has been told.');
  revalidatePath('/settings/document-access');
  return r;
}

export async function addCategoryAction(body: Record<string, unknown>) {
  const r = await act(() => api('/documents/catalogue/categories', { method: 'POST', body }), 'Category added.');
  revalidatePath('/documents');
  return r;
}

export async function addTypeAction(body: Record<string, unknown>) {
  const r = await act(() => api('/documents/catalogue/types', { method: 'POST', body }), 'Document type added.');
  revalidatePath('/documents');
  return r;
}

export async function refreshDocumentsAction() {
  refresh();
}

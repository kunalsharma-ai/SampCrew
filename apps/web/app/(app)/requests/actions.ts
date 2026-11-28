'use server';
import type { RequestPerson, RequestView } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';
import type { RequestSettingsView, UploadedDoc } from './types';

const refresh = (id?: string) => {
  revalidatePath('/requests');
  revalidatePath('/requests/mine');
  revalidatePath('/requests/approvals');
  revalidatePath('/approvals');
  revalidatePath('/leave');
  revalidatePath('/my-day');
  if (id) revalidatePath(`/requests/${id}`);
};

export async function createRequestAction(body: Record<string, unknown>) {
  const r = await act(() => api<RequestView>('/requests', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Request submitted.');
  refresh();
  return r;
}

export async function applyLeaveAction(body: Record<string, unknown>) {
  const r = await act(() => api<RequestView>('/requests/leave', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Leave application submitted.');
  refresh();
  return r;
}

export async function decideRequestAction(id: string, decision: 'approve' | 'reject' | 'changes', comment?: string) {
  const words = { approve: 'Approved.', reject: 'Rejected. The requester can read your reason.', changes: 'Sent back for changes.' } as const;
  const r = await act(() => api<RequestView>(`/requests/${id}/decision`, { method: 'POST', body: { decision, ...(comment?.trim() ? { comment: comment.trim() } : {}) } }), words[decision]);
  refresh(id);
  return r;
}

export async function commentRequestAction(id: string, body: string) {
  const r = await act(() => api<RequestView>(`/requests/${id}/comments`, { method: 'POST', body: { body } }), 'Comment added.');
  refresh(id);
  return r;
}

export async function resubmitRequestAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api<RequestView>(`/requests/${id}/resubmit`, { method: 'POST', body }), 'Corrected and sent again.');
  refresh(id);
  return r;
}

export async function cancelRequestAction(id: string, reason?: string) {
  const r = await act(() => api<RequestView>(`/requests/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} }), 'Request cancelled.');
  refresh(id);
  return r;
}

export async function cancelApprovedLeaveAction(id: string, reason: string) {
  const r = await act(() => api<{ request: RequestView; cancellation: RequestView | null }>(`/requests/${id}/cancel-leave`, { method: 'POST', body: { reason } }));
  refresh(id);
  return r;
}

export async function searchPeopleAction(q: string) {
  return act(() => api<{ items: RequestPerson[] }>(`/requests/people?q=${encodeURIComponent(q)}`));
}

export async function uploadRequestFileAction(form: FormData) {
  return act(() => apiForm<UploadedDoc>('/requests/files', form));
}

export async function previewLeaveDaysAction(values: Record<string, unknown>) {
  return act(() => api<{ days: string; tracked: boolean; available: string | null; balanceAfter: string | null; warnings: string[] }>('/leave/requests/preview', { method: 'POST', body: values }));
}

export async function saveRequestSettingsAction(body: Record<string, unknown>) {
  const r = await act(() => api<RequestSettingsView>('/requests/settings', { method: 'PUT', body }), 'Request settings saved.');
  revalidatePath('/settings/requests');
  refresh();
  return r;
}

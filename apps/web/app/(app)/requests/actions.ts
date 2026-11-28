'use server';
import type { RequestPerson, RequestView } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function createRequestAction(body: Record<string, unknown>) {
  const r = await act(() => api<RequestView>('/requests', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Request sent.');
  revalidatePath('/requests');
  revalidatePath('/approvals');
  return r;
}

export async function cancelRequestAction(id: string, reason?: string) {
  const r = await act(() => api<RequestView>(`/requests/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} }), 'Request cancelled.');
  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
  return r;
}

export async function searchPeopleAction(q: string) {
  return act(() => api<{ items: RequestPerson[] }>(`/requests/people?q=${encodeURIComponent(q)}`));
}

export async function applyLeaveFromRequestAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api<{ leaveRequest: { id: string; approvalId: string | null; days: string; reference: string }; request: RequestView }>(`/requests/${id}/leave`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Leave application sent.');
  revalidatePath('/requests');
  revalidatePath(`/requests/${id}`);
  revalidatePath('/leave');
  return r;
}

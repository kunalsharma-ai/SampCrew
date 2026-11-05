'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export interface Preview { days: string; tracked: boolean; available: string | null; balanceAfter: string | null; holidaysInRange: string[]; warnings: string[] }

export async function previewLeaveAction(values: Record<string, unknown>) {
  return act(() => api<Preview>('/leave/requests/preview', { method: 'POST', body: values }));
}

export async function requestLeaveAction(values: Record<string, unknown>) {
  const r = await act(() => api('/leave/requests', { method: 'POST', body: values, idempotencyKey: crypto.randomUUID() }), 'Leave requested. Your approver has been notified.');
  revalidatePath('/leave');
  return r;
}

export async function cancelLeaveAction(id: string, reason?: string) {
  const r = await act(() => api(`/leave/requests/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} }), 'Cancelled');
  revalidatePath('/leave');
  revalidatePath('/approvals');
  return r;
}

export async function decideAction(id: string, decision: 'approve' | 'reject', comment?: string) {
  const r = await act(() => api<{ status: string }>(`/approvals/${id}/${decision}`, { method: 'POST', body: comment ? { comment } : {} }));
  revalidatePath('/approvals');
  return r;
}

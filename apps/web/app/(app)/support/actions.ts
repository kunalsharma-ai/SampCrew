'use server';
import type { SupportMessageView } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function startSupportAction(body: { subject: string; category: string; body: string; clientId: string }) {
  const r = await act(() => api<{ id: string; created: boolean }>('/support/conversations', { method: 'POST', body }));
  revalidatePath('/support');
  return r;
}

export async function sendSupportAction(id: string, body: string, clientId: string) {
  return act(() => api<SupportMessageView>(`/support/conversations/${id}/messages`, { method: 'POST', body: { body, clientId } }));
}

export async function readSupportAction(id: string) {
  return act(() => api(`/support/conversations/${id}/read`, { method: 'POST' }));
}

export async function supportStatusAction(id: string, status: 'open' | 'resolved') {
  const r = await act(() => api(`/support/conversations/${id}/status`, { method: 'PUT', body: { status } }), status === 'resolved' ? 'Marked resolved.' : 'Reopened.');
  revalidatePath(`/support/${id}`);
  return r;
}

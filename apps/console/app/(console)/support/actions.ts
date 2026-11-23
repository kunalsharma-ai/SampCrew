'use server';
import type { SupportMessageView } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function replySupportAction(id: string, body: string, clientId: string) {
  return act(() => api<SupportMessageView>(`/platform/support/conversations/${id}/messages`, { method: 'POST', body: { body, clientId } }));
}

export async function readSupportAction(id: string, read: boolean) {
  const r = await act(() => api(`/platform/support/conversations/${id}/read`, { method: 'POST', body: { read } }), read ? undefined : 'Marked unread for the Console Admin team.');
  revalidatePath('/support');
  return r;
}

export async function supportStatusAction(id: string, status: 'open' | 'resolved') {
  const r = await act(() => api(`/platform/support/conversations/${id}/status`, { method: 'PUT', body: { status } }), status === 'resolved' ? 'Marked resolved.' : 'Reopened.');
  revalidatePath(`/support/${id}`);
  return r;
}

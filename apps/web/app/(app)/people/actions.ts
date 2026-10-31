'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function inviteAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ inviteUrl?: string }>('/members/invite', { method: 'POST', body: values, idempotencyKey: crypto.randomUUID() }));
  revalidatePath('/people');
  return r;
}

export async function updateMemberAction(id: string, values: Record<string, unknown>) {
  const r = await act(() => api(`/members/${id}`, { method: 'PATCH', body: values }), 'Saved');
  revalidatePath('/people');
  return r;
}

export async function setRolesAction(id: string, assignments: { roleKey: string; constraints?: Record<string, string[]> }[]) {
  const r = await act(() => api(`/members/${id}/roles`, { method: 'PUT', body: { assignments } }), 'Roles updated');
  revalidatePath('/people');
  return r;
}

export async function resendInviteAction(id: string) {
  return act(() => api<{ inviteUrl?: string }>(`/members/${id}/resend-invite`, { method: 'POST' }));
}

'use server';
import { act, api } from '@/lib/api';

/** Checks the person's own password for the delete they are about to run (one delete, within two minutes). */
export async function confirmDeleteAction(password: string) {
  return act(() => api<{ confirmedUntil: string }>('/me/delete-confirmation', { method: 'POST', body: { password } }));
}

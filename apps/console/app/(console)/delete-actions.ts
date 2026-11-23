'use server';
import { act, api } from '@/lib/api';

/** Checks the Console admin's own password for the delete they are about to run (one delete, within two minutes). */
export async function confirmDeleteAction(password: string) {
  return act(() => api<{ confirmedUntil: string }>('/platform/auth/delete-confirmation', { method: 'POST', body: { password } }));
}

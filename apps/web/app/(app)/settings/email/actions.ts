'use server';
import type { TenantMailView } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function saveMailAction(body: Record<string, unknown>) {
  const r = await act(() => api<TenantMailView>('/settings/mail', { method: 'PUT', body }), 'Email setup saved.');
  revalidatePath('/settings/email');
  return r;
}

export async function testMailAction(sendTo: string) {
  const r = await act(() => api<{ ok: boolean; message: string; view: TenantMailView }>('/settings/mail/test', { method: 'POST', body: { sendTo } }));
  revalidatePath('/settings/email');
  return r;
}

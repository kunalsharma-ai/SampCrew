'use server';
import type { MasterValue, MasterValueInput } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function addMasterValueAction(list: string, body: MasterValueInput) {
  const r = await act(() => api<MasterValue>(`/master-data/${list}`, { method: 'POST', body }), 'Added');
  revalidatePath('/settings/master-data');
  return r;
}

export async function updateMasterValueAction(list: string, id: string, body: Partial<MasterValueInput> & { disabled?: boolean }) {
  const r = await act(() => api<MasterValue>(`/master-data/${list}/${id}`, { method: 'PATCH', body }), body.disabled === true ? 'Disabled: it is no longer offered, and records that hold it keep it' : body.disabled === false ? 'Enabled again' : 'Saved');
  revalidatePath('/settings/master-data');
  return r;
}

export async function masterLibraryAction(list: string) {
  return act(() => api<{ label: string; category: string; code?: string; level?: number; present: boolean }[]>(`/master-data/${list}/library`));
}

export async function addFromLibraryAction(list: string, labels: string[]) {
  const r = await act(() => api<{ added: number; skipped: number }>(`/master-data/${list}/library`, { method: 'POST', body: { labels } }));
  revalidatePath('/settings/master-data');
  return r;
}

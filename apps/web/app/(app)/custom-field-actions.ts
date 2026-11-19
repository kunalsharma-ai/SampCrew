'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';
import type { FieldValue } from '@/components/custom-fields-card';

export async function loadFieldValuesAction(entity: string, recordId: string) {
  return act(() => api<FieldValue[]>(`/custom-fields/values/${entity}/${recordId}`));
}

export async function saveFieldValuesAction(entity: string, recordId: string, values: Record<string, unknown>, path?: string) {
  const r = await act(() => api<FieldValue[]>(`/custom-fields/values/${entity}/${recordId}`, { method: 'PUT', body: { values } }), 'Saved.');
  if (path) revalidatePath(path);
  return r;
}

export async function uploadFieldFileAction(entity: string, recordId: string, form: FormData) {
  return act(() => apiForm<{ fileId: string; fileName: string }>(`/custom-fields/values/${entity}/${recordId}/files`, form));
}

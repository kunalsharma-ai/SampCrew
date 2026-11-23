'use server';
import type { ImportJobView, ImportMappingInput, ImportRowView } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

export async function uploadImportAction(form: FormData, type: string, list: string | null) {
  const qs = new URLSearchParams({ type });
  if (list) qs.set('list', list);
  return act(() => apiForm<ImportJobView>(`/imports?${qs}`, form));
}

export async function saveMappingAction(id: string, body: ImportMappingInput) {
  const r = await act(() => api<ImportJobView>(`/imports/${id}/mapping`, { method: 'PUT', body }));
  revalidatePath(`/imports/${id}`);
  return r;
}

export async function validateImportAction(id: string) {
  return act(() => api<ImportJobView>(`/imports/${id}/validate`, { method: 'POST' }));
}

export async function importRowsAction(id: string, status: string, page: number) {
  return act(() => api<{ total: number; page: number; pageSize: number; rows: ImportRowView[] }>(`/imports/${id}/rows?status=${encodeURIComponent(status)}&page=${page}&pageSize=50`));
}

export async function decideRowsAction(id: string, decisions: { row: number; decision: 'skip' | 'update' | 'create' }[]) {
  return act(() => api<ImportJobView>(`/imports/${id}/decisions`, { method: 'PUT', body: { decisions } }));
}

export async function runImportAction(id: string) {
  const r = await act(() => api<ImportJobView>(`/imports/${id}/run`, { method: 'POST' }));
  revalidatePath('/imports');
  return r;
}

export async function cancelImportAction(id: string) {
  const r = await act(() => api<ImportJobView>(`/imports/${id}/cancel`, { method: 'POST' }), 'Cancelled. Rows already imported are kept.');
  revalidatePath('/imports');
  return r;
}

export async function importJobAction(id: string) {
  return act(() => api<ImportJobView>(`/imports/${id}`));
}

export async function guessColumnAction(id: string, column: number) {
  return act(() => api<{ column: number; header: string; type: string; options: string[] }>(`/imports/${id}/columns/${column}/guess`));
}

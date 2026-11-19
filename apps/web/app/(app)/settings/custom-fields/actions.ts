'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const refresh = () => revalidatePath('/settings/custom-fields');

export async function saveFieldAction(id: string | null, body: Record<string, unknown>) {
  const r = await act(() => api<{ valuesNotMatchingType?: number }>(id ? `/custom-fields/${id}` : '/custom-fields', { method: id ? 'PATCH' : 'POST', body }), id ? 'Field saved. Existing values are kept.' : 'Field added.');
  refresh();
  return r;
}

export async function archiveFieldAction(id: string, archived: boolean) {
  const r = await act(() => api(`/custom-fields/${id}/archive`, { method: 'POST', body: { archived } }), archived ? 'Field archived. Its values are kept and hidden.' : 'Field restored.');
  refresh();
  return r;
}

export async function deleteFieldAction(id: string) {
  const r = await act(() => api(`/custom-fields/${id}`, { method: 'DELETE' }), 'Field deleted.');
  refresh();
  return r;
}

export async function reorderFieldsAction(entity: string, ids: string[]) {
  const r = await act(() => api('/custom-fields/order', { method: 'PUT', body: { entity, ids } }), 'Order saved.');
  refresh();
  return r;
}

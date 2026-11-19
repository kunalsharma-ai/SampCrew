'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

type Body = Record<string, unknown>;
const refresh = (id?: string) => {
  revalidatePath('/assets');
  revalidatePath('/assets/mine');
  if (id) revalidatePath(`/assets/${id}`);
};

export async function createAssetAction(body: Body) {
  const r = await act(() => api<{ id: string; assetCode: string }>('/assets', { method: 'POST', body }), 'Asset registered.');
  refresh();
  return r;
}

export async function updateAssetAction(id: string, body: Body) {
  const r = await act(() => api(`/assets/${id}`, { method: 'PATCH', body }), 'Saved.');
  refresh(id);
  return r;
}

export async function deleteAssetAction(id: string) {
  const r = await act(() => api(`/assets/${id}`, { method: 'DELETE' }), 'Asset deleted.');
  refresh();
  return r;
}

export async function assignAssetAction(id: string, body: Body) {
  const r = await act(() => api(`/assets/${id}/assign`, { method: 'POST', body }), 'Assigned. The employee has been asked to acknowledge it.');
  refresh(id);
  return r;
}

export async function returnAssetAction(id: string, body: Body) {
  const r = await act(() => api(`/assets/${id}/return`, { method: 'POST', body }), 'Return recorded.');
  refresh(id);
  return r;
}

export async function setStatusAction(id: string, body: Body) {
  const r = await act(() => api(`/assets/${id}/status`, { method: 'POST', body }), 'Status changed.');
  refresh(id);
  return r;
}

export async function uploadAssetFileAction(id: string, form: FormData) {
  const r = await act(() => apiForm(`/assets/${id}/files`, form), 'File attached.');
  refresh(id);
  return r;
}

export async function removeAssetFileAction(id: string, fileId: string) {
  const r = await act(() => api(`/assets/files/${fileId}`, { method: 'DELETE' }), 'File removed from the asset.');
  refresh(id);
  return r;
}

export async function acknowledgeAction(assignmentId: string, body: Body) {
  const r = await act(() => api(`/assets/assignments/${assignmentId}/acknowledge`, { method: 'POST', body }), 'Thank you. Your acknowledgement is recorded.');
  refresh();
  return r;
}

export async function saveCategoryAction(id: string | null, body: Body) {
  const r = await act(() => api(id ? `/assets/categories/${id}` : '/assets/categories', { method: id ? 'PATCH' : 'POST', body }), id ? 'Category saved.' : 'Category added.');
  revalidatePath('/assets/categories');
  revalidatePath('/assets');
  return r;
}

export async function searchEmployeesAction(q: string) {
  return act(async () => {
    const r = await api<{ items: { id: string; displayName: string; employeeCode: string; departmentName: string | null }[] }>(`/employees?limit=8&q=${encodeURIComponent(q)}`);
    return r.items.map((e) => ({ id: e.id, name: `${e.displayName} (${e.employeeCode})`, departmentName: e.departmentName }));
  });
}

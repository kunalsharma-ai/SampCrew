'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

const BASE = '/recruitment/crm';
const refresh = (id?: string) => {
  revalidatePath(BASE, 'layout');
  if (id) revalidatePath(`${BASE}/candidates/${id}`);
};

// Candidates -------------------------------------------------------------------------------------------------

export async function createCandidateAction(body: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; candidateCode: string }>(`${BASE}/candidates`, { method: 'POST', body }), 'Candidate added.');
  refresh();
  return r.ok ? { ...r, message: `Candidate added as ${r.data!.candidateCode}.` } : r;
}

export async function updateCandidateAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; changed: string[] }>(`${BASE}/candidates/${id}`, { method: 'PATCH', body }), 'Candidate updated.');
  refresh(id);
  return r;
}

export async function stageAction(id: string, stage: string, note?: string) {
  const r = await act(() => api(`${BASE}/candidates/${id}/stage`, { method: 'POST', body: { stage, note: note || undefined } }), 'Stage changed.');
  refresh(id);
  return r;
}

export async function assignAction(id: string, membershipId: string | null) {
  const r = await act(() => api(`${BASE}/candidates/${id}/assign`, { method: 'POST', body: { membershipId } }), membershipId ? 'Recruiter assigned.' : 'Recruiter removed.');
  refresh(id);
  return r;
}

export async function shareAction(id: string, hrWorkspaceIds: string[]) {
  const r = await act(() => api(`${BASE}/candidates/${id}/share`, { method: 'PUT', body: { hrWorkspaceIds } }), 'Sharing saved.');
  refresh(id);
  return r;
}

export async function archiveAction(id: string, archived: boolean) {
  const r = await act(() => api(`${BASE}/candidates/${id}/archive`, { method: 'POST', body: { archived } }), archived ? 'Candidate archived.' : 'Candidate restored.');
  refresh(id);
  return r;
}

export async function eraseAction(id: string, reason: string) {
  const r = await act(() => api(`${BASE}/candidates/${id}/erase`, { method: 'POST', body: { reason } }), 'Personal details erased.');
  refresh(id);
  return r;
}

export async function bulkAction(body: Record<string, unknown>) {
  const r = await act(() => api<{ done: number; skipped: number; results: { id: string; ok: boolean; message?: string }[] }>(`${BASE}/candidates/bulk`, { method: 'POST', body }));
  refresh();
  if (!r.ok) return r;
  const d = r.data!;
  return { ...r, message: d.skipped ? `${d.done} done, ${d.skipped} skipped: ${d.results.find((x) => !x.ok)?.message ?? ''}` : `${d.done} candidate${d.done === 1 ? '' : 's'} updated.` };
}

export async function photoAction(id: string, form: FormData) {
  const r = await act(() => apiForm(`${BASE}/candidates/${id}/photo`, form, { method: 'PUT' }), 'Photo saved.');
  refresh(id);
  return r;
}

export async function removePhotoAction(id: string) {
  const r = await act(() => api(`${BASE}/candidates/${id}/photo`, { method: 'DELETE' }), 'Photo removed.');
  refresh(id);
  return r;
}

// Remarks, references, activities, follow-ups -----------------------------------------------------------------

export async function remarkAction(id: string, body: { body: string; category: string; restricted: boolean }) {
  const r = await act(() => api(`${BASE}/candidates/${id}/remarks`, { method: 'POST', body }), 'Remark added.');
  refresh(id);
  return r;
}

export async function addReferenceAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api(`${BASE}/candidates/${id}/references`, { method: 'POST', body }), 'Reference added.');
  refresh(id);
  return r;
}

export async function removeReferenceAction(candidateId: string, referenceId: string) {
  const r = await act(() => api(`${BASE}/references/${referenceId}`, { method: 'DELETE' }), 'Reference removed.');
  refresh(candidateId);
  return r;
}

export async function logActivityAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; followUpId: string | null }>(`${BASE}/candidates/${id}/activities`, { method: 'POST', body }), 'Activity logged.');
  refresh(id);
  return r.ok && r.data?.followUpId ? { ...r, message: 'Activity logged and the next follow-up scheduled.' } : r;
}

export async function addFollowUpAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api(`${BASE}/candidates/${id}/follow-ups`, { method: 'POST', body }), 'Follow-up scheduled.');
  refresh(id);
  return r;
}

export async function updateFollowUpAction(candidateId: string, followUpId: string, body: Record<string, unknown>) {
  const done: Record<string, string> = { completed: 'Follow-up completed.', missed: 'Marked as missed.', cancelled: 'Follow-up cancelled.', rescheduled: 'Follow-up rescheduled.' };
  const r = await act(() => api<{ status: string }>(`${BASE}/follow-ups/${followUpId}`, { method: 'PATCH', body }), done[String(body.status ?? '')] ?? 'Follow-up updated.');
  refresh(candidateId);
  revalidatePath(`${BASE}/follow-ups`);
  return r;
}

// Documents ---------------------------------------------------------------------------------------------------

export async function uploadDocumentAction(id: string, form: FormData) {
  const r = await act(() => apiForm(`${BASE}/candidates/${id}/documents`, form), 'Document uploaded.');
  refresh(id);
  return r;
}

export async function replaceDocumentAction(candidateId: string, fileId: string, form: FormData) {
  const r = await act(() => apiForm<{ version: number }>(`${BASE}/documents/${fileId}/replace`, form), 'New version uploaded.');
  refresh(candidateId);
  return r;
}

export async function deleteDocumentAction(candidateId: string, fileId: string) {
  const r = await act(() => api(`${BASE}/documents/${fileId}`, { method: 'DELETE' }), 'Document deleted.');
  refresh(candidateId);
  return r;
}

// Custom fields -----------------------------------------------------------------------------------------------

export async function saveFieldAction(id: string | null, body: Record<string, unknown>) {
  const r = await act(() => api(id ? `${BASE}/fields/${id}` : `${BASE}/fields`, { method: id ? 'PATCH' : 'POST', body }), id ? 'Field saved.' : 'Field created.');
  revalidatePath(`${BASE}/fields`);
  return r;
}

export async function archiveFieldAction(id: string, archived: boolean) {
  const r = await act(() => api(`${BASE}/fields/${id}/archive`, { method: 'POST', body: { archived } }), archived ? 'Field archived.' : 'Field restored.');
  revalidatePath(`${BASE}/fields`);
  return r;
}

export async function orderFieldsAction(ids: string[]) {
  const r = await act(() => api(`${BASE}/fields/order`, { method: 'PUT', body: { ids } }), 'Order saved.');
  revalidatePath(`${BASE}/fields`);
  return r;
}

export async function formFieldsAction(hrWorkspaceId: string | null) {
  return act(() => api<unknown[]>(`${BASE}/fields/form?hrWorkspaceId=${hrWorkspaceId ?? ''}`));
}

// Import ------------------------------------------------------------------------------------------------------

export async function uploadImportAction(form: FormData, hrWorkspaceId: string | null) {
  return act(() => apiForm<Record<string, unknown>>(`${BASE}/imports${hrWorkspaceId ? `?hrWorkspaceId=${hrWorkspaceId}` : ''}`, form));
}

export async function checkImportAction(id: string, plan: Record<string, unknown>) {
  return act(() => api<Record<string, unknown>>(`${BASE}/imports/${id}/check`, { method: 'POST', body: plan }));
}

export async function runImportAction(id: string, plan: Record<string, unknown>) {
  const r = await act(() => api<Record<string, unknown>>(`${BASE}/imports/${id}/run`, { method: 'POST', body: plan }));
  refresh();
  return r;
}

export async function cancelImportAction(id: string) {
  const r = await act(() => api(`${BASE}/imports/${id}/cancel`, { method: 'POST' }), 'Import cancelled.');
  revalidatePath(`${BASE}/import`);
  return r;
}

export async function deleteTemplateAction(id: string) {
  const r = await act(() => api(`${BASE}/import-templates/${id}`, { method: 'DELETE' }), 'Mapping deleted.');
  revalidatePath(`${BASE}/import`);
  return r;
}

// Settings and access -----------------------------------------------------------------------------------------

export async function saveAccessAction(changes: { key: string; enabled: boolean; caps: string[] }[]) {
  const r = await act(() => api(`${BASE}/access`, { method: 'PUT', body: { changes } }), 'Access saved.');
  refresh();
  return r;
}

export async function saveSettingsAction(body: Record<string, unknown>) {
  const r = await act(() => api(`${BASE}/settings`, { method: 'PUT', body }), 'Settings saved.');
  refresh();
  return r;
}

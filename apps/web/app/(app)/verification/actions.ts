'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

type Body = Record<string, unknown>;
const refresh = (id?: string) => {
  revalidatePath('/verification');
  if (id) revalidatePath(`/verification/${id}`);
};

export async function createCaseAction(body: Body) {
  const r = await act(() => api<{ id: string }>('/bgv/cases', { method: 'POST', body }), 'Verification started.');
  refresh();
  return r;
}

export async function updateCaseAction(id: string, body: Body) {
  const r = await act(() => api(`/bgv/cases/${id}`, { method: 'PATCH', body }), 'Saved.');
  refresh(id);
  return r;
}

export async function addCheckAction(id: string, body: Body) {
  const r = await act(() => api(`/bgv/cases/${id}/checks`, { method: 'POST', body }), 'Check added.');
  refresh(id);
  return r;
}

export async function updateCheckAction(id: string, checkId: string, body: Body) {
  const r = await act(() => api(`/bgv/cases/${id}/checks/${checkId}`, { method: 'PATCH', body }), 'Check saved.');
  refresh(id);
  return r;
}

const RESULT: Record<string, string> = { verified: 'Marked as verified. The employee’s HR contacts have been told.', failed: 'Marked as failed.', on_hold: 'Put on hold.', in_progress: 'Back in progress.' };
export async function decideAction(id: string, body: { status: string; remarks: string; completedOn?: string }) {
  const r = await act(() => api(`/bgv/cases/${id}/decision`, { method: 'POST', body }), RESULT[body.status] ?? 'Saved.');
  refresh(id);
  return r;
}

export async function cancelCaseAction(id: string, reason: string) {
  const r = await act(() => api(`/bgv/cases/${id}/cancel`, { method: 'POST', body: { reason } }), 'Case cancelled. It stays in the history.');
  refresh(id);
  return r;
}

export async function uploadFileAction(id: string, form: FormData) {
  const r = await act(() => apiForm(`/bgv/cases/${id}/files`, form), 'File uploaded.');
  refresh(id);
  return r;
}

export async function shareFileAction(caseId: string, fileId: string, shared: boolean) {
  const r = await act(() => api(`/bgv/files/${fileId}/shared`, { method: 'PUT', body: { shared } }), shared ? 'The agency can now see this file.' : 'No longer shared with the agency.');
  refresh(caseId);
  return r;
}

export async function removeFileAction(caseId: string, fileId: string) {
  const r = await act(() => api(`/bgv/files/${fileId}`, { method: 'DELETE' }), 'File taken off the case. It stays in the history.');
  refresh(caseId);
  return r;
}

export async function sendToAgencyAction(id: string, body: Body) {
  const r = await act(() => api<{ url: string; expiresAt: string }>(`/bgv/cases/${id}/share`, { method: 'POST', body }), 'Sent. The agency has been emailed its private link.');
  refresh(id);
  return r;
}

export async function revokeLinkAction(id: string, linkId: string) {
  const r = await act(() => api(`/bgv/cases/${id}/links/${linkId}/revoke`, { method: 'POST' }), 'Link switched off.');
  refresh(id);
  return r;
}

export async function saveAgencyAction(id: string | null, body: Body) {
  const r = await act(() => api(id ? `/bgv/agencies/${id}` : '/bgv/agencies', { method: id ? 'PUT' : 'POST', body }), id ? 'Agency saved.' : 'Agency added.');
  revalidatePath('/verification/agencies');
  return r;
}

export async function searchEmployeesAction(q: string) {
  return act(async () => {
    const r = await api<{ items: { id: string; displayName: string; employeeCode: string; departmentName: string | null }[] }>(`/employees?limit=8&q=${encodeURIComponent(q)}`);
    return r.items.map((e) => ({ id: e.id, name: `${e.displayName} (${e.employeeCode})`, departmentName: e.departmentName }));
  });
}

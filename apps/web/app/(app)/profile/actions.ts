'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';
import type { ProfileUpdate, ProfileUpdateDetail } from '@/lib/types';

const refresh = () => {
  revalidatePath('/profile', 'layout');
  revalidatePath('/approvals');
};

/** The employee submits a section for HR to approve. */
export async function submitProfileUpdateAction(employeeId: string, section: string, data: unknown, note?: string) {
  const r = await act(() => api<ProfileUpdate>(`/profile/${employeeId}/updates`, { method: 'POST', body: { section, data, note: note || null } }), 'Sent to HR for approval. Your current details stay until HR approves.');
  refresh();
  return r;
}

/** HR changes someone else's section directly. */
export async function editProfileSectionAction(employeeId: string, section: string, data: unknown) {
  const r = await act(() => api<{ updated: string[] }>(`/profile/${employeeId}/sections/${section}`, { method: 'PUT', body: data }), 'Saved. The employee has been told.');
  refresh();
  revalidatePath(`/employees/${employeeId}`);
  return r;
}

export async function cancelProfileUpdateAction(id: string) {
  const r = await act(() => api<ProfileUpdate>(`/profile/updates/${id}/cancel`, { method: 'POST' }), 'Update withdrawn.');
  refresh();
  return r;
}

export async function decideProfileUpdateAction(id: string, decision: 'approve' | 'reject' | 'request_info', remarks?: string) {
  const msg = { approve: 'Approved. The employee record is updated and the employee told.', reject: 'Rejected. The employee has your reason.', request_info: 'Sent back to the employee with your question.' }[decision];
  const r = await act(() => api<ProfileUpdateDetail>(`/profile/updates/${id}/decide`, { method: 'POST', body: { decision, remarks: remarks || null } }), msg);
  refresh();
  return r;
}

/** Uploads a certificate or proof into the employee's documents and returns its id, for linking from the profile. */
export async function uploadProfileDocumentAction(employeeId: string, form: FormData) {
  return act(() => apiForm<{ id: string; title: string; fileName: string }>(`/employees/${employeeId}/documents`, form));
}

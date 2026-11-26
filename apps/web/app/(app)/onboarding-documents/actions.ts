'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { AssignOptions } from './types';

const refresh = () => {
  revalidatePath('/onboarding-documents');
  revalidatePath('/settings/onboarding-documents');
  revalidatePath('/documents');
  revalidatePath('/tasks');
};

export async function assignOptionsAction(employmentType?: string, departmentId?: string) {
  const q = new URLSearchParams();
  if (employmentType) q.set('employmentType', employmentType);
  if (departmentId) q.set('departmentId', departmentId);
  return act(() => api<AssignOptions>(`/onboarding-documents/assign-options?${q}`));
}

export async function assignChecklistAction(employeeId: string, body: { templateId: string | null; itemIds: string[]; dueOn?: string | null; note?: string }) {
  const r = await act(() => api<{ id: string }>(`/onboarding-documents/employees/${employeeId}/checklist`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }),
    'Assigned. The employee has a task for each document and a notification.');
  refresh();
  revalidatePath(`/employees/${employeeId}`);
  return r;
}

type Body = Record<string, unknown>;
const save = async (path: string, method: 'POST' | 'PUT', body: Body, message: string) => {
  const r = await act(() => api<{ id?: string }>(path, { method, body }), message);
  refresh();
  return r;
};

export const addCategoryAction = async (body: Body) => save('/onboarding-documents/library/categories', 'POST', body, 'Category added.');
export const updateCategoryAction = async (id: string, body: Body) => save(`/onboarding-documents/library/categories/${id}`, 'PUT', body, 'Category saved.');
export const archiveCategoryAction = async (id: string) => save(`/onboarding-documents/library/categories/${id}/archive`, 'POST', {}, 'Category removed from the library. It is kept in the records.');
export const addItemAction = async (body: Body) => save('/onboarding-documents/library/documents', 'POST', body, 'Document added to the library.');
export const updateItemAction = async (id: string, body: Body) => save(`/onboarding-documents/library/documents/${id}`, 'PUT', body, 'Document saved.');
export const archiveItemAction = async (id: string) => save(`/onboarding-documents/library/documents/${id}/archive`, 'POST', {}, 'Removed from the library. Documents already asked for keep their requests and history.');
export const addTemplateAction = async (body: Body) => save('/onboarding-documents/library/templates', 'POST', body, 'Template added.');
export const updateTemplateAction = async (id: string, body: Body) => save(`/onboarding-documents/library/templates/${id}`, 'PUT', body, 'Template saved.');
export const archiveTemplateAction = async (id: string) => save(`/onboarding-documents/library/templates/${id}/archive`, 'POST', {}, 'Template removed. It is kept in the records.');
export const requestToSuperAction = async (body: Body) => save('/onboarding-documents/library/requests', 'POST', body, 'Sent to the Super Workspace. You will be told when they decide.');
export const decideLibraryRequestAction = async (id: string, decision: 'approve' | 'decline', note?: string) =>
  save(`/onboarding-documents/library/requests/${id}/decide`, 'POST', { decision, ...(note ? { note } : {}) }, decision === 'approve' ? 'Approved. The HR Workspace has been told.' : 'Declined. The HR Workspace has been told.');

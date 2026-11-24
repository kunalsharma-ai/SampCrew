'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const refresh = (id?: string) => {
  revalidatePath('/hr-workspaces');
  if (id) revalidatePath(`/hr-workspaces/${id}`);
  revalidatePath('/hr-workspaces/central');
  revalidatePath('/', 'layout');
};

export interface HrWorkspaceForm {
  name: string; code?: string; kind: string; description: string; features: string[]; maxEmployees: number;
  adminMembershipIds: string[]; departmentIds: string[]; locationIds: string[];
  /** The Workspace Permissions it starts with. */
  permissionTemplate?: { template: 'hr_default' | 'all' | 'custom' };
}

export async function createHrWorkspaceAction(input: HrWorkspaceForm) {
  const body = { ...input, code: input.code?.trim() ? input.code.trim().toUpperCase() : undefined };
  const r = await act(() => api<{ id: string }>('/hr-workspaces', { method: 'POST', body }), `${input.name} is ready. Its admins can now look after its people.`);
  refresh();
  return r;
}

export async function updateHrWorkspaceAction(id: string, patch: Record<string, unknown>, version: number) {
  const r = await act(() => api<{ id: string; version: number; changed: boolean }>(`/hr-workspaces/${id}`, { method: 'PATCH', body: { ...patch, version } }), 'Saved. Its people see the change on their next page.');
  refresh(id);
  return r;
}

export async function setHrWorkspaceStatusAction(id: string, status: 'active' | 'suspended' | 'archived', reason: string) {
  const done = status === 'active' ? 'Reactivated.' : status === 'suspended' ? 'Suspended. Its people keep their modules; nobody can be added or changed until it is reactivated.' : 'Archived. Its people are back in the central group and its admins no longer run it.';
  const r = await act(() => api(`/hr-workspaces/${id}/status`, { method: 'POST', body: { status, reason } }), done);
  refresh(id);
  return r;
}

export async function setHrWorkspaceAdminsAction(id: string, membershipIds: string[]) {
  const r = await act(() => api(`/hr-workspaces/${id}/admins`, { method: 'PUT', body: { membershipIds } }), 'Admins saved. Each one was told.');
  refresh(id);
  return r;
}

export async function assignToHrWorkspaceAction(id: string | 'central', employeeIds: string[], reason: string) {
  const path = id === 'central' ? '/hr-workspaces/central/members' : `/hr-workspaces/${id}/members`;
  const r = await act(() => api<{ moved: number }>(path, { method: 'POST', body: { employeeIds, reason } }), `${employeeIds.length === 1 ? 'Moved' : `${employeeIds.length} people moved`}. Their history goes with them.`);
  refresh(id === 'central' ? undefined : id);
  return r;
}

export async function transferEmployeeAction(employeeId: string, toHrWorkspaceId: string | null, reason: string, from?: string | null) {
  const r = await act(() => api('/hr-workspaces/transfers', { method: 'POST', body: { employeeId, toHrWorkspaceId, reason } }), 'Moved. Their history goes with them.');
  refresh(from ?? undefined);
  if (toHrWorkspaceId) revalidatePath(`/hr-workspaces/${toHrWorkspaceId}`);
  revalidatePath(`/employees/${employeeId}`);
  return r;
}

export async function setMemberModulesAction(employeeId: string, modules: string[], version: number, hrWorkspaceId: string | null) {
  const r = await act(() => api<{ modules: string[]; version: number }>(`/hr-workspaces/employees/${employeeId}/modules`, { method: 'PUT', body: { modules, version } }), 'Saved. They see the change on their next page.');
  refresh(hrWorkspaceId ?? undefined);
  return r;
}

export async function setHrWorkspacePermissionsAction(id: string, changes: { key: string; enabled: boolean }[], version: number) {
  const r = await act(() => api(`/hr-workspaces/${id}/permissions`, { method: 'PUT', body: { changes, version } }), 'Saved. Its admins see the change on their next page.');
  refresh(id);
  return r;
}

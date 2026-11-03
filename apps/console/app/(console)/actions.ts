'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function createTenantAction(body: Record<string, unknown>) {
  const r = await act(() => api<{ tenantId: string; ownerInviteUrl?: string; ownerAlreadyHadAccount: boolean }>('/platform/tenants', { method: 'POST', body }));
  revalidatePath('/tenants');
  return r;
}

export async function setTenantStatusAction(id: string, status: 'active' | 'suspended', reason: string) {
  const r = await act(() => api(`/platform/tenants/${id}/status`, { method: 'PATCH', body: { status, reason } }), status === 'suspended' ? 'Workspace suspended. Everyone was signed out.' : 'Workspace reactivated.');
  revalidatePath(`/tenants/${id}`);
  return r;
}

export async function overrideSubscriptionAction(id: string, body: Record<string, unknown>) {
  const r = await act(() => api(`/platform/tenants/${id}/subscription`, { method: 'PUT', body }), 'Subscription updated.');
  revalidatePath(`/tenants/${id}`);
  return r;
}

export async function requestSupportAccessAction(id: string, reason: string, durationMinutes: number) {
  const r = await act(() => api<{ note: string }>(`/platform/tenants/${id}/support-access`, { method: 'POST', body: { reason, durationMinutes } }));
  revalidatePath(`/tenants/${id}`);
  return r;
}

export async function setPriceAction(planKey: string, body: { currency: string; monthly: string; annualPerMonth: string }) {
  const r = await act(() => api<{ note: string }>(`/platform/plans/${planKey}/prices`, { method: 'PUT', body }));
  revalidatePath('/plans');
  return r;
}

export async function createAdminAction(body: { email: string; fullName: string; role: string; password: string }) {
  const r = await act(() => api(`/platform/admins`, { method: 'POST', body }), 'Admin created. They must set up two-step verification at first sign-in.');
  revalidatePath('/admins');
  return r;
}

export async function switchModulesAction(id: string, changes: { key: string; state: 'plan' | 'on' | 'off' }[]) {
  const r = await act(() => api(`/platform/tenants/${id}/access/modules`, { method: 'PUT', body: { changes } }), changes.length === 1 ? 'Module updated.' : `${changes.length} modules updated.`);
  revalidatePath(`/tenants/${id}/access`);
  return r;
}

export async function switchPermissionsAction(id: string, changes: { key: string; enabled: boolean }[]) {
  const r = await act(() => api(`/platform/tenants/${id}/access/permissions`, { method: 'PUT', body: { changes } }), changes.length === 1 ? 'Permission updated.' : `${changes.length} permissions updated.`);
  revalidatePath(`/tenants/${id}/access`);
  return r;
}

export async function setMemberModulesAction(id: string, membershipId: string, blockedFeatures: string[]) {
  const r = await act(() => api(`/platform/tenants/${id}/access/members/${membershipId}`, { method: 'PUT', body: { blockedFeatures } }), 'Member access saved.');
  revalidatePath(`/tenants/${id}/access`);
  return r;
}

export async function saveIntegrationAction(key: string, values: Record<string, unknown>) {
  const r = await act(() => api(`/platform/integrations/${key}`, { method: 'PUT', body: values }), 'Saved. CREW uses these settings from now on.');
  revalidatePath('/integrations');
  revalidatePath('/health');
  return r;
}

export async function testIntegrationAction(key: string, values: Record<string, unknown>, extras: { sendTo?: string; pushToken?: string }) {
  const r = await act(() => api<{ ok: boolean; detail: string; recorded: boolean }>(`/platform/integrations/${key}/test`, { method: 'POST', body: { values, ...extras } }));
  revalidatePath('/integrations');
  return r;
}

export async function resetIntegrationAction(key: string) {
  const r = await act(() => api(`/platform/integrations/${key}`, { method: 'DELETE' }), 'Console setting removed. The server\'s own settings apply again.');
  revalidatePath('/integrations');
  revalidatePath('/health');
  return r;
}

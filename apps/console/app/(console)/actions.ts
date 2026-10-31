'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function createTenantAction(body: Record<string, unknown>) {
  const r = await act(() => api<{ tenantId: string; ownerInviteUrl?: string; ownerAlreadyHadAccount: boolean }>('/platform/tenants', { method: 'POST', body }));
  revalidatePath('/tenants');
  return r;
}

export async function setTenantStatusAction(id: string, status: 'active' | 'suspended', reason: string) {
  const r = await act(() => api(`/platform/tenants/${id}/status`, { method: 'PATCH', body: { status, reason } }), status === 'suspended' ? 'Tenant suspended. Everyone was signed out.' : 'Tenant reactivated.');
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

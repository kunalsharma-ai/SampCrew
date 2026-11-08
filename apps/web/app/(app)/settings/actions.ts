'use server';
import { revalidatePath } from 'next/cache';
import QRCode from 'qrcode';
import { act, api } from '@/lib/api';
import { setSession, type TokenPair } from '@/lib/session';

export async function mfaSetupAction() {
  return act(async () => {
    const r = await api<{ secret: string; otpauthUri: string }>('/me/mfa/setup', { method: 'POST' });
    return { secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 200 }) };
  });
}

export async function mfaEnableAction(code: string) {
  const r = await act(() => api<TokenPair>('/me/mfa/enable', { method: 'POST', body: { code } }));
  if (r.ok) await setSession(r.data!);
  revalidatePath('/', 'layout');
  return r.ok ? { ok: true as const } : r;
}

export async function changePasswordAction(currentPassword: string, newPassword: string) {
  return act(() => api('/me/password', { method: 'POST', body: { currentPassword, newPassword } }), 'Password changed. Other sessions were signed out.');
}

export async function revokeSessionAction(id: string) {
  const r = await act(() => api(`/me/sessions/${id}`, { method: 'DELETE' }));
  revalidatePath('/settings/security');
  return r;
}

export async function saveRoleAction(id: string | null, body: { key?: string; name: string; description?: string; grants: { permission: string; scope: string }[] }) {
  const r = await act(() => api(id ? `/roles/${id}` : '/roles', { method: id ? 'PUT' : 'POST', body: id ? { name: body.name, description: body.description, grants: body.grants } : body }));
  revalidatePath('/settings/roles');
  return r;
}

export async function deleteRoleAction(id: string) {
  const r = await act(() => api(`/roles/${id}`, { method: 'DELETE' }));
  revalidatePath('/settings/roles');
  return r;
}

export async function verifyAuditAction() {
  return act(() => api<{ checked: number; intact: boolean; firstBrokenSeq: number | null; verifiedAt: string }>('/audit-events/verify'));
}

export async function changePlanAction(body: { planKey: string; billingCycle: string; seats: number; currency?: string }) {
  const r = await act(() => api('/billing/subscription', { method: 'PUT', body }), 'Plan updated');
  revalidatePath('/', 'layout');
  return r;
}

export async function requestPlanAction(body: { planKey: string; seats: number; billingCycle: 'monthly' | 'annual'; message?: string }) {
  const r = await act(() => api<{ note: string }>('/billing/plan-requests', { method: 'POST', body }));
  revalidatePath('/settings/billing');
  return r;
}

export async function withdrawPlanRequestAction(id: string) {
  const r = await act(() => api(`/billing/plan-requests/${id}/withdraw`, { method: 'POST' }), 'Request withdrawn');
  revalidatePath('/settings/billing');
  return r;
}

export async function saveWorkspaceAction(body: Record<string, unknown>) {
  const r = await act(() => api('/tenant', { method: 'PATCH', body }), 'Settings saved');
  revalidatePath('/', 'layout');
  return r;
}

export async function supportDecisionAction(id: string, decision: 'approve' | 'reject' | 'revoke') {
  const r = await act(() => api(`/support-access/${id}/${decision}`, { method: 'POST' }));
  revalidatePath('/settings/support');
  return r;
}

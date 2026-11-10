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

export type CheckoutBody = { planKey: string; billingCycle: string; seats: number; currency?: string; couponCode?: string };
export type ChangeResult =
  | { mode: 'checkout'; orderId: string; url: string; provider: string; total: string; currency: string }
  | { mode: 'applied'; invoice: { id: string; number: string; total: string; status: string } | null; plan: string }
  | { mode: 'scheduled'; effectiveOn: string; plan: string }
  | { mode: 'none'; plan: string };

export async function quotePlanAction(body: CheckoutBody) {
  return act(() => api<import('./billing/billing-view').Quote>('/billing/quote', { method: 'POST', body }));
}

export async function changePlanAction(body: CheckoutBody) {
  const r = await act(() => api<ChangeResult>('/billing/subscription', { method: 'PUT', body }), 'Plan updated');
  revalidatePath('/', 'layout');
  return r;
}

export async function cancelScheduledChangeAction() {
  const r = await act(() => api('/billing/scheduled-change', { method: 'DELETE' }), 'Scheduled change cancelled');
  revalidatePath('/settings/billing');
  return r;
}

export async function setAutoRenewAction(autoRenew: boolean) {
  const r = await act(() => api<{ autoRenew: boolean; endsOn: string | null }>('/billing/renewal', { method: 'PUT', body: { autoRenew } }));
  revalidatePath('/settings/billing');
  return r;
}

export async function startTrialAction(planKey: string) {
  const r = await act(() => api<{ plan: string; endsOn: string }>('/billing/trial', { method: 'POST', body: { planKey } }));
  revalidatePath('/', 'layout');
  return r;
}

export async function checkCouponAction(code: string, planKey?: string) {
  return act(() => api<{ code: string; name: string; kind: string; value: string; currency: string | null; duration: string; cycles: number | null }>('/billing/coupons/check', { method: 'POST', body: { code, planKey } }));
}

export async function buyAddonAction(addonKey: string, quantity: number) {
  const r = await act(() => api<ChangeResult>('/billing/addons', { method: 'POST', body: { addonKey, quantity } }));
  revalidatePath('/', 'layout');
  return r;
}

export async function removeAddonAction(key: string, keep = false) {
  const r = await act(() => api<{ endsOn: string | null }>(keep ? `/billing/addons/${key}/keep` : `/billing/addons/${key}`, { method: keep ? 'POST' : 'DELETE' }));
  revalidatePath('/settings/billing');
  return r;
}

export async function saveBillingProfileAction(body: Record<string, string>) {
  const r = await act(() => api('/billing/profile', { method: 'PUT', body }), 'Billing details saved');
  revalidatePath('/settings/billing');
  return r;
}

export async function payInvoiceAction(id: string) {
  return act(() => api<{ mode: 'checkout'; orderId: string; url: string }>(`/billing/invoices/${id}/pay`, { method: 'POST' }));
}

export async function orderStatusAction(id: string) {
  const r = await act(() => api<{ id: string; status: string; provider: string; purpose: string; amount: string; currency: string; description: string; paidAt: string | null; failureReason: string | null }>(`/billing/orders/${id}`));
  if (r.ok && r.data?.status === 'paid') revalidatePath('/', 'layout');
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

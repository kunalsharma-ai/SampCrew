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

export async function createPlanAction(body: Record<string, unknown>) {
  const r = await act(() => api<{ key: string }>('/platform/plans', { method: 'POST', body }), 'Plan created. Choose its modules and limits, then make it visible to workspaces.');
  revalidatePath('/plans');
  return r;
}

export async function updatePlanAction(planKey: string, body: Record<string, unknown>) {
  const r = await act(() => api(`/platform/plans/${planKey}`, { method: 'PATCH', body }), 'Plan details saved.');
  revalidatePath('/plans');
  return r;
}

export async function setPlanEntitlementsAction(planKey: string, body: { features: string[]; limits: Record<string, number> }) {
  const r = await act(() => api<{ added: string[]; removed: string[]; workspaces: number }>(`/platform/plans/${planKey}/entitlements`, { method: 'PUT', body }));
  revalidatePath('/plans');
  return r;
}

export async function archivePlanAction(planKey: string, archived: boolean) {
  const r = await act(() => api<{ note: string }>(`/platform/plans/${planKey}/${archived ? 'archive' : 'restore'}`, { method: 'POST' }));
  revalidatePath('/plans');
  return r;
}

export async function deletePlanAction(planKey: string) {
  const r = await act(() => api(`/platform/plans/${planKey}`, { method: 'DELETE' }), 'Plan deleted.');
  revalidatePath('/plans');
  return r;
}

export async function decidePlanRequestAction(id: string, decision: 'approved' | 'declined', note?: string) {
  const r = await act(() => api(`/platform/plan-requests/${id}/decision`, { method: 'POST', body: { decision, note: note || undefined } }), decision === 'approved' ? 'Request approved. The workspace is on its new plan.' : 'Request declined. The workspace admin was told.');
  revalidatePath('/plans');
  return r;
}

export async function createAdminAction(body: { email: string; fullName: string; role: string; password: string }) {
  const r = await act(() => api(`/platform/admins`, { method: 'POST', body }), 'Admin created. At first sign-in they set up two-step verification and choose their own password.');
  revalidatePath('/admins');
  return r;
}

export async function updateAdminAction(id: string, body: { fullName?: string; role?: string; status?: 'active' | 'disabled' }) {
  const message = body.status === 'disabled' ? 'Admin disabled and signed out everywhere.' : body.status === 'active' ? 'Admin can sign in again.' : body.role ? 'Saved. They were signed out so the new role applies at once.' : 'Saved.';
  const r = await act(() => api(`/platform/admins/${id}`, { method: 'PATCH', body }), message);
  revalidatePath('/admins');
  return r;
}

export async function resetAdminPasswordAction(id: string, password: string) {
  const r = await act(() => api(`/platform/admins/${id}/reset-password`, { method: 'POST', body: { password } }), 'Temporary password set. They were signed out and choose a new password at next sign-in.');
  revalidatePath('/admins');
  return r;
}

export async function resetAdminMfaAction(id: string) {
  const r = await act(() => api(`/platform/admins/${id}/reset-mfa`, { method: 'POST' }), 'Two-step verification removed. They set it up again at next sign-in.');
  revalidatePath('/admins');
  return r;
}

export async function unlockAdminAction(id: string) {
  const r = await act(() => api(`/platform/admins/${id}/unlock`, { method: 'POST' }), 'Unlocked. They can sign in again.');
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
  const r = await act(() => api(`/platform/integrations/${key}`, { method: 'PUT', body: values }), 'Saved. SampCrew uses these settings from now on.');
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

export async function switchAppsAction(id: string, body: { web?: boolean; mobile?: boolean; modules?: { key: string; web: boolean; mobile: boolean }[] }) {
  const r = await act(() => api(`/platform/tenants/${id}/access/apps`, { method: 'PUT', body }), body.web === false || body.mobile === false ? 'App switched off. Its open sessions have ended.' : 'Apps updated.');
  revalidatePath(`/tenants/${id}/access`);
  return r;
}

export async function memberAction(id: string, membershipId: string, action: string, reason: string) {
  const r = await act(() => api<{ sessionsEnded?: number; inviteUrl?: string; temporaryPassword?: string }>(`/platform/tenants/${id}/users/${membershipId}/actions`, { method: 'POST', body: { action, reason } }));
  revalidatePath(`/tenants/${id}/users`);
  revalidatePath('/users');
  return r;
}

export async function setDeviceIntegrationsAction(id: string, changes: { key: string; enabled: boolean }[]) {
  const r = await act(() => api(`/platform/tenants/${id}/devices/integrations`, { method: 'PUT', body: { changes } }), 'Machine integrations updated.');
  revalidatePath(`/tenants/${id}/devices`);
  return r;
}

export async function pauseDeviceAction(id: string, deviceId: string, reason: string | null) {
  const r = await act(
    () => api(`/platform/tenants/${id}/devices/${deviceId}/${reason === null ? 'resume' : 'pause'}`, { method: 'POST', body: reason === null ? {} : { reason } }),
    reason === null ? 'Machine resumed. SampCrew accepts its punches again.' : 'Machine paused. SampCrew refuses what it sends until you resume it.',
  );
  revalidatePath(`/tenants/${id}/devices`);
  revalidatePath('/devices');
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------------------------------------------

export async function saveBillingSettingsAction(body: Record<string, unknown>) {
  const r = await act(() => api('/platform/billing/settings', { method: 'PUT', body }), 'Billing settings saved. New invoices use them.');
  revalidatePath('/billing');
  return r;
}

export async function markInvoicePaidAction(id: string, body: { reference: string; paidOn?: string }) {
  const r = await act(() => api(`/platform/billing/invoices/${id}/mark-paid`, { method: 'POST', body }), 'Payment recorded. The invoice is paid.');
  revalidatePath('/billing');
  revalidatePath('/tenants', 'layout');
  return r;
}

export async function voidInvoiceAction(id: string, reason: string) {
  const r = await act(() => api(`/platform/billing/invoices/${id}/void`, { method: 'POST', body: { reason } }), 'Invoice voided.');
  revalidatePath('/billing');
  revalidatePath('/tenants', 'layout');
  return r;
}

export async function manualInvoiceAction(tenantId: string, body: { description: string; amount: string; currency: string }) {
  const r = await act(() => api<{ id: string; number: string }>(`/platform/billing/tenants/${tenantId}/invoices`, { method: 'POST', body }));
  revalidatePath(`/tenants/${tenantId}/billing`);
  return r;
}

export async function setDealAction(tenantId: string, body: Record<string, unknown>) {
  const r = await act(() => api(`/platform/billing/tenants/${tenantId}/deal`, { method: 'PUT', body }), 'Contract terms saved. Renewals use them.');
  revalidatePath(`/tenants/${tenantId}/billing`);
  return r;
}

export async function unlockTenantAction(tenantId: string, reason: string) {
  const r = await act(() => api(`/platform/billing/tenants/${tenantId}/unlock`, { method: 'POST', body: { reason } }), 'Read-only lifted for 7 days. It comes back after that if the invoice is still unpaid.');
  revalidatePath(`/tenants/${tenantId}/billing`);
  return r;
}

export async function runBillingAction(tenantId?: string) {
  const r = await act(() => api<unknown[]>('/platform/billing/run', { method: 'POST', body: tenantId ? { tenantId } : {} }));
  revalidatePath('/billing');
  if (tenantId) revalidatePath(`/tenants/${tenantId}/billing`);
  return r;
}

export async function setPlanBillingAction(planKey: string, body: Record<string, unknown>) {
  const r = await act(() => api(`/platform/billing/plans/${planKey}`, { method: 'PUT', body }), 'Trial and overage saved.');
  revalidatePath('/plans');
  return r;
}

export async function createAddonAction(body: Record<string, unknown>) {
  const r = await act(() => api('/platform/billing/addons', { method: 'POST', body }), 'Add-on created.');
  revalidatePath('/billing');
  return r;
}

export async function updateAddonAction(key: string, body: Record<string, unknown>) {
  const r = await act(() => api(`/platform/billing/addons/${key}`, { method: 'PATCH', body }), 'Add-on saved.');
  revalidatePath('/billing');
  return r;
}

export async function createCouponAction(body: Record<string, unknown>) {
  const r = await act(() => api('/platform/billing/coupons', { method: 'POST', body }), 'Coupon created.');
  revalidatePath('/billing');
  return r;
}

export async function setCouponActiveAction(id: string, active: boolean) {
  const r = await act(() => api(`/platform/billing/coupons/${id}`, { method: 'PATCH', body: { active } }), active ? 'Coupon switched on.' : 'Coupon switched off.');
  revalidatePath('/billing');
  return r;
}

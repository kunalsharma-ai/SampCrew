'use server';
import type { ConsoleNotificationPrefs, ConsoleNotificationSummary, ConsoleNotification, ConsoleRole, CreditNoteView, PlanImpact, SearchResults } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

// ---- notifications ------------------------------------------------------------------------------------------------

export async function notificationSummaryAction(): Promise<ConsoleNotificationSummary | null> {
  return api<ConsoleNotificationSummary>('/platform/notifications/summary').catch(() => null);
}

export async function notificationsPageAction(q: { category?: string; unread?: boolean; before?: string }) {
  const p = new URLSearchParams();
  if (q.category) p.set('category', q.category);
  if (q.unread) p.set('unread', 'true');
  if (q.before) p.set('before', q.before);
  return api<{ items: ConsoleNotification[]; next: string | null; categories: string[] }>(`/platform/notifications?${p}`).catch(() => null);
}

export async function markNotificationsReadAction(ids: string[]) {
  return act(() => api('/platform/notifications/read', { method: 'POST', body: { ids } }));
}

export async function markNotificationsUnreadAction(ids: string[]) {
  return act(() => api('/platform/notifications/unread', { method: 'POST', body: { ids } }));
}

export async function markAllNotificationsReadAction() {
  const r = await act(() => api('/platform/notifications/read-all', { method: 'POST' }), 'All marked as read.');
  revalidatePath('/notifications');
  return r;
}

export async function saveNotificationPrefsAction(prefs: ConsoleNotificationPrefs) {
  const r = await act(() => api<ConsoleNotificationPrefs>('/platform/notifications/preferences', { method: 'PUT', body: prefs }), 'Preferences saved.');
  revalidatePath('/', 'layout');
  return r;
}

// ---- search -------------------------------------------------------------------------------------------------------

export async function searchAction(q: string): Promise<SearchResults | null> {
  if (q.trim().length < 2) return null;
  return api<SearchResults>(`/platform/search?q=${encodeURIComponent(q.trim())}&limit=5`).catch(() => null);
}

// ---- clients ------------------------------------------------------------------------------------------------------

export async function createClientAction(body: { profile: Record<string, unknown>; workspace: Record<string, unknown> }) {
  const r = await act(() => api<{ tenantId: string; companyId: string; ownerInviteUrl?: string; ownerAccess: string; emailDelivery: string }>('/platform/clients', { method: 'POST', body }));
  revalidatePath('/clients');
  return r;
}

export async function addClientWorkspaceAction(clientId: string, body: Record<string, unknown>) {
  const r = await act(() => api<{ tenantId: string; ownerInviteUrl?: string }>(`/platform/clients/${clientId}/workspaces`, { method: 'POST', body }), 'Super Workspace added.');
  revalidatePath(`/clients/${clientId}`);
  return r;
}

export async function saveClientProfileAction(clientId: string, body: Record<string, unknown>) {
  const r = await act(() => api(`/platform/clients/${clientId}/profile`, { method: 'PUT', body }), 'Company profile saved.');
  revalidatePath(`/clients/${clientId}`);
  return r;
}

export async function archiveClientAction(clientId: string, archived: boolean, reason: string) {
  const r = await act(() => api(`/platform/clients/${clientId}/archive`, { method: 'POST', body: { archived, reason } }), archived ? 'Company archived.' : 'Company restored.');
  revalidatePath(`/clients/${clientId}`);
  revalidatePath('/clients');
  return r;
}

export async function clientBulkAction(body: { action: string; ids: string[]; reason?: string; tag?: string; accountManagerId?: string | null }) {
  const r = await act(() => api<{ results: { id: string; ok: boolean; detail?: string }[] }>('/platform/clients/bulk', { method: 'POST', body }));
  revalidatePath('/clients');
  return r;
}

export async function moveWorkspaceAction(tenantId: string, clientId: string, from: string) {
  const r = await act(() => api(`/platform/tenants/${tenantId}/client`, { method: 'PUT', body: { clientId } }), 'Super Workspace moved.');
  revalidatePath(`/clients/${from}`);
  revalidatePath(`/clients/${clientId}`);
  return r;
}

export async function lookupClientAction(clientId: string) {
  return act(() => api<{ source: string; fetchedAt: string; facts: Record<string, unknown> }>(`/platform/clients/${clientId}/lookup`, { method: 'POST' }));
}

export async function applyLookupAction(clientId: string, fields: string[]) {
  const r = await act(() => api(`/platform/clients/${clientId}/lookup/apply`, { method: 'POST', body: { fields } }), 'Saved from Brandfetch.');
  revalidatePath(`/clients/${clientId}`);
  return r;
}

// ---- roles --------------------------------------------------------------------------------------------------------

export async function saveRoleAction(key: string | null, body: { name: string; description: string; permissions: string[] }) {
  const r = await act(() => api<ConsoleRole>(key ? `/platform/roles/${key}` : '/platform/roles', { method: key ? 'PUT' : 'POST', body }), key ? 'Role saved. It applies on each admin\'s next click.' : 'Role created.');
  revalidatePath('/roles');
  return r;
}

export async function archiveRoleAction(key: string) {
  const r = await act(() => api(`/platform/roles/${key}`, { method: 'DELETE' }), 'Role archived.');
  revalidatePath('/roles');
  return r;
}

// ---- security -----------------------------------------------------------------------------------------------------

export async function revokeSessionAction(id: string) {
  const r = await act(() => api(`/platform/sessions/${id}/revoke`, { method: 'POST' }), 'Session ended.');
  revalidatePath('/security');
  return r;
}

export async function revokeAdminSessionsAction(adminId: string) {
  const r = await act(() => api<{ revoked: number }>(`/platform/admins/${adminId}/sessions/revoke`, { method: 'POST' }));
  revalidatePath('/security');
  return r;
}

// ---- refunds ------------------------------------------------------------------------------------------------------

export async function refundAction(body: { invoiceId: string; amount: string; method: 'gateway' | 'bank_transfer'; reason: string; reference?: string }) {
  const r = await act(() => api<CreditNoteView>('/platform/refunds', { method: 'POST', body }));
  revalidatePath('/billing');
  return r;
}

export async function voidCreditNoteAction(id: string, reason: string) {
  const r = await act(() => api(`/platform/credit-notes/${id}/void`, { method: 'POST', body: { reason } }), 'Credit note voided.');
  revalidatePath('/billing');
  return r;
}

// ---- plans --------------------------------------------------------------------------------------------------------

export async function planImpactAction(key: string, proposed?: { features: string[]; limits: Record<string, number> }) {
  return act(() => (proposed ? api<PlanImpact>(`/platform/plans/${key}/impact`, { method: 'POST', body: proposed }) : api<PlanImpact>(`/platform/plans/${key}/impact`)));
}

export async function duplicatePlanAction(key: string, body: { key: string; name: string }) {
  const r = await act(() => api<{ key: string }>(`/platform/plans/${key}/duplicate`, { method: 'POST', body }), 'Plan copied. The copy is hidden until you make it public.');
  revalidatePath('/plans');
  return r;
}

export async function retirePlanAction(key: string, retire: boolean, reason?: string) {
  const r = await act(() => api<{ note: string }>(`/platform/plans/${key}/${retire ? 'retire' : 'unretire'}`, { method: 'POST', body: retire ? { reason } : undefined }));
  revalidatePath('/plans');
  revalidatePath(`/plans/${key}`);
  return r;
}

// ---- settings -----------------------------------------------------------------------------------------------------

export async function saveSettingsAction(body: Record<string, unknown>) {
  const r = await act(() => api('/platform/settings', { method: 'PATCH', body }), 'Settings saved.');
  revalidatePath('/settings');
  return r;
}

// ---- support triage -----------------------------------------------------------------------------------------------

export async function triageConversationAction(id: string, body: { priority?: string; assignedAdminId?: string | null }) {
  const r = await act(() => api(`/platform/support/conversations/${id}/triage`, { method: 'PUT', body }), 'Updated.');
  revalidatePath('/support');
  return r;
}

export async function startConversationAction(body: { tenantId: string; subject: string; body: string; category?: string; priority?: string }) {
  const r = await act(() => api<{ id: string }>('/platform/support/conversations', { method: 'POST', body }));
  revalidatePath('/support');
  return r;
}

// ---- view as ------------------------------------------------------------------------------------------------------

export async function viewAsSectionAction(tenantId: string, section: string) {
  return act(() => api<Record<string, unknown>>(`/platform/tenants/${tenantId}/view-as/${section}`));
}

export async function exitViewAsAction(tenantId: string) {
  const r = await act(() => api(`/platform/tenants/${tenantId}/view-as/exit`, { method: 'POST' }), 'Support access ended.');
  revalidatePath(`/tenants/${tenantId}`);
  return r;
}

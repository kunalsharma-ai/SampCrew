'use server';
import { redirect } from 'next/navigation';
import { act, api, ApiError } from '@/lib/api';
import { clearSession, setSession, type TokenPair } from '@/lib/session';

export async function logoutAction() {
  await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
  await clearSession();
  redirect('/login');
}

export async function switchTenantAction(tenantId: string) {
  try {
    const t = await api<TokenPair>('/auth/switch-tenant', { method: 'POST', body: { tenantId } });
    await setSession(t);
  } catch (e) {
    if (e instanceof ApiError) return { ok: false as const, message: e.message };
    throw e;
  }
  redirect('/');
}

export async function markNotificationReadAction(id: string) {
  return act(() => api(`/notifications/${id}/read`, { method: 'POST' }));
}

export async function markAllNotificationsReadAction() {
  return act(() => api('/notifications/read-all', { method: 'POST' }));
}

/** Unread notices per category, for the menu's unread markers (refetched when notices arrive or are read). */
export async function notificationCountsAction(): Promise<Record<string, number> | null> {
  const s = await api<{ categories: { category: string; unread: number }[] }>('/notifications/summary').catch(() => null);
  return s ? Object.fromEntries(s.categories.filter((c) => c.unread > 0).map((c) => [c.category, c.unread])) : null;
}

/** Unread notices per category and how many ask for action (the bell's Action needed tab, Home and the menu markers). */
export async function notificationLiveCountsAction(): Promise<{ byCategory: Record<string, number>; actionNeeded: number } | null> {
  const s = await api<{ categories: { category: string; unread: number }[]; actionNeeded?: number }>('/notifications/summary').catch(() => null);
  return s ? { byCategory: Object.fromEntries(s.categories.filter((c) => c.unread > 0).map((c) => [c.category, c.unread])), actionNeeded: s.actionNeeded ?? 0 } : null;
}

export async function markNotificationUnreadAction(id: string) {
  return act(() => api(`/notifications/${id}/unread`, { method: 'POST' }));
}

export async function notificationPreferencesAction() {
  return api<import('@crew/contracts').NotificationPreferences>('/notifications/preferences').catch(() => null);
}

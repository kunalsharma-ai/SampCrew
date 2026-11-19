'use server';
import type { NotificationPreferences, NotificationPreferencesInput, NotificationView } from '@crew/contracts';
import { act, api } from '@/lib/api';

export async function loadMoreNotificationsAction(query: string) {
  return act(() => api<{ unread: number; items: NotificationView[]; nextBefore: string | null }>(`/notifications?${query}`));
}

export async function markUnreadAction(id: string) {
  return act(() => api(`/notifications/${id}/unread`, { method: 'POST' }));
}

export async function markCategoryReadAction(category?: string) {
  return act(() => api('/notifications/read-all', { method: 'POST', body: category ? { category } : {} }));
}

export async function saveNotificationPreferencesAction(input: NotificationPreferencesInput) {
  return act(() => api<NotificationPreferences>('/notifications/preferences', { method: 'PUT', body: input }), 'Notification settings saved');
}

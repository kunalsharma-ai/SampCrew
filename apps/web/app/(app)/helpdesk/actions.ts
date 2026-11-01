'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { Article } from './types';

type Body = Record<string, unknown>;
const refresh = (...paths: string[]) => {
  for (const p of paths) revalidatePath(p);
};

// Cases -------------------------------------------------------------------------------------------------------

export async function createCaseAction(body: Body, idempotencyKey: string) {
  const r = await act(() => api<{ id: string; ref: string }>('/helpdesk/cases', { method: 'POST', body, idempotencyKey }), 'Sent to HR. You will be notified when they reply.');
  refresh('/helpdesk', '/helpdesk/queue');
  return r;
}

export async function replyAction(id: string, body: string, internal: boolean, aiInteractionId?: string) {
  const r = await act(() => api(`/helpdesk/cases/${id}/messages`, { method: 'POST', body: { body, internal, ...(aiInteractionId ? { aiInteractionId } : {}) } }), internal ? 'Internal note added.' : 'Reply sent.');
  refresh(`/helpdesk/${id}`, '/helpdesk', '/helpdesk/queue');
  return r;
}

const MOVED: Record<string, string> = {
  in_progress: 'Marked as in progress.', waiting_on_employee: 'The employee has been asked to reply.', resolved: 'Resolved. The employee has been notified.',
  closed: 'Thanks. The case is closed.', open: 'Case reopened. HR has been told.',
};
export async function statusAction(id: string, status: string, message?: string) {
  const r = await act(() => api(`/helpdesk/cases/${id}/status`, { method: 'POST', body: { status, ...(message ? { message } : {}) } }), MOVED[status] ?? 'Updated.');
  refresh(`/helpdesk/${id}`, '/helpdesk', '/helpdesk/queue');
  return r;
}

export async function assignAction(id: string, assigneeMembershipId: string | null) {
  const r = await act(() => api(`/helpdesk/cases/${id}/assignee`, { method: 'PUT', body: { assigneeMembershipId } }), assigneeMembershipId ? 'Case assigned.' : 'Case unassigned.');
  refresh(`/helpdesk/${id}`, '/helpdesk/queue');
  return r;
}

export async function priorityAction(id: string, priority: string) {
  const r = await act(() => api(`/helpdesk/cases/${id}/priority`, { method: 'PUT', body: { priority } }), 'Priority changed; response targets recalculated.');
  refresh(`/helpdesk/${id}`, '/helpdesk/queue');
  return r;
}

export async function categoryAction(id: string, categoryId: string) {
  const r = await act(() => api(`/helpdesk/cases/${id}/category`, { method: 'PUT', body: { categoryId } }), 'Moved to the new category.');
  refresh(`/helpdesk/${id}`, '/helpdesk/queue');
  return r;
}

export async function rateAction(id: string, rating: number, comment: string) {
  const r = await act(() => api(`/helpdesk/cases/${id}/rating`, { method: 'POST', body: { rating, comment } }), 'Thanks for the feedback.');
  refresh(`/helpdesk/${id}`);
  return r;
}

export async function suggestArticlesAction(categoryId: string, q: string) {
  const params = new URLSearchParams({ categoryId, ...(q.trim().length >= 3 ? { q: q.trim() } : {}) });
  return act(() => api<Article[]>(`/helpdesk/articles?${params}`));
}

export async function articleAction(id: string) {
  return act(() => api<Article>(`/helpdesk/articles/${id}`));
}

/** For logging a case on someone's behalf: people in the directory the handler can see. */
export async function searchEmployeesAction(q: string) {
  return act(async () => {
    const r = await api<{ items: { id: string; displayName: string; employeeCode: string; departmentName: string | null }[] }>(`/employees?limit=8&q=${encodeURIComponent(q)}`);
    return r.items.map((e) => ({ id: e.id, name: `${e.displayName} (${e.employeeCode})`, departmentName: e.departmentName }));
  });
}

// Settings ----------------------------------------------------------------------------------------------------

export async function saveCategoryAction(id: string | null, body: Body) {
  const r = await act(() => api(id ? `/helpdesk/categories/${id}` : '/helpdesk/categories', { method: id ? 'PUT' : 'POST', body }), id ? 'Category saved.' : 'Category added.');
  refresh('/settings/helpdesk');
  return r;
}

export async function archiveCategoryAction(id: string) {
  const r = await act(() => api(`/helpdesk/categories/${id}/archive`, { method: 'POST' }), 'Category archived. Existing cases keep it.');
  refresh('/settings/helpdesk');
  return r;
}

export async function saveArticleAction(id: string | null, body: Body) {
  const r = await act(() => api(id ? `/helpdesk/articles/${id}` : '/helpdesk/articles', { method: id ? 'PUT' : 'POST', body }), id ? 'Article saved.' : 'Article added.');
  refresh('/settings/helpdesk', '/helpdesk');
  return r;
}

export async function deleteArticleAction(id: string) {
  const r = await act(() => api(`/helpdesk/articles/${id}`, { method: 'DELETE' }), 'Article deleted.');
  refresh('/settings/helpdesk', '/helpdesk');
  return r;
}

// Announcements -----------------------------------------------------------------------------------------------

export async function saveAnnouncementAction(id: string | null, body: Body) {
  const r = await act(() => api<{ id: string }>(id ? `/announcements/${id}` : '/announcements', { method: id ? 'PUT' : 'POST', body }), id ? 'Announcement saved.' : 'Draft saved.');
  refresh('/announcements/manage', ...(id ? [`/announcements/manage/${id}`] : []));
  return r;
}

export async function publishAnnouncementAction(id: string) {
  const r = await act(() => api(`/announcements/${id}/publish`, { method: 'POST' }), 'Published. Everyone it is addressed to has been notified.');
  refresh('/announcements/manage', `/announcements/manage/${id}`, '/announcements', '/');
  return r;
}

export async function archiveAnnouncementAction(id: string) {
  const r = await act(() => api(`/announcements/${id}/archive`, { method: 'POST' }), 'Taken off the feed.');
  refresh('/announcements/manage', `/announcements/manage/${id}`, '/announcements', '/');
  return r;
}

export async function deleteAnnouncementAction(id: string) {
  const r = await act(() => api(`/announcements/${id}`, { method: 'DELETE' }), 'Draft deleted.');
  refresh('/announcements/manage');
  return r;
}

export async function acknowledgeAction(id: string) {
  const r = await act(() => api(`/announcements/${id}/acknowledge`, { method: 'POST' }), 'Thanks. Your acknowledgement is recorded.');
  refresh(`/announcements/${id}`, '/announcements', '/');
  return r;
}

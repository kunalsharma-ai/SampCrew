'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';
import type { AnnouncementFile, Article } from './types';

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

export async function assignAction(id: string, assigneeMembershipId: string | null, collaboratorMembershipIds?: string[]) {
  const done = collaboratorMembershipIds ? 'Handlers updated.' : assigneeMembershipId ? 'Case assigned.' : 'Case unassigned.';
  const r = await act(() => api(`/helpdesk/cases/${id}/assignee`, { method: 'PUT', body: { assigneeMembershipId, ...(collaboratorMembershipIds ? { collaboratorMembershipIds } : {}) } }), done);
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

const ANNOUNCEMENT_PAGES = ['/announcements/manage', '/announcements', '/'];

export async function saveAnnouncementAction(id: string | null, body: Body) {
  const r = await act(() => api<{ id: string; version: number }>(id ? `/announcements/${id}` : '/announcements', { method: id ? 'PUT' : 'POST', body }), id ? 'Announcement saved.' : 'Draft saved. Nobody sees it until you publish it.');
  refresh(...ANNOUNCEMENT_PAGES, ...(id ? [`/announcements/manage/${id}`, `/announcements/${id}`] : []));
  return r;
}

/**
 * Saves the announcement and publishes it in one go (or schedules it for publishAt), so it appears on everyone's
 * feed (Web Portal and mobile app) and they are notified. If publishing is refused (for example nobody is in the
 * audience) the draft stays saved.
 */
export async function saveAndPublishAnnouncementAction(id: string | null, body: Body, publishAt: string | null = null) {
  const saved = await act(() => api<{ id: string }>(id ? `/announcements/${id}` : '/announcements', { method: id ? 'PUT' : 'POST', body }), 'Draft saved.');
  if (!saved.ok || !saved.data) return saved;
  const draftId = saved.data.id;
  const r = await act(() => api<{ id: string; audience: number; scheduledFor: string | null }>(`/announcements/${draftId}/publish`, { method: 'POST', body: { publishAt } }), 'Published.');
  refresh(...ANNOUNCEMENT_PAGES, `/announcements/manage/${draftId}`);
  const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
  if (r.ok && r.data?.scheduledFor) return { ...r, message: `Scheduled. It goes to ${people(r.data.audience)} at the time you chose, and they are notified then.` };
  if (r.ok && r.data) return { ...r, message: `Published to ${people(r.data.audience)}. They see it in the Web Portal and the mobile app and have been notified.` };
  return r.ok ? r : { ...r, data: { id: draftId }, code: 'saved_not_published', message: `The draft is saved but not published: ${r.message}` };
}

export async function publishAnnouncementAction(id: string) {
  const r = await act(() => api(`/announcements/${id}/publish`, { method: 'POST', body: {} }), 'Published. Everyone it is addressed to has been notified.');
  refresh(...ANNOUNCEMENT_PAGES, `/announcements/manage/${id}`);
  return r;
}

export async function unscheduleAnnouncementAction(id: string) {
  const r = await act(() => api(`/announcements/${id}/unschedule`, { method: 'POST' }), 'No longer scheduled; it is a draft again.');
  refresh(...ANNOUNCEMENT_PAGES, `/announcements/manage/${id}`);
  return r;
}

export async function remindAnnouncementAction(id: string) {
  const r = await act(() => api<{ reminded: number }>(`/announcements/${id}/remind`, { method: 'POST' }), 'Reminder sent.');
  refresh(`/announcements/manage/${id}`);
  return r.ok && r.data ? { ...r, message: r.data.reminded ? `Reminded ${r.data.reminded} ${r.data.reminded === 1 ? 'person' : 'people'} who had not acknowledged it.` : 'Everyone has acknowledged it already.' } : r;
}

export async function archiveAnnouncementAction(id: string) {
  const r = await act(() => api(`/announcements/${id}/archive`, { method: 'POST' }), 'Taken off the feed.');
  refresh(...ANNOUNCEMENT_PAGES, `/announcements/manage/${id}`);
  return r;
}

export async function deleteAnnouncementAction(id: string) {
  const r = await act(() => api(`/announcements/${id}`, { method: 'DELETE' }), 'Announcement deleted.');
  refresh(...ANNOUNCEMENT_PAGES);
  return r;
}

export async function uploadAnnouncementFileAction(form: FormData) {
  return act(() => apiForm<AnnouncementFile>('/announcements/files', form));
}

export async function acknowledgeAction(id: string) {
  const r = await act(() => api(`/announcements/${id}/acknowledge`, { method: 'POST' }), 'Thanks. Your acknowledgement is recorded.');
  refresh(`/announcements/${id}`, '/announcements', '/');
  return r;
}

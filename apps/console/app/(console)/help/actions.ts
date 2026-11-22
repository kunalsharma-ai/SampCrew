'use server';
import type { HelpArticleInput, HelpCategoryInput, HelpQueryCategoryInput, HelpQueryStatus, HelpReplyInput, HelpSettings } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

// Answering queries that reached SampCrew Support ------------------------------------------------------------

export async function consoleReplyAction(id: string, input: Partial<HelpReplyInput> & { body: string }) {
  const r = await act(() => api(`/platform/help/queries/${id}/replies`, { method: 'POST', body: { ...input, fileIds: [] } }));
  revalidatePath(`/help-queries/${id}`);
  return r;
}

export async function consoleStatusAction(id: string, status: HelpQueryStatus, note?: string | null) {
  const r = await act(() => api(`/platform/help/queries/${id}/status`, { method: 'PUT', body: { status, note: note ?? null } }));
  revalidatePath('/help-queries');
  return r;
}

export async function consoleAssignAction(id: string, assigneeId: string | null) {
  return act(() => api(`/platform/help/queries/${id}/assignee`, { method: 'PUT', body: { assigneeId } }));
}

// The content manager -----------------------------------------------------------------------------------------

const done = () => { revalidatePath('/help-content'); revalidatePath('/help'); };

export async function saveCategoryAction(id: string | null, input: HelpCategoryInput) {
  const r = await act(() => api<{ id: string }>(id ? `/platform/help/manage/categories/${id}` : '/platform/help/manage/categories', { method: id ? 'PUT' : 'POST', body: input }), id ? 'Category saved.' : 'Category created.');
  done();
  return r;
}

export async function deleteCategoryAction(id: string) {
  const r = await act(() => api(`/platform/help/manage/categories/${id}`, { method: 'DELETE' }), 'Category deleted.');
  done();
  return r;
}

export async function saveArticleAction(id: string | null, input: HelpArticleInput) {
  const r = await act(() => api<{ id: string }>(id ? `/platform/help/manage/articles/${id}` : '/platform/help/manage/articles', { method: id ? 'PUT' : 'POST', body: input }), id ? 'Article saved.' : 'Article created.');
  done();
  return r;
}

export async function articleStatusAction(id: string, status: 'published' | 'draft') {
  const r = await act(() => api(`/platform/help/manage/articles/${id}/status`, { method: 'PUT', body: { status } }), status === 'published' ? 'Published.' : 'Unpublished: saved as a draft.');
  done();
  return r;
}

export async function deleteArticleAction(id: string) {
  const r = await act(() => api(`/platform/help/manage/articles/${id}`, { method: 'DELETE' }), 'Article deleted.');
  done();
  return r;
}

export async function saveQueryCategoryAction(id: string | null, input: HelpQueryCategoryInput) {
  const r = await act(() => api(id ? `/platform/help/manage/query-categories/${id}` : '/platform/help/manage/query-categories', { method: id ? 'PUT' : 'POST', body: input }), id ? 'Query category saved.' : 'Query category created.');
  done();
  return r;
}

export async function deleteQueryCategoryAction(id: string) {
  const r = await act(() => api(`/platform/help/manage/query-categories/${id}`, { method: 'DELETE' }), 'Query category deleted.');
  done();
  return r;
}

export async function saveHelpSettingsAction(input: HelpSettings) {
  const r = await act(() => api('/platform/help/manage/settings', { method: 'PUT', body: input }), 'Settings saved.');
  done();
  return r;
}

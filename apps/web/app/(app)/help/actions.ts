'use server';
import type { HelpQueryStatus, HelpReplyInput } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { ApiError, api, apiForm } from '@/lib/api';

type Result<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; message: string; code?: string; fieldErrors?: Record<string, string> };

async function act<T>(fn: () => Promise<T>, message?: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn(), message };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, message: e.message, code: e.code, fieldErrors: e.fieldErrors };
    throw e;
  }
}

// Reading -------------------------------------------------------------------------------------------------------

export async function helpFeedbackAction(slug: string, helpful: boolean) {
  return act(() => api(`/help/articles/${encodeURIComponent(slug)}/feedback`, { method: 'PUT', body: { helpful } }));
}

export async function helpProgressAction(slug: string, step: number, done: boolean) {
  return act(() => api(`/help/articles/${encodeURIComponent(slug)}/progress`, { method: 'PUT', body: { step, done } }));
}

// Raising and following my queries -----------------------------------------------------------------------------

export async function helpUploadAction(form: FormData) {
  return act(() => apiForm<{ id: string; name: string; type: string; size: number }>('/help/files', form));
}

export async function raiseQueryAction(input: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; ticketId: string; routeLabel: string; created: boolean }>('/help/queries', { method: 'POST', body: input }));
  revalidatePath('/help');
  return r;
}

export async function myReplyAction(id: string, input: Partial<HelpReplyInput> & { body: string }) {
  const r = await act(() => api(`/help/queries/${id}/replies`, { method: 'POST', body: { body: input.body, fileIds: input.fileIds ?? [], clientId: input.clientId } }));
  revalidatePath(`/help/queries/${id}`);
  return r;
}

export async function myStatusAction(id: string, status: HelpQueryStatus, note?: string | null) {
  const r = await act(() => api(`/help/queries/${id}/status`, { method: 'PUT', body: { status, note: note ?? null } }));
  revalidatePath(`/help/queries/${id}`);
  return r;
}

export async function rateQueryAction(id: string, rating: number, comment: string | null) {
  const r = await act(() => api(`/help/queries/${id}/rating`, { method: 'POST', body: { rating, comment } }));
  revalidatePath(`/help/queries/${id}`);
  return r;
}

// Answering (HR Workspace and Super Workspace) -------------------------------------------------------------------

export async function inboxReplyAction(id: string, input: Partial<HelpReplyInput> & { body: string }) {
  const r = await act(() => api(`/help/inbox/${id}/replies`, { method: 'POST', body: { ...input, fileIds: input.fileIds ?? [] } }));
  revalidatePath(`/help/inbox/${id}`);
  return r;
}

export async function inboxStatusAction(id: string, status: HelpQueryStatus, note?: string | null) {
  const r = await act(() => api(`/help/inbox/${id}/status`, { method: 'PUT', body: { status, note: note ?? null } }));
  revalidatePath('/help/inbox');
  return r;
}

export async function inboxAssignAction(id: string, assigneeId: string | null) {
  return act(() => api(`/help/inbox/${id}/assignee`, { method: 'PUT', body: { assigneeId } }));
}

export async function inboxEscalateAction(id: string, reason: string) {
  const r = await act(() => api(`/help/inbox/${id}/escalate`, { method: 'POST', body: { reason } }));
  revalidatePath('/help/inbox');
  return r;
}

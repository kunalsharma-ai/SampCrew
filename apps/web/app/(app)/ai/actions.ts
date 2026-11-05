'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { AssistantAnswer, ReplyDraft } from './types';

export async function askAssistantAction(question: string) {
  return act(() => api<AssistantAnswer>('/ai/assistant', { method: 'POST', body: { question } }));
}

export async function aiFeedbackAction(id: string, helpful: boolean) {
  return act(() => api(`/ai/interactions/${id}/feedback`, { method: 'POST', body: { helpful } }), 'Thanks for the feedback.');
}

export async function draftReplyAction(caseId: string) {
  return act(() => api<ReplyDraft>(`/ai/helpdesk/cases/${caseId}/draft`, { method: 'POST' }), 'Draft ready. Check and edit it before sending.');
}

export async function saveAiSettingsAction(body: { features: Record<string, boolean>; promptLogDays: number }) {
  const r = await act(() => api('/ai/settings', { method: 'PUT', body }), 'AI settings saved.');
  revalidatePath('/settings/ai');
  return r;
}

'use server';
import type { IqAnswer, IqConversation, IqMessage } from '@crew/contracts';
import { act, api } from '@/lib/api';

export async function askIqAction(question: string, path: string, conversationId?: string | null) {
  return act(() => api<IqAnswer>('/iq/ask', { method: 'POST', body: { question, path: path.slice(0, 200), ...(conversationId ? { conversationId } : {}) } }));
}

export async function iqConversationsAction() {
  return act(() => api<IqConversation[]>('/iq/conversations'));
}

export async function iqConversationAction(id: string) {
  return act(() => api<{ id: string; title: string; messages: IqMessage[] }>(`/iq/conversations/${id}`));
}

export async function forgetIqAction(id: string | null) {
  return act(() => api<{ deleted: number }>(id ? `/iq/conversations/${id}` : '/iq/conversations', { method: 'DELETE' }));
}

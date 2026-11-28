'use server';
import { act, api } from '@/lib/api';
import type { ConversationDetail, ConversationList } from './communication/types';

/** The small SampCrew chat in the corner: the person's conversations, and one conversation's latest messages. */
export async function widgetConversationsAction() {
  return act(() => api<ConversationList>('/communication/conversations'));
}

export async function widgetConversationAction(id: string) {
  return act(() => api<ConversationDetail>(`/communication/conversations/${id}?limit=40`));
}

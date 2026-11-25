'use server';
import type { AudienceInput, ChatMessageView, CommFile, EmailDraftInput, SenderIdentity } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';
import type { Person } from './types';

// Chat --------------------------------------------------------------------------------------------------------

export async function openConversationAction(body: Record<string, unknown>) {
  return act(() => api<{ id: string; created: boolean }>('/communication/conversations', { method: 'POST', body }));
}

export async function sendMessageAction(conversationId: string, body: string, fileIds: string[], clientId: string) {
  return act(() => api<ChatMessageView>(`/communication/conversations/${conversationId}/messages`, { method: 'POST', body: { body, fileIds, clientId } }));
}

export async function markReadAction(conversationId: string) {
  return act(() => api(`/communication/conversations/${conversationId}/read`, { method: 'POST' }));
}

export async function deliveredAction() {
  return act(() => api('/communication/delivered', { method: 'POST' }));
}

export async function deleteMessageAction(conversationId: string, messageId: string) {
  return act(() => api(`/communication/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' }), 'Message deleted.');
}

export async function manageConversationAction(conversationId: string, body: { title?: string; add?: string[]; remove?: string[] }) {
  const r = await act(() => api(`/communication/conversations/${conversationId}`, { method: 'PUT', body }), 'Saved.');
  revalidatePath(`/communication/chat/${conversationId}`);
  return r;
}

export async function leaveConversationAction(conversationId: string) {
  return act(() => api(`/communication/conversations/${conversationId}/leave`, { method: 'POST' }), 'You left the group.');
}

export async function muteAction(conversationId: string, muted: boolean) {
  const r = await act(() => api(`/communication/conversations/${conversationId}/mute`, { method: 'PUT', body: { muted } }), muted ? 'Muted. Messages still arrive, without notifications.' : 'Notifications are on again.');
  revalidatePath(`/communication/chat/${conversationId}`);
  return r;
}

export async function searchMessagesAction(q: string) {
  return act(() => api<{ items: { messageId: string; conversationId: string; conversationTitle: string; senderName: string | null; sender: SenderIdentity | null; body: string; createdAt: string }[] }>(`/communication/search?q=${encodeURIComponent(q)}`));
}

export async function peopleAction(q: string) {
  return act(() => api<{ items: Person[] }>(`/communication/people?q=${encodeURIComponent(q)}`));
}

export async function uploadFileAction(form: FormData) {
  return act(() => apiForm<CommFile>('/communication/files', form));
}

// Email -------------------------------------------------------------------------------------------------------

export async function saveDraftAction(id: string | null, body: EmailDraftInput) {
  const r = await act(() => api<{ id: string }>(id ? `/communication/emails/${id}` : '/communication/emails', { method: id ? 'PUT' : 'POST', body }), 'Draft saved.');
  revalidatePath('/communication/emails');
  return r;
}

export async function sendEmailAction(id: string | null, body: EmailDraftInput) {
  const r = await act(() => api<{ id: string; recipients: number }>(id ? `/communication/emails/${id}/send` : '/communication/emails/send', { method: 'POST', body }));
  revalidatePath('/communication/emails');
  revalidatePath('/communication');
  return r;
}

export async function deleteDraftAction(id: string) {
  const r = await act(() => api(`/communication/emails/${id}`, { method: 'DELETE' }), 'Draft deleted.');
  revalidatePath('/communication/emails');
  return r;
}

export async function previewAudienceAction(body: AudienceInput) {
  return act(() => api<{ count: number; label: string; sample: string[] }>('/communication/audience/preview', { method: 'POST', body }));
}

// Groups ------------------------------------------------------------------------------------------------------

export async function saveGroupAction(id: string | null, body: { name: string; description: string; membershipIds: string[] }) {
  const r = await act(() => api<{ id: string }>(id ? `/communication/groups/${id}` : '/communication/groups', { method: id ? 'PUT' : 'POST', body }), 'Group saved.');
  revalidatePath('/communication/groups');
  return r;
}

/** Opens the group's chat (made the first time) and returns its id, so the page can go straight to it. */
export async function groupChatAction(id: string) {
  const r = await act(() => api<{ id: string; created: boolean }>(`/communication/groups/${id}/chat`, { method: 'POST' }), 'Group chat opened.');
  revalidatePath('/communication/groups');
  revalidatePath('/communication/chat');
  return r;
}

export async function archiveGroupAction(id: string) {
  const r = await act(() => api(`/communication/groups/${id}`, { method: 'DELETE' }), 'Group removed.');
  revalidatePath('/communication/groups');
  return r;
}

/** Message actions (issue #86): edit, undo a delete, and emoji reactions. */
export async function editMessageAction(conversationId: string, messageId: string, body: string) {
  return act(() => api<ChatMessageView>(`/communication/conversations/${conversationId}/messages/${messageId}`, { method: 'PATCH', body: { body } }), 'Message edited.');
}

export async function restoreMessageAction(conversationId: string, messageId: string) {
  return act(() => api<ChatMessageView>(`/communication/conversations/${conversationId}/messages/${messageId}/restore`, { method: 'POST' }), 'Message restored.');
}

export async function reactAction(conversationId: string, messageId: string, emoji: string) {
  return act(() => api<ChatMessageView>(`/communication/conversations/${conversationId}/messages/${messageId}/reactions`, { method: 'PUT', body: { emoji } }));
}

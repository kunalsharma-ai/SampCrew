'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { WebhookEndpoint } from './types';

const BASE = '/settings/integrations';
const done = <T,>(r: T) => {
  revalidatePath(BASE, 'layout');
  return r;
};

export async function createApiKeyAction(body: { name: string; scopes: string[]; expiresInDays: number | null }) {
  return done(await act(() => api<{ id: string; key: string; prefix: string }>('/integrations/api-keys', { method: 'POST', body }), 'API key created'));
}
export async function revokeApiKeyAction(id: string) {
  return done(await act(() => api(`/integrations/api-keys/${id}/revoke`, { method: 'POST' }), 'API key revoked. It stopped working at once.'));
}

export async function createWebhookAction(body: { name: string; url: string; events: string[] }) {
  return done(await act(() => api<WebhookEndpoint & { secret: string }>('/integrations/webhooks', { method: 'POST', body }), 'Endpoint added'));
}
export async function updateWebhookAction(id: string, body: { name: string; url: string; events: string[] }) {
  return done(await act(() => api(`/integrations/webhooks/${id}`, { method: 'PUT', body }), 'Endpoint saved'));
}
export async function webhookControlAction(id: string, what: 'enable' | 'pause' | 'test') {
  const msg = { enable: 'Endpoint switched on', pause: 'Endpoint paused. Nothing new is queued for it.', test: 'Test event queued. It is sent within a few seconds.' }[what];
  return done(await act(() => api(`/integrations/webhooks/${id}/${what}`, { method: 'POST' }), msg));
}
export async function rotateWebhookSecretAction(id: string) {
  return done(await act(() => api<{ secret: string }>(`/integrations/webhooks/${id}/rotate-secret`, { method: 'POST' }), 'New signing secret created'));
}
export async function deleteWebhookAction(id: string) {
  return done(await act(() => api(`/integrations/webhooks/${id}`, { method: 'DELETE' }), 'Endpoint deleted'));
}
export async function redeliverAction(id: string) {
  return done(await act(() => api(`/integrations/deliveries/${id}/redeliver`, { method: 'POST' }), 'Queued to send again'));
}

export async function connectSlackAction(body: { name: string; webhookUrl: string }) {
  return done(await act(() => api<{ id: string }>('/integrations/connections/slack', { method: 'POST', body }), 'Slack connected. A confirmation message was posted to the channel.'));
}
export async function testConnectionAction(id: string) {
  return done(await act(() => api(`/integrations/connections/${id}/test`, { method: 'POST' }), 'Test message posted'));
}
export async function disconnectAction(id: string) {
  return done(await act(() => api(`/integrations/connections/${id}/disconnect`, { method: 'POST' }), 'Disconnected. The stored webhook URL was deleted.'));
}

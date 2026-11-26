'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { EmailTemplates } from './types';

export async function saveEmailTemplateAction(key: string, body: { html: string; subject?: string; active: boolean; sourceFileName?: string }) {
  const r = await act(() => api<EmailTemplates>(`/settings/email-templates/${key}`, { method: 'PUT', body }), body.active ? 'Saved. Emails of this kind now use your template.' : 'Saved, switched off. Emails stay plain until you switch it on.');
  revalidatePath('/settings/email-templates');
  return r;
}

export async function resetEmailTemplateAction(key: string) {
  const r = await act(() => api<EmailTemplates>(`/settings/email-templates/${key}/reset`, { method: 'POST' }), 'Back to the standard SampCrew email. Your template is kept, switched off.');
  revalidatePath('/settings/email-templates');
  return r;
}

export async function previewEmailTemplateAction(html: string, subject?: string) {
  return act(() => api<{ subject: string; html: string }>('/settings/email-templates/preview', { method: 'POST', body: { html, ...(subject ? { subject } : {}) } }));
}

export async function testEmailTemplateAction(key: string, sendTo: string, html: string, subject?: string) {
  return act(() => api<{ ok: boolean; message: string }>(`/settings/email-templates/${key}/test`, { method: 'POST', body: { sendTo, html, ...(subject ? { subject } : {}) } }));
}

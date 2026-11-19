'use server';
import { act, api, apiForm } from '@/lib/api';
import type { PortalCase } from './types';

const valid = (t: string) => /^[A-Za-z0-9_-]{40,60}$/.test(t);

export async function sendFindingsAction(token: string, body: Record<string, unknown>) {
  if (!valid(token)) return { ok: false as const, message: 'This link is not valid' };
  const r = await act(() => api(`/bgv-portal/${token}/findings`, { method: 'POST', body, auth: false }), 'Thank you. Your findings have been sent.');
  if (!r.ok) return r;
  return { ...r, data: await api<PortalCase>(`/bgv-portal/${token}`, { auth: false }) };
}

export async function uploadReportAction(token: string, form: FormData) {
  if (!valid(token)) return { ok: false as const, message: 'This link is not valid' };
  const r = await act(() => apiForm(`/bgv-portal/${token}/report`, form, { auth: false }), 'Report uploaded.');
  if (!r.ok) return r;
  return { ...r, data: await api<PortalCase>(`/bgv-portal/${token}`, { auth: false }) };
}

'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const done = <T,>(r: T) => {
  revalidatePath('/privacy', 'layout');
  return r;
};

export async function createPrivacyRequestAction(body: { employeeId: string; kind: 'access' | 'erasure'; source: string }) {
  return done(await act(() => api<{ id: string }>('/privacy/requests', { method: 'POST', body }), 'Request logged. It is due in 30 days.'));
}
export async function prepareExportAction(id: string, note: string) {
  return done(await act(() => api(`/privacy/requests/${id}/export`, { method: 'POST', body: { note } }), 'Export prepared. Download it and send it to the person securely.'));
}
export async function eraseAction(id: string, note: string) {
  return done(await act(() => api(`/privacy/requests/${id}/erase`, { method: 'POST', body: { note } }), 'Erased. The person\'s details were removed; the records the law requires were kept.'));
}
export async function rejectPrivacyRequestAction(id: string, note: string) {
  return done(await act(() => api(`/privacy/requests/${id}/reject`, { method: 'POST', body: { note } }), 'Request closed as rejected, with your reason.'));
}
export async function saveRetentionAction(body: { exitedErasureYears: number | null; exportDays: number; signInLogDays: number }) {
  return done(await act(() => api('/privacy/retention', { method: 'PUT', body }), 'Retention schedule saved. It runs once a day.'));
}
export async function runRetentionAction() {
  return done(await act(() => api<RetentionRunResult>('/privacy/retention/run', { method: 'POST' })));
}
export interface RetentionRunResult {
  trigger: 'schedule' | 'manual';
  erased: number;
  heldByPayroll: number;
  exportsDeleted: number;
  signInStates: number;
  mobileHandoffs: number;
  provisioningCalls: number;
}

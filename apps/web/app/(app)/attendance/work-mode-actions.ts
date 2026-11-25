'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

/** Server actions for office / home / hybrid attendance. The API checks every permission and audits every change. */

const refresh = (...paths: string[]) => {
  for (const p of ['/attendance', '/attendance/work-mode', '/attendance/work-mode/register', ...paths]) revalidatePath(p);
};

export async function checkpointAction(body: { latitude?: number; longitude?: number; accuracyM?: number; locationStatus?: string }) {
  const r = await act(() => api<{ zone: { zone: string; place: { name: string } | null; verification: string; distanceM: number | null } }>('/attendance/work-mode/checkpoint', { method: 'POST', body }));
  refresh();
  return r;
}

export async function overrideAction(body: { employeeId: string; workDate: string; mode: 'office' | 'remote' | 'hybrid' | null; reason: string }) {
  const r = await act(() => api('/attendance/work-mode/override', { method: 'POST', body }), body.mode ? 'Day corrected.' : 'Correction removed.');
  refresh(`/attendance/day/${body.employeeId}/${body.workDate}`);
  return r;
}

export async function saveWorkModeSettingsAction(body: Record<string, unknown>) {
  const r = await act(() => api('/attendance/work-mode/settings', { method: 'PUT', body }), 'Settings saved.');
  refresh('/attendance/work-mode/settings');
  return r;
}

export async function saveOfficeAction(id: string, body: { latitude: number; longitude: number; radiusM: number; addressLine?: string | null; active: boolean }) {
  const r = await act(() => api(`/attendance/work-mode/offices/${id}`, { method: 'PUT', body }), 'Office location saved.');
  refresh('/attendance/offices');
  return r;
}

export async function createOfficeAction(body: { name: string; legalEntityId: string; city?: string | null; latitude: number; longitude: number; radiusM: number; addressLine?: string | null }) {
  const r = await act(() => api('/attendance/work-mode/offices', { method: 'POST', body }), 'Office added.');
  refresh('/attendance/offices');
  return r;
}

export async function saveSiteAction(id: string | null, body: Record<string, unknown>) {
  const r = await act(() => api(id ? `/attendance/work-mode/sites/${id}` : '/attendance/work-mode/sites', { method: id ? 'PUT' : 'POST', body }), id ? 'Site saved.' : 'Site added.');
  refresh('/attendance/offices');
  return r;
}

export async function archiveSiteAction(id: string) {
  const r = await act(() => api(`/attendance/work-mode/sites/${id}`, { method: 'DELETE' }), 'Site archived.');
  refresh('/attendance/offices');
  return r;
}

export async function saveWorkAssignmentsAction(body: Record<string, unknown>) {
  const r = await act(() => api('/attendance/work-mode/assignments', { method: 'PUT', body }), 'Assignments saved.');
  refresh('/attendance/offices');
  return r;
}

export async function saveNoticesAction(body: Record<string, boolean>) {
  const r = await act(() => api('/attendance/work-mode/notices', { method: 'PUT', body }), 'Notice choices saved.');
  revalidatePath('/attendance');
  return r;
}

export async function savedReportsAction() {
  return act(() => api<{ id: string; name: string; filters: Record<string, string | string[]> }[]>('/attendance/work-mode/saved-reports'));
}

export async function saveReportAction(body: { name: string; filters: Record<string, string | string[]> }) {
  return act(() => api<{ id: string }>('/attendance/work-mode/saved-reports', { method: 'POST', body }), 'Filters saved.');
}

export async function deleteReportAction(id: string) {
  return act(() => api(`/attendance/work-mode/saved-reports/${id}`, { method: 'DELETE' }), 'Saved filters deleted.');
}

export async function reportPeopleAction(date: string, q: string) {
  const p = new URLSearchParams({ date, category: 'all', pageSize: '100' });
  if (q) p.set('q', q);
  return act(() => api<{ rows: { employeeId: string; name: string; code: string; department: string | null }[] }>(`/attendance/work-mode/people?${p}`));
}

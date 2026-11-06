'use server';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { act, api } from '@/lib/api';

const refresh = () => {
  revalidatePath('/setup');
  revalidatePath('/organization');
  revalidatePath('/employees');
};

export async function saveCompanyAction(values: Record<string, unknown>) {
  const r = await act(() => api('/setup/company', { method: 'PUT', body: values }), 'Company details saved');
  refresh();
  revalidatePath('/', 'layout');
  return r;
}

export async function addLocationAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; name: string }>('/org/locations', { method: 'POST', body: values }), 'Location added');
  refresh();
  return r;
}

export async function addStructureAction(body: { departments?: { name: string; code?: string }[]; designations?: { name: string; code?: string; level?: number }[] }) {
  const r = await act(() => api<{ created: { departments: string[]; designations: string[] }; skipped: { departments: string[]; designations: string[] } }>('/setup/structure', { method: 'POST', body: { departments: [], designations: [], ...body } }));
  refresh();
  return r;
}

export async function renameAction(kind: 'department' | 'designation', id: string, name: string) {
  const path = kind === 'department' ? `/org/departments/${id}` : `/designations/${id}`;
  const r = await act(() => api(path, { method: 'PATCH', body: { name } }), 'Renamed');
  refresh();
  return r;
}

export async function removeAction(kind: 'department' | 'designation', id: string) {
  const path = kind === 'department' ? `/org/departments/${id}` : `/designations/${id}`;
  const r = await act(() => api(path, { method: 'DELETE' }), 'Removed');
  refresh();
  return r;
}

export async function progressAction(step: number) {
  return act(() => api('/setup/progress', { method: 'POST', body: { step } }));
}

/** Finishes setup and goes straight to adding the first employee. */
export async function completeSetupAction() {
  const r = await act(() => api('/setup/complete', { method: 'POST' }));
  if (!r.ok) return r;
  revalidatePath('/', 'layout');
  redirect('/employees?create=employee');
}

/** "Finish later": stop sending this browser to setup from the home page for a day. Add employee still leads here. */
export async function finishLaterAction() {
  (await cookies()).set('crew_setup_later', '1', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24, secure: process.env.SESSION_COOKIE_SECURE !== 'false' });
  redirect('/');
}

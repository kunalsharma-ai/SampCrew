'use server';
import type { FormView } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

/** Saves a form's built-in field rules (and, for Add Employee, the work email domains). Super Workspace only. */
export async function saveFormAction(key: string, body: Record<string, unknown>) {
  const r = await act(() => api<FormView>(`/forms/${encodeURIComponent(key)}`, { method: 'PUT', body }), 'Saved. The form shows it straight away for every HR Workspace and Employee Workspace.');
  revalidatePath('/settings/forms');
  revalidatePath('/employees');
  revalidatePath('/leave');
  revalidatePath('/profile');
  return r;
}

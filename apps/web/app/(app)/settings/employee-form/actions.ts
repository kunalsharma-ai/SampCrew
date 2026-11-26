'use server';
import type { EmployeeFormSettings } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function saveEmployeeFormAction(body: Record<string, unknown>) {
  const r = await act(() => api<EmployeeFormSettings>('/employee-form', { method: 'PUT', body }), 'Saved. The Add Employee form uses it straight away.');
  revalidatePath('/settings/employee-form');
  revalidatePath('/employees');
  return r;
}

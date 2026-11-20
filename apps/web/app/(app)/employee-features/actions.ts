'use server';
import type { EmployeeFeatureRow, EmployeeFeatureScope } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function setEmployeeFeaturesAction(scope: string, changes: { key: string; enabled: boolean }[]) {
  const on = changes.every((c) => c.enabled);
  const r = await act(
    () => api<{ scopes: EmployeeFeatureScope[]; scope: EmployeeFeatureScope; items: EmployeeFeatureRow[] }>('/hr-workspaces/employee-features', { method: 'PUT', body: { scope, changes } }),
    on ? 'Switched on for Employee Workspace.' : 'Switched off for Employee Workspace. Its records are kept.',
  );
  revalidatePath('/employee-features');
  return r;
}

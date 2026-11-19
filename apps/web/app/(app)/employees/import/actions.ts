'use server';
import type { ImportResult } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, apiForm } from '@/lib/api';

export async function importEmployeesAction(form: FormData, dryRun: boolean) {
  const r = await act(() => apiForm<ImportResult>(`/employees/import?dryRun=${dryRun}`, form));
  if (!dryRun) revalidatePath('/employees');
  return r;
}

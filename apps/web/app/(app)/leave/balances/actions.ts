'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { LeaveBalance } from '@/lib/types';

/** Adds or deducts days with a remark (a ledger adjustment the person is told about). */
export async function adjustLeaveAction(values: { employeeId: string; leaveTypeId: string; quantity: string; note: string }) {
  const r = await act(() => api('/leave/adjustments', { method: 'POST', body: values }), 'Balance adjusted. The person has been told.');
  revalidatePath('/leave/balances');
  return r;
}

/** The leave an employee can apply for, with their balances, so HR can apply on their behalf. */
export async function employeeBalancesAction(employeeId: string) {
  // The API answers { employeeId, year, balances }: the dialog needs the list.
  return act(async () => (await api<{ balances: LeaveBalance[] }>(`/leave/balances?employeeId=${encodeURIComponent(employeeId)}`)).balances);
}

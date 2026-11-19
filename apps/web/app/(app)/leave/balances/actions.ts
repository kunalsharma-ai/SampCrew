'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

/** Adds or deducts days with a remark (a ledger adjustment the person is told about). */
export async function adjustLeaveAction(values: { employeeId: string; leaveTypeId: string; quantity: string; note: string }) {
  const r = await act(() => api('/leave/adjustments', { method: 'POST', body: values }), 'Balance adjusted. The person has been told.');
  revalidatePath('/leave/balances');
  return r;
}

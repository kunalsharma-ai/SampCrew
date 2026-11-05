'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { ReviewOutcome } from './types';

export async function recalculateAttritionAction() {
  const r = await act(() => api<{ employees: number }>('/insights/attrition/recalculate', { method: 'POST' }), 'Scores recalculated from today\'s records.');
  revalidatePath('/insights/attrition');
  return r;
}

export async function reviewAttritionAction(employeeId: string, body: { outcome: ReviewOutcome; note: string }) {
  const r = await act(() => api(`/insights/attrition/${employeeId}/reviews`, { method: 'POST', body }), 'Review recorded.');
  revalidatePath(`/insights/attrition/${employeeId}`);
  revalidatePath('/insights/attrition');
  return r;
}

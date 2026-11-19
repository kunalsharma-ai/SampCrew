'use server';
import type { ApprovalCategoryInput } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function saveApprovalChainForAction(resourceType: string, steps: unknown[]) {
  const r = await act(() => api(`/approvals/policies/${resourceType}`, { method: 'PUT', body: { steps } }), 'Approval chain saved');
  revalidatePath('/settings/approvals');
  return r;
}

export async function saveApprovalCategoryAction(existingKey: string | null, input: ApprovalCategoryInput) {
  const r = await act(() => api(existingKey ? `/approvals/categories/${existingKey}` : '/approvals/categories', { method: existingKey ? 'PUT' : 'POST', body: input }), 'Category saved');
  revalidatePath('/settings/approvals');
  revalidatePath('/approvals');
  return r;
}

export async function deleteApprovalCategoryAction(key: string) {
  const r = await act(() => api(`/approvals/categories/${key}`, { method: 'DELETE' }), 'Category removed');
  revalidatePath('/settings/approvals');
  return r;
}

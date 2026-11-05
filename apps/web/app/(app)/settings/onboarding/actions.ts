'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function saveTemplateAction(id: string | null, body: Record<string, unknown>) {
  const r = await act(() => api(id ? `/onboarding/templates/${id}` : '/onboarding/templates', { method: id ? 'PUT' : 'POST', body }), 'Checklist saved');
  revalidatePath('/settings/onboarding');
  return r;
}

export async function archiveTemplateAction(id: string) {
  const r = await act(() => api(`/onboarding/templates/${id}`, { method: 'DELETE' }), 'Archived');
  revalidatePath('/settings/onboarding');
  return r;
}

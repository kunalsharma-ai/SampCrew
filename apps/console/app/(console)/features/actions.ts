'use server';
import type { PlatformFeatureRow } from '@crew/contracts';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function setPlatformFeaturesAction(changes: { key: string; state: 'active' | 'off' }[], reason?: string) {
  const on = changes.every((c) => c.state === 'active');
  const r = await act(
    () => api<{ items: PlatformFeatureRow[]; counts: Record<string, number> }>('/platform/features', { method: 'PUT', body: { changes, ...(reason ? { reason } : {}) } }),
    on ? 'Active for every company whose plan includes it.' : 'Switched off for every company. Their records are kept.',
  );
  revalidatePath('/features');
  return r;
}

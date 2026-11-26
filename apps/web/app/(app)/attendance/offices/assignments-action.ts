'use server';
import { act, api } from '@/lib/api';

export async function assignmentsAction(placeId?: string) {
  return act(() => api<{ rows: unknown[] }>(`/attendance/work-mode/assignments${placeId ? `?placeId=${placeId}` : ''}`));
}

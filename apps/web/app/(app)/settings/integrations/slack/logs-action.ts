'use server';
import { act, api } from '@/lib/api';
import type { ConnectionLog } from '../types';

export async function loadConnectionLogsAction(id: string) {
  return act(() => api<ConnectionLog[]>(`/integrations/connections/${id}/logs`));
}

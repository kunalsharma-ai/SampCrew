'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { RewardRule } from '@/lib/types';

const refresh = () => {
  revalidatePath('/settings/attendance');
  revalidatePath('/');
};

export async function saveRewardRuleAction(id: string | null, body: Record<string, unknown>) {
  const r = await act(() => (id ? api<RewardRule>(`/workspace/reward-rules/${id}`, { method: 'PUT', body }) : api<RewardRule>('/workspace/reward-rules', { method: 'POST', body })), 'Reward saved.');
  refresh();
  return r;
}

export async function deleteRewardRuleAction(id: string) {
  const r = await act(() => api(`/workspace/reward-rules/${id}`, { method: 'DELETE' }), 'Reward removed.');
  refresh();
  return r;
}

export async function addDefaultRewardsAction() {
  const r = await act(() => api<RewardRule[]>('/workspace/reward-rules/defaults', { method: 'POST' }), 'Perfect attendance and Always on time added, with sick leave excused.');
  refresh();
  return r;
}

export async function grantRewardsAction(month: string, ruleId?: string) {
  const r = await act(() => api<{ granted: number }>('/workspace/reward-winners/grant', { method: 'POST', body: { month, ...(ruleId ? { ruleId } : {}) } }));
  if (r.ok) r.message = r.data?.granted ? `Granted to ${r.data.granted} ${r.data.granted === 1 ? 'winner' : 'winners'}. Each one has been told.` : 'Everyone who earned it has it already.';
  refresh();
  revalidatePath('/payroll');
  return r;
}

export async function revokeRewardGrantAction(id: string, reason: string) {
  const r = await act(() => api(`/workspace/reward-grants/${id}/revoke`, { method: 'POST', body: { reason } }), 'Reward taken back.');
  refresh();
  return r;
}

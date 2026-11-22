'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { LeaveAllocation, LeaveType } from '@/lib/types';

const done = <T,>(r: T) => {
  revalidatePath('/leave/manage');
  revalidatePath('/leave');
  return r;
};

export const createLeaveTypeAction = async (body: Record<string, unknown>) =>
  done(await act(() => api<LeaveType>('/leave/types', { method: 'POST', body }), 'Leave type created'));
export const updateLeaveTypeAction = async (id: string, body: Record<string, unknown>) =>
  done(await act(() => api<LeaveType>(`/leave/types/${id}`, { method: 'PATCH', body }), 'Leave type saved'));
export const setLeaveTypeStatusAction = async (id: string, active: boolean, reason: string) =>
  done(await act(() => api<LeaveType>(`/leave/types/${id}/status`, { method: 'POST', body: { active, reason } }), active ? 'Leave type activated' : 'Leave type deactivated'));
export const deleteLeaveTypeAction = async (id: string) => done(await act(() => api(`/leave/types/${id}`, { method: 'DELETE' }), 'Leave type removed'));
export const addStarterTypesAction = async () =>
  done(await act(() => api<{ added: string[]; skipped: string[] }>('/leave/types/starter', { method: 'POST', body: {} })));
export const addTemplatesAction = async (codes: string[]) =>
  done(await act(() => api<{ added: string[]; skipped: string[] }>('/leave/types/standard', { method: 'POST', body: { codes } })));
export const leaveTypeAction = async (id: string) => act(() => api<LeaveType>(`/leave/types/${id}`));

export const previewAllocationAction = async (body: Record<string, unknown>) =>
  act(() => api<{ count: number; people: { id: string; name: string; code: string }[] }>('/leave/allocations/preview', { method: 'POST', body }));
export const allocateAction = async (body: Record<string, unknown>) => done(await act(() => api<LeaveAllocation>('/leave/allocations', { method: 'POST', body }), 'Allocated'));
export const revokeAllocationAction = async (id: string, reason: string) =>
  done(await act(() => api(`/leave/allocations/${id}/revoke`, { method: 'POST', body: { reason } }), 'Allocation withdrawn'));

export async function decideLeaveAction(approvalId: string, decision: 'approve' | 'reject', comment?: string) {
  const r = await act(() => api<{ status: string }>(`/approvals/${approvalId}/${decision}`, { method: 'POST', body: comment ? { comment } : {} }), decision === 'approve' ? 'Approved' : 'Rejected');
  revalidatePath('/approvals');
  return done(r);
}

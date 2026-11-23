'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { LeaveType } from '@/lib/types';

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
export const setLeaveVisibilityAction = async (id: string, visibility: 'hr' | 'employee' | 'both') =>
  done(await act(() => api<LeaveType>(`/leave/types/${id}/visibility`, { method: 'PUT', body: { visibility } }), 'Visibility saved'));
export const leaveTypeAction = async (id: string) => act(() => api<LeaveType>(`/leave/types/${id}`));

export const assignQuantityAction = async (body: { employeeId: string; leaveTypeId: string; year: number; quantity: string; note?: string }) =>
  done(await act(() => api<{ assigned: string | null; used: string; remaining: string | null }>('/leave/quantities', { method: 'PUT', body }), 'Quantity saved'));

export async function decideLeaveAction(approvalId: string, decision: 'approve' | 'reject', comment?: string) {
  const r = await act(() => api<{ status: string }>(`/approvals/${approvalId}/${decision}`, { method: 'POST', body: comment ? { comment } : {} }), decision === 'approve' ? 'Approved' : 'Rejected');
  revalidatePath('/approvals');
  return done(r);
}

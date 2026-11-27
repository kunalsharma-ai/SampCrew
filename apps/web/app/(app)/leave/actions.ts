'use server';
import { revalidatePath } from 'next/cache';
import { act, api, apiForm } from '@/lib/api';

export type LeaveRoute = 'hr' | 'super' | 'both';
export interface Preview {
  days: string; tracked: boolean; available: string | null; balanceAfter: string | null; holidaysInRange: string[]; warnings: string[];
  documents?: { mode: 'none' | 'optional' | 'required'; required: boolean; note: string | null };
  routes?: { route: LeaveRoute; label: string; reviewers: string[] }[]; employeeChooses?: boolean; order?: 'simultaneous' | 'sequential'; managerFirst?: boolean;
  route?: LeaveRoute; routeLabel?: string; reviewers?: string[];
}

/** A supporting document for an application; its id goes on the request as documentIds. */
export async function uploadLeaveDocumentAction(form: FormData) {
  return act(() => apiForm<{ id: string; name: string; size: number }>('/leave/documents', form));
}

export async function previewLeaveAction(values: Record<string, unknown>) {
  return act(() => api<Preview>('/leave/requests/preview', { method: 'POST', body: values }));
}

export async function requestLeaveAction(values: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; waitingOn: string | null }>('/leave/requests', { method: 'POST', body: values, idempotencyKey: crypto.randomUUID() }), 'Leave requested. Your approver has been notified.');
  revalidatePath('/leave');
  return r;
}

export async function cancelLeaveAction(id: string, reason?: string) {
  const r = await act(() => api(`/leave/requests/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} }), 'Cancelled');
  revalidatePath('/leave');
  revalidatePath('/approvals');
  return r;
}

export async function decideAction(id: string, decision: 'approve' | 'reject', comment?: string) {
  const r = await act(() => api<{ status: string }>(`/approvals/${id}/${decision}`, { method: 'POST', body: comment ? { comment } : {} }));
  revalidatePath('/approvals');
  return r;
}

export async function previewModifyLeaveAction(id: string, values: Record<string, unknown>) {
  return act(() => api<Preview>(`/leave/requests/${id}/modify/preview`, { method: 'POST', body: values }));
}

/** A pending request changes and goes back for approval; a change to approved leave waits for its own approval. */
export async function modifyLeaveAction(id: string, values: Record<string, unknown>) {
  const r = await act(() => api<{ id: string; status: string; replacesRequestId: string | null }>(`/leave/requests/${id}/modify`, { method: 'POST', body: values }));
  revalidatePath('/leave');
  revalidatePath('/approvals');
  return r;
}

// Comp-off and leave rules by employment status (issue #89) ------------------------------------------------------------

export interface CompOff {
  id: string; employeeId: string; employeeName: string; workDate: string; dayKind: 'weekly_off' | 'holiday'; holidayName: string | null; days: string; reason: string;
  workedMinutes: number | null; status: string; decidedBy: string | null; comment: string | null; decidedAt: string | null; createdAt: string; canDecide: boolean;
}
export interface StatusRule { leaveTypeId: string; code: string; name: string; kind: string; probation: 'allowed' | 'no_leave'; onConfirmationDays: string | null; prorate: boolean; updatedAt: string | null }

export async function requestCompOffAction(body: { workDate: string; days: '1' | '0.5'; reason: string }) {
  const r = await act(() => api<CompOff>('/leave/comp-off', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Comp-off requested. Your manager or HR will approve it.');
  revalidatePath('/leave');
  return r;
}

export async function decideCompOffAction(id: string, decision: 'approve' | 'reject', comment?: string) {
  const r = await act(() => api<CompOff>(`/leave/comp-off/${id}/decide`, { method: 'POST', body: { decision, ...(comment ? { comment } : {}) } }), decision === 'approve' ? 'Approved. The day is added to their comp-off balance.' : 'Rejected. They have been told the reason.');
  revalidatePath('/leave/manage');
  revalidatePath('/approvals');
  return r;
}

export async function saveStatusRuleAction(leaveTypeId: string, body: { probation: 'allowed' | 'no_leave'; onConfirmationDays: string | null; prorate: boolean }) {
  const r = await act(() => api<StatusRule>(`/leave/status-rules/${leaveTypeId}`, { method: 'PUT', body }), 'Saved. It applies to new joiners and to everyone confirmed from now on.');
  revalidatePath('/leave/manage');
  return r;
}

/** The Leave request form as the Super Workspace set it up in Form management (issue #91). */
export async function leaveFormAction() {
  return act(() => api<import('@crew/contracts').FormView>('/forms/leave_request'));
}

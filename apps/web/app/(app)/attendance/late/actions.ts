'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';
import type { AttendancePenalty, DisciplinePolicy, LatePolicy, LateReminder, SameDayLeavePolicy } from '@/lib/types';

const refresh = () => {
  for (const p of ['/attendance/late', '/attendance', '/leave', '/approvals', '/settings/attendance', '/settings/leave']) revalidatePath(p);
};

export async function sendReminderAction(body: { employeeId: string; workDate: string; note?: string }) {
  const r = await act(() => api<LateReminder>('/attendance/late/reminders', { method: 'POST', body, idempotencyKey: crypto.randomUUID() }), 'Reminder sent.');
  refresh();
  return r;
}

export async function withdrawReminderAction(id: string, reason: string) {
  const r = await act(() => api<LateReminder>(`/attendance/late/reminders/${id}/withdraw`, { method: 'POST', body: { reason } }), 'Reminder withdrawn. The month’s deduction was worked out again.');
  refresh();
  return r;
}

export async function waivePenaltyAction(id: string, reason: string) {
  const r = await act(() => api<AttendancePenalty>(`/attendance/penalties/${id}/waive`, { method: 'POST', body: { reason } }), 'Penalty waived. The employee has been told.');
  refresh();
  return r;
}

export async function leavePenaltyAction(requestId: string, days: string, reason?: string) {
  const r = await act(() => api<AttendancePenalty>(`/leave/requests/${requestId}/penalty`, { method: 'POST', body: { days, ...(reason ? { reason } : {}) } }), 'Penalty applied. The employee has been told.');
  refresh();
  return r;
}

export async function saveLatePolicyAction(body: LatePolicy) {
  const r = await act(() => api<DisciplinePolicy>('/attendance/late/policy', { method: 'PUT', body }), 'Late-coming rules saved.');
  refresh();
  return r;
}

export async function saveSameDayPolicyAction(body: SameDayLeavePolicy) {
  const r = await act(() => api<DisciplinePolicy>('/leave/same-day-policy', { method: 'PUT', body }), 'Same-day leave rule saved.');
  refresh();
  return r;
}

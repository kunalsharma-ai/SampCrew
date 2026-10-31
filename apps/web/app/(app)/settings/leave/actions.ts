'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const done = <T,>(r: T) => {
  revalidatePath('/settings/leave');
  return r;
};

export const saveLeaveTypeAction = async (id: string | null, v: Record<string, unknown>) =>
  done(await act(() => api(id ? `/leave/types/${id}` : '/leave/types', { method: id ? 'PATCH' : 'POST', body: v }), 'Saved'));
export const archiveLeaveTypeAction = async (id: string) => done(await act(() => api(`/leave/types/${id}`, { method: 'DELETE' }), 'Archived'));
export const savePolicyAction = async (v: Record<string, unknown>) => done(await act(() => api('/leave/policies', { method: 'POST', body: v }), 'Policy saved'));
export const removePolicyAction = async (id: string) => done(await act(() => api(`/leave/policies/${id}`, { method: 'DELETE' }), 'Removed'));
export const saveCalendarAction = async (id: string | null, v: Record<string, unknown>) =>
  done(await act(() => api(id ? `/leave/calendars/${id}` : '/leave/calendars', { method: id ? 'PUT' : 'POST', body: v }), 'Saved'));
export const deleteCalendarAction = async (id: string) => done(await act(() => api(`/leave/calendars/${id}`, { method: 'DELETE' }), 'Deleted'));
export const addHolidayAction = async (calendarId: string, v: Record<string, unknown>) =>
  done(await act(() => api(`/leave/calendars/${calendarId}/holidays`, { method: 'POST', body: v }), 'Holiday added'));
export const removeHolidayAction = async (calendarId: string, id: string) => done(await act(() => api(`/leave/calendars/${calendarId}/holidays/${id}`, { method: 'DELETE' })));
export const runAccrualsAction = async () => done(await act(() => api<{ posted: number; asOf: string }>('/leave/accruals/run', { method: 'POST', body: {} })));
export const closeYearAction = async (year: number) => done(await act(() => api<{ carried: number; lapsed: number }>('/leave/year-end', { method: 'POST', body: { year } })));
export const saveApprovalChainAction = async (steps: unknown[]) =>
  done(await act(() => api('/approvals/policies/leave_request', { method: 'PUT', body: { steps } }), 'Approval chain saved'));

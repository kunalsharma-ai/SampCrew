'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function saveHrAttendanceAccess(body: { hrWorkspaceId: string; permissions: Record<string, boolean>; otherHrWorkspaceIds: string[] | null }) {
  const r = await act(() => api('/attendance/access/hr-workspace', { method: 'PUT', body }), 'Attendance permissions saved');
  revalidatePath('/settings/attendance-access');
  return r;
}

export async function saveEmployeeAttendanceAccess(permissions: Record<string, boolean>) {
  const r = await act(() => api('/attendance/access/employee-workspace', { method: 'PUT', body: { permissions } }), 'Attendance permissions saved');
  revalidatePath('/settings/attendance-access');
  return r;
}

'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const done = <T,>(r: T) => {
  revalidatePath('/settings/leave');
  return r;
};

export const saveCalendarAction = async (id: string | null, v: Record<string, unknown>) =>
  done(await act(() => api(id ? `/leave/calendars/${id}` : '/leave/calendars', { method: id ? 'PUT' : 'POST', body: v }), 'Saved'));
export const deleteCalendarAction = async (id: string) => done(await act(() => api(`/leave/calendars/${id}`, { method: 'DELETE' }), 'Deleted'));
export const addHolidayAction = async (calendarId: string, v: Record<string, unknown>) =>
  done(await act(() => api(`/leave/calendars/${calendarId}/holidays`, { method: 'POST', body: v }), 'Holiday added'));
export const removeHolidayAction = async (calendarId: string, id: string) => done(await act(() => api(`/leave/calendars/${calendarId}/holidays/${id}`, { method: 'DELETE' })));

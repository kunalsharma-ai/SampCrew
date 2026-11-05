'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

export async function signOutDeviceAction(id: string) {
  const r = await act(() => api(`/mobile/devices/${id}/sign-out`, { method: 'POST' }), 'Phone signed out.');
  revalidatePath('/settings/security');
  return r;
}

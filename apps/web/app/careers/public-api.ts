import 'server-only';
import { notFound } from 'next/navigation';
import { api, ApiError } from '@/lib/api';

/** Public career site reads: no session, and a missing or switched-off site is a plain 404. */
export async function publicLoad<T>(path: string): Promise<T> {
  try {
    return await api<T>(path, { auth: false });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

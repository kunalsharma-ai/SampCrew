'use server';
import { redirect } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { clearSession, setSession, type TokenPair } from '@/lib/session';

export async function logoutAction() {
  await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
  await clearSession();
  redirect('/login');
}

export async function switchTenantAction(tenantId: string) {
  try {
    const t = await api<TokenPair>('/auth/switch-tenant', { method: 'POST', body: { tenantId } });
    await setSession(t);
  } catch (e) {
    if (e instanceof ApiError) return { ok: false as const, message: e.message };
    throw e;
  }
  redirect('/');
}

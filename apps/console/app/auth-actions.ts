'use server';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { act, api } from '@/lib/api';
import { clearSession, setSession, type TokenPair } from '@/lib/session';

type LoginResult = ({ status: 'ok'; mfaEnrolmentRequired: boolean } & TokenPair) | { status: 'mfa_required' };

export async function loginAction(input: { email: string; password: string; code?: string }) {
  const r = await act(() => api<LoginResult>('/platform/auth/login', { method: 'POST', body: { ...input, code: input.code || undefined }, auth: false }));
  if (!r.ok) return r;
  const d = r.data!;
  if (d.status === 'mfa_required') return { ok: true as const, data: { step: 'mfa' as const } };
  await setSession(d);
  return { ok: true as const, data: { step: d.mfaEnrolmentRequired ? ('enrol' as const) : ('done' as const) } };
}

export async function mfaSetupAction() {
  return act(async () => {
    const r = await api<{ secret: string; otpauthUri: string }>('/platform/auth/mfa/setup', { method: 'POST' });
    return { secret: r.secret, qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 200 }) };
  });
}

export async function mfaEnableAction(code: string) {
  const r = await act(() => api<TokenPair>('/platform/auth/mfa/enable', { method: 'POST', body: { code } }));
  if (!r.ok) return r;
  await setSession(r.data!);
  redirect('/');
}

export async function changePasswordAction(input: { currentPassword: string; newPassword: string }) {
  const r = await act(() => api('/platform/auth/password', { method: 'POST', body: input }));
  if (!r.ok) return r;
  redirect('/');
}

export async function logoutAction() {
  await api('/platform/auth/logout', { method: 'POST' }).catch(() => undefined);
  await clearSession();
  redirect('/login');
}

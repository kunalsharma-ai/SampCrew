'use server';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { act, api } from '@/lib/api';
import { clearSession, sessionCookieProblem, setSession, type TokenPair } from '@/lib/session';

type LoginResult = ({ status: 'ok'; mfaEnrolmentRequired: boolean } & TokenPair) | { status: 'mfa_required' };

export async function loginAction(input: { email: string; password: string; code?: string }) {
  // On a plain http address the browser drops the Secure session cookies; say so instead of returning to sign-in.
  const problem = await sessionCookieProblem();
  if (problem) return { ok: false as const, code: 'insecure_address', message: problem };
  const r = await act(() => api<LoginResult>('/platform/auth/login', { method: 'POST', body: { ...input, code: input.code || undefined }, auth: false }));
  if (!r.ok) return r;
  const d = r.data!;
  if (d.status === 'mfa_required') return { ok: true as const, data: { step: 'mfa' as const } };
  await setSession(d);
  return { ok: true as const, data: { step: d.mfaEnrolmentRequired ? ('enrol' as const) : ('done' as const) } };
}

/** First-run setup: creates the first Super admin with the setup code, then signs them in (two-step setup follows). */
export async function firstAdminAction(input: { setupCode: string; fullName: string; email: string; password: string }) {
  const problem = await sessionCookieProblem();
  if (problem) return { ok: false as const, code: 'insecure_address', message: problem };
  const r = await act(() => api<{ email: string }>('/platform/setup/first-admin', { method: 'POST', body: input, auth: false }));
  if (!r.ok) return r;
  return loginAction({ email: r.data!.email, password: input.password });
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

/** Console forgot password: emails a link and a 6-digit code. Same answer whether or not the admin exists. */
export async function requestPasswordResetAction(email: string) {
  return act(() => api<{ message: string }>('/platform/auth/password-reset/request', { method: 'POST', body: { email }, auth: false }));
}

/** Sets a new Console password with the emailed link, or the email and the 6-digit code. Two-step sign-in still follows. */
export async function completePasswordResetAction(input: { token?: string; email?: string; code?: string; newPassword: string }) {
  return act(() => api<{ message: string }>('/platform/auth/password-reset/complete', { method: 'POST', body: input, auth: false }));
}

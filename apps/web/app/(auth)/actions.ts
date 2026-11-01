'use server';
import { redirect } from 'next/navigation';
import { act, api, type ActionResult } from '@/lib/api';
import { setSession, type TokenPair } from '@/lib/session';

type LoginStep = ({ status: 'ok' } & TokenPair) | { status: 'mfa_required'; mfaToken: string } | { status: 'select_tenant'; tenants: { id: string; name: string; slug: string }[]; selectToken: string };

async function finish(step: LoginStep): Promise<ActionResult<LoginStep>> {
  if (step.status === 'ok') {
    await setSession(step);
    return { ok: true, data: { status: 'ok' } as LoginStep };
  }
  return { ok: true, data: step };
}

export async function loginAction(input: { email: string; password: string; tenantSlug?: string }) {
  const r = await act(() => api<LoginStep>('/auth/login', { method: 'POST', body: { ...input, tenantSlug: input.tenantSlug || undefined }, auth: false }));
  return r.ok ? finish(r.data!) : r;
}

export async function verifyMfaAction(input: { mfaToken: string; code: string }) {
  const r = await act(() => api<LoginStep>('/auth/mfa/verify', { method: 'POST', body: input, auth: false }));
  return r.ok ? finish(r.data!) : r;
}

export async function selectTenantAction(input: { selectToken: string; tenantId: string }) {
  const r = await act(() => api<LoginStep>('/auth/select-tenant', { method: 'POST', body: input, auth: false }));
  return r.ok ? finish(r.data!) : r;
}

/** Asks the API where to send the browser for single sign-on. The browser then leaves CREW for the identity provider. */
export async function ssoStartAction(email: string) {
  return act(() => api<{ authorizationUrl: string }>('/auth/sso/start', { method: 'POST', body: { email }, auth: false }));
}

export async function signupAction(input: Record<string, unknown>) {
  const r = await act(() => api<TokenPair>('/auth/signup', { method: 'POST', body: input, auth: false }));
  if (!r.ok) return r;
  await setSession(r.data!);
  redirect('/?welcome=1');
}

export async function acceptInviteAction(input: { token: string; fullName: string; password: string }) {
  const r = await act(() => api<TokenPair>('/auth/invitations/accept', { method: 'POST', body: input, auth: false }));
  if (!r.ok) return r;
  await setSession(r.data!);
  redirect('/?welcome=1');
}

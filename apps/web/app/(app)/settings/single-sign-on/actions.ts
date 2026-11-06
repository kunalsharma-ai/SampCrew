'use server';
import { revalidatePath } from 'next/cache';
import { act, api } from '@/lib/api';

const done = <T,>(r: T) => {
  revalidatePath('/settings/single-sign-on');
  return r;
};

type SsoBody =
  | { protocol: 'oidc'; issuer: string; clientId: string; clientSecret?: string; domains: string[]; jitProvisioning: boolean }
  | { protocol: 'saml'; idpEntityId: string; ssoUrl: string; certificate?: string; domains: string[]; jitProvisioning: boolean };

export async function saveSsoAction(body: SsoBody) {
  const msg = body.protocol === 'oidc' ? 'Saved. SampCrew reached the provider and read its settings.' : 'Saved. The certificate is valid; run a test sign-in next.';
  return done(await act(() => api('/security/sso', { method: 'PUT', body }), msg));
}
export async function mapScimGroupAction(groupId: string, roleId: string | null) {
  return done(await act(() => api(`/security/scim/groups/${groupId}/role`, { method: 'PUT', body: { roleId } }), roleId ? 'Role granted to the group\'s members.' : 'The group no longer grants a role.'));
}
export async function testSsoAction() {
  return act(() => api<{ authorizationUrl: string }>('/security/sso/test', { method: 'POST' }));
}
export async function ssoStatusAction(status: 'active' | 'disabled', enforced: boolean) {
  const msg = status === 'disabled' ? 'Single sign-on switched off. Everyone signs in with a password again.' : enforced ? 'Single sign-on is now required. Members were signed out and sign in through the provider; owners can still use a password.' : 'Single sign-on switched on. Members can use it or their password.';
  return done(await act(() => api('/security/sso/status', { method: 'POST', body: { status, enforced } }), msg));
}
export async function removeSsoAction() {
  return done(await act(() => api('/security/sso', { method: 'DELETE' }), 'Connection removed and its email domains released.'));
}
export async function createScimTokenAction() {
  return done(await act(() => api<{ token: string; prefix: string }>('/security/scim/token', { method: 'POST' }), 'SCIM token created'));
}
export async function revokeScimTokenAction() {
  return done(await act(() => api('/security/scim/token/revoke', { method: 'POST' }), 'SCIM token revoked. Provisioning stopped at once.'));
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { ssoError } from '@/lib/session';
import { type RoleOption, type ScimGroup, SsoView, type ScimStatus, type SsoState } from './sso-view';

export const metadata: Metadata = { title: 'Single sign-on' };

export default async function SingleSignOnPage({ searchParams }: { searchParams: Promise<{ tested?: string; failed?: string }> }) {
  const sp = await searchParams;
  const [sso, scim, groups, roles] = await Promise.all([
    load<SsoState>('/security/sso'),
    load<ScimStatus>('/security/scim'),
    load<ScimGroup[]>('/security/scim/groups'),
    load<RoleOption[]>('/roles'),
  ]);
  // A group may grant any role except the owner role.
  const grantable = roles.filter((r) => r.key !== 'tenant_owner').map(({ id, key, name }) => ({ id, key, name }));
  const failure = sp.failed ? ((await ssoError()) ?? 'The test sign-in did not complete.') : null;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Single sign-on and provisioning"
        description="Let people sign in through your identity provider (OpenID Connect or SAML 2.0, for example Microsoft Entra ID, Okta or Google Workspace), and create, deactivate and group their accounts from it with SCIM. Only workspace owners can change these, and every change is in the audit trail."
      />
      <SsoView sso={sso} scim={scim} groups={groups} roles={grantable} tested={sp.tested === '1'} failure={failure} />
    </>
  );
}

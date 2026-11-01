import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { ssoError } from '@/lib/session';
import { SsoView, type ScimStatus, type SsoState } from './sso-view';

export const metadata: Metadata = { title: 'Single sign-on' };

export default async function SingleSignOnPage({ searchParams }: { searchParams: Promise<{ tested?: string; failed?: string }> }) {
  const sp = await searchParams;
  const [sso, scim] = await Promise.all([load<SsoState>('/security/sso'), load<ScimStatus>('/security/scim')]);
  const failure = sp.failed ? ((await ssoError()) ?? 'The test sign-in did not complete.') : null;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Single sign-on and provisioning"
        description="Let people sign in through your identity provider (OpenID Connect, for example Microsoft Entra ID, Okta or Google Workspace), and create or deactivate their accounts from it with SCIM. Only workspace owners can change these, and every change is in the audit trail."
      />
      <SsoView sso={sso} scim={scim} tested={sp.tested === '1'} failure={failure} />
    </>
  );
}

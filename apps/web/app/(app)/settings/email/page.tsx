import type { TenantMailView } from '@crew/contracts';
import { Alert, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { MailSetupView } from './mail-view';

export const metadata: Metadata = { title: 'Email setup' };

/**
 * Settings > Email setup: the company's own outgoing email server, so invitations, password resets and notices reach
 * people from the company's address. Without it, SAMPLEDGE's server is used when it is set up; with neither, nothing
 * is sent and this page says so.
 */
export default async function EmailSetupPage() {
  const me = await load<Me>('/me');
  if (!can(me, 'mail:configure')) {
    return (
      <>
        <PageHeader title="Email setup" />
        <Alert tone="info">The company's email is set up by the Super Workspace or company-wide HR Workspace. Ask them to set it up.</Alert>
      </>
    );
  }
  const view = await load<TenantMailView>('/settings/mail');
  return (
    <>
      <PageHeader
        title="Email setup"
        description="Connect your company's email server so SampCrew sends invitations, verification and password reset emails, and notices from your own address."
      />
      <MailSetupView view={view} me={{ email: me.user.email }} />
    </>
  );
}

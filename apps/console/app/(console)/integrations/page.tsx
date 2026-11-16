import { PLATFORM_INTEGRATIONS, type PlatformIntegrationView } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { IntegrationsView } from './integrations-view';

export const metadata: Metadata = { title: 'Integrations' };

export default async function IntegrationsPage() {
  const [me, list] = await Promise.all([load<Admin>('/platform/auth/me'), load<PlatformIntegrationView[]>('/platform/integrations')]);
  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect the services SampCrew uses: Claude AI, email, mobile push, virus scanning, mobile sign-in, payments and off-site backups. Every key is entered here and kept only in the database, encrypted; nothing goes in the server's settings file. Changes take effect within a few seconds, with no restart, and keys are never shown again."
      />
      <IntegrationsView defs={PLATFORM_INTEGRATIONS} list={list} canManage={hasCap(me, 'integrations:manage')} />
    </>
  );
}

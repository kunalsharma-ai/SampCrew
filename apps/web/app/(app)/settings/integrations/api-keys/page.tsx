import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { ApiKey, IntegrationsCatalogue } from '../types';
import { ApiKeysView } from './api-keys-view';

export const metadata: Metadata = { title: 'API keys' };

export default async function ApiKeysPage() {
  const [keys, cat] = await Promise.all([load<ApiKey[]>('/integrations/api-keys'), load<IntegrationsCatalogue>('/integrations/catalogue')]);
  return (
    <>
      <PageHeader
        eyebrow="Integrations"
        title="API keys"
        description="Let another system read CREW data through the REST API. A key acts as the person who created it, limited to the read-only scopes you choose, and stops working if that person leaves or loses access."
      />
      <ApiKeysView keys={keys} scopes={cat.scopes} />
    </>
  );
}

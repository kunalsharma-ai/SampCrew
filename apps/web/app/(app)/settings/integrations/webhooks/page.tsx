import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { IntegrationsCatalogue, WebhookEndpoint } from '../types';
import { WebhooksView } from './webhooks-view';

export const metadata: Metadata = { title: 'Webhooks' };

export default async function WebhooksPage() {
  const [endpoints, cat] = await Promise.all([load<WebhookEndpoint[]>('/integrations/webhooks'), load<IntegrationsCatalogue>('/integrations/catalogue')]);
  return (
    <>
      <PageHeader eyebrow="Integrations" title="Webhooks" description="CREW posts a signed message to your endpoint when something happens. Messages carry ids, not personal details; your system reads what it needs through the API." />
      <WebhooksView endpoints={endpoints} catalogue={cat} />
    </>
  );
}

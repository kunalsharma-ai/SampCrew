import { PageHeader, StatusPill } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { IntegrationsCatalogue, WebhookDelivery, WebhookEndpoint } from '../../types';
import { EndpointDetail } from './endpoint-detail';

export const metadata: Metadata = { title: 'Webhook endpoint' };

export default async function WebhookPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string }> }) {
  const { id } = await params;
  const { status } = await searchParams;
  const q = status && ['pending', 'sending', 'succeeded', 'failed'].includes(status) ? `?status=${status}` : '';
  const [w, deliveries, cat] = await Promise.all([
    load<WebhookEndpoint>(`/integrations/webhooks/${id}`),
    load<WebhookDelivery[]>(`/integrations/webhooks/${id}/deliveries${q}`),
    load<IntegrationsCatalogue>('/integrations/catalogue'),
  ]);
  return (
    <>
      <PageHeader eyebrow="Webhooks" title={<span className="flex items-center gap-3">{w.name} <StatusPill status={w.status} /></span>} description={<span className="font-mono">{w.url}</span>} />
      <EndpointDetail endpoint={w} deliveries={deliveries} events={cat.events.filter((e) => e.type !== 'workflow.webhook')} status={status ?? ''} />
    </>
  );
}

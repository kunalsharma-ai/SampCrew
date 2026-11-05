import { Card, CardBody, CardHeader, PageHeader, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { when } from '../../labels';
import type { WebhookDeliveryDetail } from '../../types';
import { Redeliver } from './redeliver';

export const metadata: Metadata = { title: 'Webhook delivery' };

export default async function DeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await load<WebhookDeliveryDetail>(`/integrations/deliveries/${id}`);
  return (
    <>
      <PageHeader
        eyebrow={<Link className="hover:underline" href={`/settings/integrations/webhooks/${d.endpointId}`}>{d.endpointName}</Link>}
        title={<span className="flex items-center gap-3 font-mono">{d.eventType} <StatusPill status={d.status} /></span>}
        description={`Event ${d.eventId} · ${d.attempts} of ${d.maxAttempts} attempts · queued ${when(d.createdAt)}${d.deliveredAt ? ` · delivered ${when(d.deliveredAt)}` : ''}`}
        actions={(d.status === 'failed' || d.status === 'succeeded') && <Redeliver id={d.id} />}
      />
      <div className="grid gap-6">
        <Card>
          <CardHeader title="Attempts" />
          <Table>
            <THead><tr><TH>#</TH><TH>Result</TH><TH>Answer</TH><TH>Time taken</TH><TH>When</TH></tr></THead>
            <TBody>
              {d.attemptLog.length === 0 && <TR><TD colSpan={5} className="text-fg-muted">Not tried yet.</TD></TR>}
              {d.attemptLog.map((a) => (
                <TR key={a.attempt}>
                  <TD className="tabular-nums">{a.attempt}</TD>
                  <TD><StatusPill status={a.ok ? 'succeeded' : 'failed'} /></TD>
                  <TD className="max-w-[28rem]">
                    <div>{a.statusCode ? `HTTP ${a.statusCode}` : a.error}</div>
                    {a.response && <div className="truncate font-mono text-xs text-fg-muted">{a.response}</div>}
                  </TD>
                  <TD className="tabular-nums">{a.durationMs} ms</TD>
                  <TD className="text-fg-muted">{when(a.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="What was sent" description={<span className="font-mono">POST {d.url}</span>} />
          <CardBody><pre className="overflow-x-auto rounded bg-bg-subtle p-3 font-mono text-xs">{JSON.stringify(d.payload, null, 2)}</pre></CardBody>
        </Card>
      </div>
    </>
  );
}

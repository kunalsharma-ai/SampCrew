'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { createWebhookAction } from '../actions';
import { seconds, when } from '../labels';
import { SecretOnce } from '../secret-once';
import type { IntegrationsCatalogue, WebhookEndpoint } from '../types';
import { type EndpointDraft, EndpointFields, endpointValid } from './endpoint-form';

export function WebhooksView({ endpoints, catalogue }: { endpoints: WebhookEndpoint[]; catalogue: IntegrationsCatalogue }) {
  const router = useRouter();
  const { pending, run } = useRunner();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<EndpointDraft>({ name: '', url: '', events: [] });
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; secret: string } | null>(null);
  const r = catalogue.retry;
  return (
    <div className="grid gap-6">
      {created && <SecretOnce label="signing secret" value={created.secret} onDone={() => router.push(`/settings/integrations/webhooks/${created.id}`)} />}
      <Card>
        <CardHeader title="Endpoints" action={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Add endpoint</Button>} />
        {endpoints.length ? (
          <Table>
            <THead><tr><TH>Endpoint</TH><TH>Events</TH><TH>Status</TH><TH>Last 7 days</TH><TH>Last delivered</TH></tr></THead>
            <TBody>
              {endpoints.map((w) => (
                <TR key={w.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/settings/integrations/webhooks/${w.id}`}>{w.name}</Link>
                    <div className="max-w-[22rem] truncate font-mono text-xs text-fg-muted">{w.url}</div>
                  </TD>
                  <TD className="tabular-nums">{w.events.length}</TD>
                  <TD><StatusPill status={w.status} /></TD>
                  <TD className="tabular-nums">{w.deliveries7d ?? 0}{w.failed7d ? <Badge tone="danger" className="ml-2">{w.failed7d} failed</Badge> : null}</TD>
                  <TD className="text-fg-muted">{when(w.lastDeliveredAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No endpoints yet" description="Add the address of a system that should hear about new joiners, job changes, leave, helpdesk cases or finished payroll runs." />}
      </Card>
      <Card>
        <CardHeader title="How delivery works" />
        <CardBody className="grid gap-2 text-[13px] text-fg-muted">
          <p>Each message is a JSON POST with <code className="font-mono">id</code>, <code className="font-mono">type</code>, <code className="font-mono">createdAt</code>, <code className="font-mono">workspaceId</code> and <code className="font-mono">data</code>. The <code className="font-mono">crew-signature</code> header is <code className="font-mono">t=&lt;unix time&gt;,v1=&lt;HMAC-SHA256 of "t.body" with your secret&gt;</code>. Reject messages older than {Math.round(r.toleranceSeconds / 60)} minutes.</p>
          <p>Answer with any 2xx status within 10 seconds. Otherwise CREW tries again after {r.delaysSeconds.map(seconds).join(', ')}, {r.maxAttempts} attempts in all. Use the event id to ignore repeats. An endpoint that fails 15 times in a row is switched off and its creator is told.</p>
        </CardBody>
      </Card>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add endpoint"
        description="The signing secret is shown once, right after you add it."
        size="lg"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!endpointValid(draft)} onClick={() => run(async () => {
          const res = await createWebhookAction({ name: draft.name.trim(), url: draft.url.trim(), events: draft.events });
          if (res.ok) { setCreated({ id: res.data!.id, secret: res.data!.secret }); setOpen(false); setError(null); setDraft({ name: '', url: '', events: [] }); }
          else setError(res.fieldErrors?.url ?? res.message);
          return res;
        })}>Add endpoint</Button></>}
      >
        <EndpointFields draft={draft} onChange={setDraft} events={catalogue.events.filter((e) => e.type !== 'workflow.webhook')} error={error} />
      </Dialog>
    </div>
  );
}

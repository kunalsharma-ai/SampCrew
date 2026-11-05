'use client';
import { Alert, Button, Card, CardBody, CardHeader, EmptyState, Select, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRunner } from '../../../../recruitment/use-runner';
import { deleteWebhookAction, rotateWebhookSecretAction, updateWebhookAction, webhookControlAction } from '../../actions';
import { DELIVERY_STATUS, when } from '../../labels';
import { SecretOnce } from '../../secret-once';
import type { WebhookDelivery, WebhookEndpoint, WebhookEventDef } from '../../types';
import { type EndpointDraft, EndpointFields, endpointValid } from '../endpoint-form';

export function EndpointDetail({ endpoint: w, deliveries, events, status }: { endpoint: WebhookEndpoint; deliveries: WebhookDelivery[]; events: WebhookEventDef[]; status: string }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [draft, setDraft] = useState<EndpointDraft>({ name: w.name, url: w.url, events: w.events });
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const changed = draft.name !== w.name || draft.url !== w.url || draft.events.join() !== w.events.join();
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {secret && <SecretOnce label="new signing secret" value={secret} onDone={() => setSecret(null)} />}
      {w.status === 'disabled' && <Alert tone="danger" title="Switched off">{w.statusReason} Fix the receiver, then switch it back on and send any failed deliveries again.</Alert>}
      {w.status === 'paused' && <Alert tone="warning" title="Paused">Nothing new is queued while it is paused.</Alert>}
      <div className="flex flex-wrap gap-2">
        {w.status === 'active'
          ? <Button variant="secondary" disabled={pending} onClick={() => run(() => webhookControlAction(w.id, 'pause'))}>Pause</Button>
          : <Button disabled={pending} onClick={() => run(() => webhookControlAction(w.id, 'enable'))}>Switch on</Button>}
        <Button variant="secondary" disabled={pending || w.status !== 'active'} onClick={() => run(() => webhookControlAction(w.id, 'test'), () => setTimeout(() => router.refresh(), 3000))}>Send test event</Button>
        <Button variant="secondary" disabled={pending} onClick={() => { if (confirm('Create a new signing secret? The old one stops working from the next attempt.')) run(async () => { const r = await rotateWebhookSecretAction(w.id); if (r.ok) setSecret(r.data!.secret); return r; }); }}>Rotate secret</Button>
        <Button variant="danger" disabled={pending} onClick={() => { if (confirm(`Delete "${w.name}" and its delivery log?`)) run(async () => { const r = await deleteWebhookAction(w.id); if (r.ok) router.push('/settings/integrations/webhooks'); return r; }); }}>Delete</Button>
      </div>
      <Card>
        <CardHeader
          title="Deliveries"
          description="Newest first. Open one to see what was sent and every attempt."
          action={
            <Select aria-label="Show" value={status} onChange={(e) => router.push(`?${e.target.value ? `status=${e.target.value}` : ''}`)} className="w-44">
              <option value="">All deliveries</option>
              {Object.entries(DELIVERY_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          }
        />
        {deliveries.length ? (
          <Table>
            <THead><tr><TH>Event</TH><TH>Status</TH><TH>Attempts</TH><TH>Last answer</TH><TH>Queued</TH><TH>Next try</TH></tr></THead>
            <TBody>
              {deliveries.map((d) => (
                <TR key={d.id}>
                  <TD><Link className="font-mono text-[13px] text-accent hover:underline" href={`/settings/integrations/deliveries/${d.id}`}>{d.eventType}</Link></TD>
                  <TD><StatusPill status={d.status} /></TD>
                  <TD className="tabular-nums">{d.attempts}</TD>
                  <TD className="max-w-[16rem] truncate text-fg-muted">{d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : d.lastError ?? '–'}</TD>
                  <TD className="text-fg-muted">{when(d.createdAt)}</TD>
                  <TD className="text-fg-muted">{d.status === 'pending' && d.nextAttemptAt ? when(d.nextAttemptAt) : '–'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="Nothing delivered yet" description="Send a test event, or wait for one of the events below to happen." />}
      </Card>
      <Card>
        <CardHeader title="Settings" />
        <CardBody>
          <EndpointFields draft={draft} onChange={setDraft} events={events} error={error} />
          <div className="mt-4">
            <Button loading={pending} disabled={!changed || !endpointValid(draft)} onClick={() => run(async () => {
              const r = await updateWebhookAction(w.id, { name: draft.name.trim(), url: draft.url.trim(), events: draft.events });
              setError(r.ok ? null : r.fieldErrors?.url ?? r.message);
              return r;
            })}>Save changes</Button>
          </div>
        </CardBody>
      </Card>
      <p className="text-xs text-fg-muted">Created by {w.createdBy} on {when(w.createdAt)}. <StatusPill status={w.status} /></p>
    </div>
  );
}

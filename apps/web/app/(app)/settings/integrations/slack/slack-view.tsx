'use client';
import { Alert, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useState } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { connectSlackAction, disconnectAction, testConnectionAction } from '../actions';
import { when } from '../labels';
import type { Connection, ConnectionLog } from '../types';
import { loadConnectionLogsAction } from './logs-action';

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/;

export function SlackView({ connections }: { connections: Connection[] }) {
  const { pending, notice, run } = useRunner();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [logs, setLogs] = useState<{ id: string; rows: ConnectionLog[] } | null>(null);
  const urlOk = SLACK_RE.test(url.trim());
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Connected channels" />
        {connections.length ? (
          <Table>
            <THead><tr><TH>Name</TH><TH>Status</TH><TH>Verified</TH><TH>Last used</TH><TH /></tr></THead>
            <TBody>
              {connections.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-fg-muted">Webhook <span className="font-mono">{c.display.webhook}</span> · by {c.createdBy}</div>
                    {c.status === 'error' && c.statusReason && <div className="mt-1 text-xs text-danger">{c.statusReason}</div>}
                  </TD>
                  <TD><StatusPill status={c.status} /></TD>
                  <TD className="text-fg-muted">{when(c.verifiedAt)}</TD>
                  <TD className="text-fg-muted">{when(c.lastUsedAt)}</TD>
                  <TD className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => testConnectionAction(c.id))}>Send test message</Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={async () => { if (logs?.id === c.id) return setLogs(null); const r = await loadConnectionLogsAction(c.id); setLogs({ id: c.id, rows: r.ok ? r.data ?? [] : [] }); }}>{logs?.id === c.id ? 'Hide log' : 'Log'}</Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => { if (confirm(`Disconnect "${c.name}"? The stored webhook URL is deleted.`)) run(() => disconnectAction(c.id)); }}>Disconnect</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No Slack channels connected" description="Connect a channel below, then add a “Post to Slack” step to a workflow in Automation Studio." />}
      </Card>
      {logs && (
        <Card>
          <CardHeader title="Recent calls" description="The last 100 messages sent through this connection." />
          <Table>
            <THead><tr><TH>When</TH><TH>What</TH><TH>Result</TH><TH>Time taken</TH></tr></THead>
            <TBody>
              {logs.rows.length === 0 && <TR><TD colSpan={4} className="text-fg-muted">Nothing yet.</TD></TR>}
              {logs.rows.map((l, i) => (
                <TR key={i}>
                  <TD className="text-fg-muted">{when(l.createdAt)}</TD>
                  <TD>{l.action}</TD>
                  <TD><StatusPill status={l.ok ? 'succeeded' : 'failed'} />{l.detail && <span className="ml-2 text-xs text-fg-muted">{l.detail}</span>}</TD>
                  <TD className="tabular-nums">{l.durationMs ?? '–'} ms</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <Card>
        <CardHeader title="Connect a channel" description="SampCrew posts a confirmation message to the channel first and only saves the connection if Slack accepts it." />
        <CardBody>
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-[0.8125rem] text-fg-muted">
            <li>In Slack, create an app for your workspace (api.slack.com/apps) and turn on Incoming Webhooks.</li>
            <li>Choose “Add New Webhook to Workspace” and pick the channel.</li>
            <li>Copy the webhook URL and paste it here. Treat it like a password: anyone with it can post to that channel.</li>
          </ol>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await connectSlackAction({ name: name.trim(), webhookUrl: url.trim() }); if (r.ok) { setName(''); setUrl(''); } return r; }); }}>
            <Field label="Name" required hint="Usually the channel, e.g. #people-team">{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Incoming webhook URL" required error={url && !urlOk ? 'Paste the incoming webhook URL Slack gave you (it starts with https://hooks.slack.com/services/)' : undefined}>
              {(p) => <Input {...p} type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" />}
            </Field>
            <div><Button type="submit" loading={pending} disabled={name.trim().length < 3 || !urlOk}>Connect and post confirmation</Button></div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

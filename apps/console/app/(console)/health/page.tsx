import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, Stat } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';

export const metadata: Metadata = { title: 'System health' };

interface Health {
  api: { status: string; uptimeSeconds: number; node: string; memoryMb: number };
  database: { status: string; latencyMs: number; size: string; connections: number };
  replication: { set: string; members: Array<{ name: string; state: string; healthy: boolean; lagSeconds: number | null }>; oplogHours: number | null } | null;
  backups: {
    archives: {
      last: { at: string; status: 'ok' | 'failed'; encrypted: boolean; database: { file: string; size: string } | null; files: { file: string; size: string } | null; offsite: 'off' | 'copied' | 'failed'; error: string | null } | null;
      lastSuccessAt: string | null;
      lastSuccessHoursAgo: number | null;
    };
    pointInTime: { agentOk: boolean; agentError: string | null; lastBaseBackupAt: string | null; restorableUntil: string | null; minutesBehind: number | null } | null;
  };
  migrations: { applied: number; pending: string[] };
  outbox: { pending: number; retrying: number; oldestPendingSeconds: number | null };
  platformAuditChain: { checked: number; intact: boolean };
  fieldEncryption: { keyId: string; previousKeys: number; olderValues: number };
  uploadScanning: { configured: boolean; reachable: boolean };
  notConfigured: string[];
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
const ago = (h: number) => (h < 1 ? `${Math.round(h * 60)} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`);

const dur = (s: number) => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

export default async function HealthPage() {
  const h = await load<Health>('/platform/health');
  return (
    <>
      <PageHeader title="System health" description="Live readings from this API instance and its database. Refresh the page to update." />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="API" value={<Badge tone="success" dot>{h.api.status}</Badge>} hint={`Up ${dur(h.api.uptimeSeconds)} · ${h.api.node} · ${h.api.memoryMb} MB`} />
        <Stat label="Database" value={`${h.database.latencyMs} ms`} hint={`${h.database.size} · ${h.database.connections} connections`} />
        <Stat label="Event outbox" value={h.outbox.pending} hint={h.outbox.pending ? `${h.outbox.retrying} retrying · oldest ${dur(h.outbox.oldestPendingSeconds ?? 0)}` : 'Nothing waiting'} />
        <Stat label="Platform audit chain" value={<Badge tone={h.platformAuditChain.intact ? 'success' : 'danger'} dot>{h.platformAuditChain.intact ? 'intact' : 'broken'}</Badge>} hint={`${h.platformAuditChain.checked} entries verified`} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Stat
          label="Field encryption key"
          value={<span className="font-mono text-[1rem]">{h.fieldEncryption.keyId}</span>}
          hint={h.fieldEncryption.olderValues
            ? `${h.fieldEncryption.olderValues} value(s) still on an older key: run the re-encryption job`
            : h.fieldEncryption.previousKeys
              ? 'Every value is on the current key; the previous key can be removed'
              : 'Every value is on the current key'}
        />
        <Stat
          label="Virus scanning of uploads"
          value={<Badge tone={!h.uploadScanning.configured ? 'neutral' : h.uploadScanning.reachable ? 'success' : 'danger'} dot>{!h.uploadScanning.configured ? 'off' : h.uploadScanning.reachable ? 'on' : 'unreachable'}</Badge>}
          hint={!h.uploadScanning.configured ? 'Switch it on in Integrations to scan documents, receipts and CVs' : h.uploadScanning.reachable ? 'Uploads are scanned before they are stored' : 'Uploads are being refused until the scanner answers'}
        />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <BackupsCard b={h.backups} />
        <ReplicationCard r={h.replication} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Database migrations" />
          <CardBody className="text-[13px]">
            {h.migrations.pending.length ? <Alert tone="warning" title={`${h.migrations.pending.length} pending`}>{h.migrations.pending.join(', ')}</Alert> : <p>{h.migrations.applied} applied, none pending.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Not configured in this environment" description="Listed so nobody assumes they are running." />
          <CardBody>
            <ul className="grid gap-1.5 text-[13px]">{h.notConfigured.map((n) => <li key={n} className="flex items-center gap-2"><Badge tone="neutral">off</Badge>{n}</li>)}</ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function BackupsCard({ b }: { b: Health['backups'] }) {
  const last = b.archives.last;
  const stale = b.archives.lastSuccessHoursAgo === null || b.archives.lastSuccessHoursAgo > 26;
  const pit = b.pointInTime;
  return (
    <Card>
      <CardHeader title="Backups" description="Daily archives from the backup service, and point-in-time backups of the bundled database." />
      <CardBody className="grid gap-3 text-[13px]">
        {!last ? (
          <Alert tone="warning" title="No backup recorded yet">The backup service records each run here. Check that it is running: docker compose ps backup.</Alert>
        ) : (
          <>
            {last.status === 'failed' || last.offsite === 'failed' ? (
              <Alert tone="danger" title={last.status === 'failed' ? 'The last backup failed' : 'The last off-site copy failed'}>{last.error ?? 'See docker compose logs backup.'}</Alert>
            ) : stale ? (
              <Alert tone="warning" title="No successful backup in the last day">The last one was {b.archives.lastSuccessHoursAgo === null ? 'never' : ago(b.archives.lastSuccessHoursAgo)}.</Alert>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={last.status === 'ok' ? 'success' : 'danger'} dot>{last.status === 'ok' ? 'archive ok' : 'archive failed'}</Badge>
              <Badge tone={last.offsite === 'copied' ? 'success' : last.offsite === 'failed' ? 'danger' : 'warning'} dot>
                {last.offsite === 'copied' ? 'copied off-site' : last.offsite === 'failed' ? 'off-site copy failed' : 'not copied off-site'}
              </Badge>
              <Badge tone={last.encrypted ? 'success' : 'warning'}>{last.encrypted ? 'encrypted' : 'not encrypted'}</Badge>
            </div>
            <p>
              Last run {when(last.at)}
              {last.database ? ` · database ${last.database.size}` : ''}
              {last.files ? ` · files ${last.files.size}` : ''}
              {b.archives.lastSuccessAt && last.status !== 'ok' ? ` · last good one ${when(b.archives.lastSuccessAt)}` : ''}
            </p>
          </>
        )}
        <div className="border-t border-border pt-3">
          {!pit ? (
            <p>Point-in-time backups: <Badge tone="neutral">off</Badge> Restores go back to the last daily archive only.</p>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2">
                Point-in-time backups:
                <Badge tone={pit.agentOk && (pit.minutesBehind ?? 999) <= 30 ? 'success' : 'danger'} dot>
                  {!pit.agentOk ? 'agent down' : (pit.minutesBehind ?? 999) <= 30 ? 'current' : 'behind'}
                </Badge>
              </p>
              <p className="mt-1">
                {pit.restorableUntil ? `Restorable to any second up to ${when(pit.restorableUntil)} (${pit.minutesBehind} min ago)` : 'Waiting for the first base backup'}
                {pit.lastBaseBackupAt ? ` · last base backup ${when(pit.lastBaseBackupAt)}` : ''}
              </p>
              {pit.agentError ? <p className="mt-1 text-danger">{pit.agentError}</p> : null}
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function ReplicationCard({ r }: { r: Health['replication'] }) {
  return (
    <Card>
      <CardHeader title="Replica set" description="Each database member as this API sees it." />
      <CardBody className="text-[13px]">
        {!r ? (
          <p>This database does not share replica set readings with the API (normal on some managed hosts).</p>
        ) : (
          <>
            <ul className="grid gap-1.5">
              {r.members.map((m) => (
                <li key={m.name} className="flex flex-wrap items-center gap-2">
                  <Badge tone={!m.healthy ? 'danger' : m.state === 'PRIMARY' || m.state === 'SECONDARY' ? 'success' : 'warning'} dot>{m.state.toLowerCase()}</Badge>
                  <span className="font-mono">{m.name}</span>
                  {m.state === 'SECONDARY' && m.lagSeconds !== null ? <span className="text-fg-muted">{m.lagSeconds}s behind</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-fg-muted">
              Set {r.set} · {r.members.length} member{r.members.length === 1 ? '' : 's'}
              {r.members.length < 3 ? ' · no automatic failover (needs three members)' : ''}
              {r.oplogHours !== null ? ` · oplog holds ${r.oplogHours} h of changes` : ''}
            </p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

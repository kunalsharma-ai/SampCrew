import { Alert, Badge, Card, CardBody, CardHeader, PageHeader, Stat } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';

export const metadata: Metadata = { title: 'System health' };

interface Health {
  api: { status: string; uptimeSeconds: number; node: string; memoryMb: number };
  database: { status: string; latencyMs: number; size: string; connections: number };
  migrations: { applied: number; pending: string[] };
  outbox: { pending: number; retrying: number; oldestPendingSeconds: number | null };
  platformAuditChain: { checked: number; intact: boolean };
  fieldEncryption: { keyId: string; previousKeys: number; olderValues: number };
  uploadScanning: { configured: boolean; reachable: boolean };
  notConfigured: string[];
}

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

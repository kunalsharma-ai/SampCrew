'use client';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Switch, Table, TBody, TD, TH, THead, TR, Textarea, type Tone } from '@crew/ui';
import { Fingerprint, PauseCircle, PlayCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { pauseDeviceAction, setDeviceIntegrationsAction } from '@/app/(console)/actions';
import { LocalTime } from '@/components/local-time';

export interface ConsoleDevice {
  id: string; name: string; vendor: string; model: string | null; serialNumber: string; protocol: string; simulated: boolean; firmware: string | null;
  locationName: string; lastSeenAt: string | null; lastPunchAt: string | null; lastError: string | null; recordsAccepted: number; recordsRejected: number;
  pausedAt: string | null; pausedReason: string | null; integrationOn: boolean; punches7d: number; status: string;
  tenantId: string; tenantName: string; tenantSlug: string;
}
export interface ConsoleIntegration { key: string; name: string; protocols: string[]; note: string; enabled: boolean; devices: number }

const STATUS_TONE: Record<string, Tone> = { online: 'success', delayed: 'warning', offline: 'danger', error: 'danger', waiting: 'neutral', simulated: 'accent', paused: 'danger' };
const PROTOCOL: Record<string, string> = { push_http: 'ZKTeco push (ADMS)', device_api: 'CREW device API' };

export function IntegrationsPanel({ tenantId, integrations, canManage }: { tenantId: string; integrations: ConsoleIntegration[]; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const set = (key: string, enabled: boolean, name: string, devices: number) => {
    if (!enabled && devices > 0 && !confirm(`Switch ${name} off? CREW refuses punches from this workspace's ${devices} ${name} machine(s) until it is switched back on.`)) return;
    start(async () => {
      const r = await setDeviceIntegrationsAction(tenantId, [{ key, enabled }]);
      setFlash({ tone: r.ok ? 'success' : 'danger', text: r.message ?? 'Saved.' });
      if (r.ok) router.refresh();
    });
  };
  return (
    <Card>
      <CardHeader title="Machine integrations" description="Which attendance machines this workspace's admins may connect. Switching one off refuses punches from its machines (they keep them and resend later) and stops new ones being registered." />
      {flash && <div className="px-5"><Alert tone={flash.tone}>{flash.text}</Alert></div>}
      <Table aria-label="Machine integrations">
        <THead><TR><TH>Integration</TH><TH>Connects through</TH><TH className="text-right">Machines</TH><TH className="text-right">Allowed</TH></TR></THead>
        <TBody>
          {integrations.map((i) => (
            <TR key={i.key} data-testid={`int-${i.key}`}>
              <TD><div className="font-medium text-fg">{i.name}</div><div className="max-w-md text-xs text-fg-subtle">{i.note}</div></TD>
              <TD className="text-xs text-fg-muted">{i.protocols.map((p) => PROTOCOL[p] ?? p).join(', ')}</TD>
              <TD className="text-right tabular-nums">{i.devices}</TD>
              <TD className="text-right"><Switch checked={i.enabled} label={`${i.name} allowed`} testId={`switch-int-${i.key}`} disabled={!canManage || pending} onChange={(next) => set(i.key, next, i.name, i.devices)} /></TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

export function DevicesTable({ devices, showWorkspace, canManage }: { devices: ConsoleDevice[]; showWorkspace: boolean; canManage: boolean }) {
  const [pausing, setPausing] = useState<ConsoleDevice | null>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader title="Machines" description="Live status as the workspace sees it. Paused machines have their pushes refused and logged." />
      {flash && <div className="px-5"><Alert tone={flash.tone}>{flash.text}</Alert></div>}
      {devices.length === 0 ? <EmptyState icon={<Fingerprint className="size-6" />} title="No attendance machines" description="Machines appear here once a workspace admin registers them under Settings > Devices." /> : (
        <Table aria-label="Attendance machines">
          <THead><TR><TH>Machine</TH>{showWorkspace && <TH>Workspace</TH>}<TH>Status</TH><TH>Last contact</TH><TH className="text-right">Punches (7 days)</TH><TH className="text-right">Actions</TH></TR></THead>
          <TBody>
            {devices.map((d) => (
              <TR key={d.id} data-testid={`device-${d.serialNumber}`}>
                <TD>
                  <div className="font-medium text-fg">{d.name}</div>
                  <div className="text-xs text-fg-subtle">{d.vendor}{d.model ? ` ${d.model}` : ''} · <span className="font-mono">{d.serialNumber}</span> · {PROTOCOL[d.protocol] ?? d.protocol}</div>
                  <div className="text-[11px] text-fg-subtle">{d.locationName}{d.firmware ? ` · ${d.firmware}` : ''}</div>
                </TD>
                {showWorkspace && <TD><Link href={`/tenants/${d.tenantId}/devices`} className="hover:underline">{d.tenantName}</Link></TD>}
                <TD>
                  <Badge tone={STATUS_TONE[d.status] ?? 'neutral'} dot>{d.status}</Badge>
                  {d.status === 'paused' && <div className="mt-1 max-w-[14rem] text-[11px] text-fg-subtle">{d.pausedReason ?? 'Integration switched off'}</div>}
                  {d.lastError && d.status !== 'paused' && <div className="mt-1 max-w-[14rem] truncate text-[11px] text-danger" title={d.lastError}>{d.lastError}</div>}
                </TD>
                <TD className="whitespace-nowrap text-xs text-fg-muted">{d.lastSeenAt ? <LocalTime value={d.lastSeenAt} /> : 'Never'}</TD>
                <TD className="text-right tabular-nums">{d.punches7d}<div className="text-[11px] text-fg-subtle">{d.recordsAccepted} total{d.recordsRejected ? `, ${d.recordsRejected} rejected` : ''}</div></TD>
                <TD className="text-right">
                  {canManage && (d.pausedAt
                    ? <Button size="sm" variant="secondary" loading={pending} data-testid={`resume-${d.serialNumber}`} onClick={() => start(async () => {
                        const r = await pauseDeviceAction(d.tenantId, d.id, null);
                        setFlash({ tone: r.ok ? 'success' : 'danger', text: r.message ?? 'Done.' });
                        if (r.ok) router.refresh();
                      })}><PlayCircle className="size-3.5" />Resume</Button>
                    : <Button size="sm" variant="ghost" data-testid={`pause-${d.serialNumber}`} onClick={() => setPausing(d)}><PauseCircle className="size-3.5" />Pause</Button>)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {pausing && <PauseDialog device={pausing} onClose={() => setPausing(null)} onDone={(f) => { setFlash(f); setPausing(null); router.refresh(); }} />}
    </Card>
  );
}

function PauseDialog({ device, onClose, onDone }: { device: ConsoleDevice; onClose: () => void; onDone: (f: { tone: 'success' | 'danger'; text: string }) => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const short = reason.trim().length < 5;
  return (
    <Dialog open onClose={onClose} title={`Pause ${device.name}?`} description={`CREW refuses what this machine sends until you resume it. The machine keeps its punches and resends them later. ${device.tenantName}'s admins see the reason.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={short} loading={pending} onClick={() => start(async () => {
        const r = await pauseDeviceAction(device.tenantId, device.id, reason.trim());
        if (!r.ok) { setError(r.message); return; }
        onDone({ tone: 'success', text: r.message ?? 'Paused.' });
      })}>Pause machine</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Reason (shown to the workspace)" error={reason && short ? 'At least 5 characters' : undefined} required>
        {(p) => <Textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Sending punches from an unknown address" />}
      </Field>
    </Dialog>
  );
}

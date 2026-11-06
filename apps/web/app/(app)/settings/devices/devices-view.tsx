'use client';
import { DEVICE_INTEGRATIONS } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type FieldDef, ResourceDialog } from '@/components/resource-form';
import type { Device, DeviceIntegration, Location } from '@/lib/types';
import { createDeviceAction } from '../../attendance/actions';

export const VENDOR_LABEL: Record<string, string> = Object.fromEntries(DEVICE_INTEGRATIONS.map((i) => [i.key, i.name]));
export const PROTOCOL_LABEL: Record<string, string> = { push_http: 'ZKTeco push (ADMS)', device_api: 'SampCrew device API (HTTPS + token)' };
export const DEVICE_STATUS_LABEL: Record<string, string> = {
  simulated: 'Simulated', waiting: 'Waiting for first contact', online: 'Online', delayed: 'Delayed', offline: 'Offline', error: 'Error', paused: 'Paused by SAMPLEDGE',
};
const yesNo = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

export function deviceFields(locations: Location[], creating: boolean, integrations: DeviceIntegration[] = []): FieldDef[] {
  const allowed = integrations.filter((i) => i.enabled);
  return [
    { name: 'name', label: 'Name', required: true, half: true, placeholder: 'e.g. Main gate' },
    ...(creating ? [
      { name: 'vendor', label: 'Make', type: 'select' as const, required: true, half: true, options: allowed.map((i) => ({ value: i.key, label: i.name })) },
      { name: 'protocol', label: 'Connection', type: 'select' as const, half: true, options: [{ value: '', label: 'Usual for this make' }, ...Object.entries(PROTOCOL_LABEL).map(([value, label]) => ({ value, label }))], hint: 'ZKTeco and eSSL push by themselves; other makes connect through the device API with a token.' },
      { name: 'serialNumber', label: 'Serial number', required: true, half: true, hint: 'Shown under the device menu (System info). SampCrew identifies push devices by it.' },
    ] : []),
    { name: 'model', label: 'Model', half: true, placeholder: 'e.g. K40, uFace 302' },
    { name: 'locationId', label: 'Location', type: 'select', required: true, half: true, options: locations.map((l) => ({ value: l.id, label: l.name })), hint: 'Its time zone is used unless you set one' },
    { name: 'timeZone', label: 'Device time zone', half: true, placeholder: 'e.g. Asia/Kolkata', hint: 'Only if the device clock is set to a different zone' },
    { name: 'directionFromDevice', label: 'Trust in/out key on device', type: 'select', required: true, half: true, options: yesNo, hint: 'No: work out in and out from the order of punches' },
    { name: 'expectedIntervalSeconds', label: 'Expected check-in every (seconds)', type: 'number', required: true, half: true },
    { name: 'allowedIps', label: 'Only accept from these addresses', type: 'textarea', placeholder: '203.0.113.10, 198.51.100.0/24', hint: 'Recommended. Leave empty to accept the serial number from any address.' },
    ...(creating ? [{ name: 'simulated', label: 'Simulated device (for testing)', type: 'select' as const, required: true, options: yesNo, hint: 'A simulated device sends test punches from this screen and never accepts real pushes.' }] : []),
  ];
}

export function DevicesView({ devices, locations, integrations }: { devices: Device[]; locations: Location[]; integrations: DeviceIntegration[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const anyAllowed = integrations.some((i) => i.enabled);
  return (
    <div className="grid gap-6">
      <Alert tone="info" title="Preview">
        The ZKTeco and eSSL push (ADMS) connection follows the vendors' published push protocol but has not yet been certified against every model and firmware.
        Other makes connect through the SampCrew device API from their event forwarding or a bridge. Test with one device before rolling out, and use the ingest log on each device to confirm punches arrive.
      </Alert>
      <Card>
        <CardHeader title="Machine integrations" description="The attendance machines this workspace can connect. SAMPLEDGE chooses which ones are available." />
        <CardBody>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Machine integrations">
            {integrations.map((i) => (
              <li key={i.key} className="rounded-lg border border-border p-3" data-testid={`integration-${i.key}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{i.name}</span>
                  {i.enabled ? <Badge tone="success">Available</Badge> : <Badge tone="danger">Switched off by SAMPLEDGE</Badge>}
                </div>
                <p className="mt-1 text-xs text-fg-muted">{i.protocols.map((p) => PROTOCOL_LABEL[p]).join(' or ')}. {i.note}</p>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Devices" action={locations.length > 0 && anyAllowed && <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Register device</Button>} />
        {devices.length ? (
          <Table>
            <THead><tr><TH>Device</TH><TH>Location</TH><TH>Status</TH><TH>Last contact</TH><TH>Punches received</TH><TH>Unmapped people</TH></tr></THead>
            <TBody>
              {devices.map((d) => (
                <TR key={d.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/settings/devices/${d.id}`}>{d.name}</Link>
                    <div className="text-xs text-fg-muted">{VENDOR_LABEL[d.vendor] ?? d.vendor}{d.model ? ` ${d.model}` : ''} · <span className="font-mono">{d.serialNumber}</span></div>
                  </TD>
                  <TD>{d.locationName}</TD>
                  <TD><StatusPill status={d.status} />{d.status === 'paused' && <div className="mt-1 text-xs text-fg-muted">{d.pausedReason ?? 'Its integration is switched off'}</div>}</TD>
                  <TD className="text-fg-muted">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'Never'}</TD>
                  <TD className="tabular-nums">{d.recordsAccepted}{d.recordsDuplicate ? <span className="text-xs text-fg-muted"> (+{d.recordsDuplicate} repeats)</span> : null}</TD>
                  <TD>{d.unmappedUsers ? <Badge tone="warning">{d.unmappedUsers}</Badge> : <span className="text-fg-muted">0</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No devices registered" description={locations.length ? 'Register a device by its serial number, then point it at SampCrew using the setup values on its page. Or register a simulated device to try the flow.' : 'Add a location under Organization first.'} />}
      </Card>
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Register device"
        fields={deviceFields(locations, true, integrations)}
        initial={{ vendor: integrations.find((i) => i.enabled)?.key ?? 'zkteco', protocol: '', directionFromDevice: 'true', expectedIntervalSeconds: 300, simulated: 'false', locationId: locations[0]?.id }}
        submitLabel="Register"
        onSubmit={async (v) => {
          const r = await createDeviceAction(v);
          if (r.ok && r.data) {
            // A device API machine gets its token once: show it before moving on.
            if (r.data.token) setIssued({ id: r.data.id, token: r.data.token });
            else router.push(`/settings/devices/${r.data.id}`);
          }
          return r;
        }}
      />
      {issued && <TokenDialog token={issued.token} onClose={() => router.push(`/settings/devices/${issued.id}`)} />}
    </div>
  );
}

/** Shows a machine token once. Only its last four characters are kept on screen afterwards. */
export function TokenDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onClose={onClose} title="Machine token" description="Copy it into the machine's event forwarding or bridge now. SampCrew keeps only a fingerprint of it and cannot show it again."
      footer={<><Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(token).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy'}</Button><Button onClick={onClose}>Done</Button></>}>
      <code className="block break-all rounded-md bg-bg-subtle p-3 font-mono text-[13px]" data-testid="device-token">{token}</code>
      <p className="mt-3 text-xs text-fg-muted">Send it as <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>. Anyone with it can send punches for this machine; issue a new one from the machine&apos;s page if it leaks.</p>
    </Dialog>
  );
}

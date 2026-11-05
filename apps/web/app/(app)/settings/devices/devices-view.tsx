'use client';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { type FieldDef, ResourceDialog } from '@/components/resource-form';
import type { Device, Location } from '@/lib/types';
import { createDeviceAction } from '../../attendance/actions';

export const VENDOR_LABEL: Record<string, string> = { zkteco: 'ZKTeco', essl: 'eSSL' };
export const DEVICE_STATUS_LABEL: Record<string, string> = {
  simulated: 'Simulated', waiting: 'Waiting for first contact', online: 'Online', delayed: 'Delayed', offline: 'Offline', error: 'Error',
};
const yesNo = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

export function deviceFields(locations: Location[], creating: boolean): FieldDef[] {
  return [
    { name: 'name', label: 'Name', required: true, half: true, placeholder: 'e.g. Main gate' },
    ...(creating ? [
      { name: 'vendor', label: 'Make', type: 'select' as const, required: true, half: true, options: Object.entries(VENDOR_LABEL).map(([value, label]) => ({ value, label })) },
      { name: 'serialNumber', label: 'Serial number', required: true, half: true, hint: 'Shown under the device menu (System info). CREW identifies the device by it.' },
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

export function DevicesView({ devices, locations }: { devices: Device[]; locations: Location[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-6">
      <Alert tone="info" title="Preview">
        The ZKTeco and eSSL push (ADMS) connection follows the vendors' published push protocol but has not yet been certified against every model and firmware.
        Test with one device before rolling out, and use the ingest log on each device to confirm punches arrive.
      </Alert>
      <Card>
        <CardHeader title="Devices" action={locations.length > 0 && <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Register device</Button>} />
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
                  <TD><StatusPill status={d.status} /></TD>
                  <TD className="text-fg-muted">{d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'Never'}</TD>
                  <TD className="tabular-nums">{d.recordsAccepted}{d.recordsDuplicate ? <span className="text-xs text-fg-muted"> (+{d.recordsDuplicate} repeats)</span> : null}</TD>
                  <TD>{d.unmappedUsers ? <Badge tone="warning">{d.unmappedUsers}</Badge> : <span className="text-fg-muted">0</span>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No devices registered" description={locations.length ? 'Register a device by its serial number, then point it at CREW using the setup values on its page. Or register a simulated device to try the flow.' : 'Add a location under Organization first.'} />}
      </Card>
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Register device"
        fields={deviceFields(locations, true)}
        initial={{ vendor: 'zkteco', directionFromDevice: 'true', expectedIntervalSeconds: 300, simulated: 'false', locationId: locations[0]?.id }}
        submitLabel="Register"
        onSubmit={async (v) => {
          const r = await createDeviceAction(v);
          if (r.ok && r.data) router.push(`/settings/devices/${(r.data as { id: string }).id}`);
          return r;
        }}
      />
    </div>
  );
}

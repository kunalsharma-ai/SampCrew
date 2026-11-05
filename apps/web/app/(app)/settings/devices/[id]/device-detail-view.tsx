'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { ActionResult } from '@/lib/api';
import type { DeviceDetail, DeviceMapping, Location } from '@/lib/types';
import { archiveDeviceAction, mapUserAction, rotateDeviceTokenAction, simulateAction, unmapAction, updateDeviceAction } from '../../../attendance/actions';
import { DEVICE_STATUS_LABEL, PROTOCOL_LABEL, TokenDialog, VENDOR_LABEL, deviceFields } from '../devices-view';

const SCENARIOS: { value: string; label: string; detail: string }[] = [
  { value: 'normal_day', label: 'Normal day', detail: 'Everyone mapped punches in around 08:50 and out around 18:05.' },
  { value: 'late_and_missing_out', label: 'Late, missing out', detail: 'The first person arrives at 09:47 and never punches out.' },
  { value: 'duplicates', label: 'Repeated punches', detail: 'Each in-punch is sent twice; CREW keeps it once.' },
  { value: 'unknown_user', label: 'Unknown person', detail: 'An enrolment number nobody is mapped to; it appears below to map.' },
];

const STATUS_HELP: Record<string, string> = {
  waiting: 'CREW has not heard from this device yet. Enter the setup values below on the device and make sure it can reach this server.',
  delayed: 'The device has missed a few check-ins. Punches are kept on the device and sent when it reconnects.',
  offline: 'The device has stopped checking in. HR admins were notified. Check its power and network.',
  error: 'The last contact failed. See the error below.',
  paused: 'SAMPLEDGE has paused this machine for your workspace, so CREW refuses what it sends. Punches stay on the machine. Contact SAMPLEDGE support to resume it.',
};

type Emp = { id: string; label: string };
type Notice = { tone: 'success' | 'danger'; text: string } | null;

export function DeviceDetailView({ device, mappings, employees, locations }: { device: DeviceDetail; mappings: DeviceMapping[]; employees: Emp[]; locations: Location[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, ok?: (d: unknown) => string) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: ok ? ok(r.data) : r.message ?? 'Saved' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  const help = STATUS_HELP[device.status];
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {device.status === 'paused' && <Alert tone="danger" title="Paused by SAMPLEDGE">{device.pausedReason ?? 'The integration for this make is switched off for your workspace.'}</Alert>}
      {device.simulated && <Alert tone="info" title="Simulated device">This device exists for testing. It sends demo punches through the same pipeline a real device uses, and refuses real pushes.</Alert>}

      <Card>
        <CardHeader
          title="Status"
          action={
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => {
                if (confirm(`Archive ${device.name}? It stops accepting punches. Punches already received are kept.`)) {
                  start(async () => { const r = await archiveDeviceAction(device.id); if (r.ok) router.push('/settings/devices'); else setNotice({ tone: 'danger', text: r.message }); });
                }
              }}>Archive</Button>
            </div>
          }
        />
        <CardBody className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill status={device.status} />
            <span className="text-sm text-fg-muted">{DEVICE_STATUS_LABEL[device.status]}{device.lastSeenAt ? `, last contact ${new Date(device.lastSeenAt).toLocaleString()}` : ''}</span>
          </div>
          {help && <p className="text-sm text-fg-muted">{help}</p>}
          {device.lastError && <Alert tone="danger" title="Last error">{device.lastError}{device.lastErrorAt ? ` (${new Date(device.lastErrorAt).toLocaleString()})` : ''}</Alert>}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <Stat label="Make and model" value={`${VENDOR_LABEL[device.vendor] ?? device.vendor}${device.model ? ` ${device.model}` : ''}`} />
            <Stat label="Connection" value={PROTOCOL_LABEL[device.protocol] ?? device.protocol} />
            <Stat label="Firmware" value={device.firmware ?? 'Not reported'} />
            <Stat label="Time zone" value={device.timeZone} />
            <Stat label="Check-in expected" value={`Every ${device.expectedIntervalSeconds}s`} />
            <Stat label="Punches accepted" value={String(device.recordsAccepted)} />
            <Stat label="Repeats ignored" value={String(device.recordsDuplicate)} />
            <Stat label="Rejected" value={String(device.recordsRejected)} />
            <Stat label="Last punch" value={device.lastPunchAt ? new Date(device.lastPunchAt).toLocaleString() : 'None yet'} />
            <Stat label="Users on device" value={device.reportedUserCount === null ? 'Not reported' : String(device.reportedUserCount)} />
            <Stat label="In/out from device" value={device.directionFromDevice ? 'Yes' : 'No, from punch order'} />
            <Stat label="Allowed addresses" value={device.allowedIps.length ? device.allowedIps.join(', ') : device.protocol === 'device_api' ? 'Any (token only)' : 'Any (serial number only)'} />
          </dl>
          {!device.allowedIps.length && !device.simulated && device.protocol === 'push_http' && (
            <Alert tone="warning">Any device that knows this serial number can send punches. Restrict it to your office's public address under Edit.</Alert>
          )}
        </CardBody>
      </Card>

      {!device.simulated && device.setup.protocol === 'device_api' ? (
        <Card>
          <CardHeader
            title="Setup: CREW device API"
            description="Point the machine's event forwarding, its vendor bridge or your middleware at these addresses. Each call carries the machine token."
            action={<Button size="sm" variant="secondary" loading={pending} onClick={() => {
              if (confirm('Issue a new token? The current one stops working at once.')) start(async () => {
                const r = await rotateDeviceTokenAction(device.id);
                if (r.ok && r.data) setToken(r.data.token); else if (!r.ok) setNotice({ tone: 'danger', text: r.message });
              });
            }}>New token</Button>}
          />
          <CardBody className="grid gap-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Stat label="Punches (POST)" value={device.setup.punchesUrl} mono />
              <Stat label="Heartbeat (POST)" value={device.setup.heartbeatUrl} mono />
              <Stat label="Token" value={device.setup.tokenHint ? `crewdev_…${device.setup.tokenHint}` : 'Not issued'} mono />
              <Stat label="Header" value="Authorization: Bearer <token>" mono />
            </dl>
            <pre className="overflow-x-auto rounded-md bg-bg-subtle p-3 font-mono text-xs">{`{ "punches": [ { "userId": "101", "time": "2026-11-05 09:01:00", "direction": "in", "verify": "face", "id": "event-123" } ] }`}</pre>
            <p className="text-xs text-fg-muted">Times without an offset are read in the machine&apos;s time zone ({device.timeZone}). Up to 500 punches per call; sending the same punch again is ignored.</p>
          </CardBody>
        </Card>
      ) : !device.simulated && device.setup.protocol === 'push_http' ? (
        <Card>
          <CardHeader title="Setup on the device" description="On the device open Comm. or Cloud Server Setting (named ADMS on some models) and enter these values. The device then pushes punches to CREW by itself." />
          <CardBody>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
              <Stat label="Server address" value={device.setup.serverAddress} mono />
              <Stat label="Server port" value={String(device.setup.serverPort)} mono />
              <Stat label="HTTPS" value={device.setup.https ? 'On' : 'Off'} />
              <Stat label="Serial number (must match)" value={device.setup.serialNumber} mono />
            </dl>
          </CardBody>
        </Card>
      ) : (
        <SimulatorCard device={device} run={run} pending={pending} />
      )}

      <PeopleCard device={device} mappings={mappings} employees={employees} run={run} pending={pending} />

      <Card>
        <CardHeader title="Ingest log" description="The last 50 contacts from this device. Raw punches are stored exactly as received and never edited." />
        {device.log.length ? (
          <Table>
            <THead><tr><TH>When</TH><TH>What</TH><TH>Records</TH><TH>Accepted</TH><TH>Repeats</TH><TH>Rejected</TH><TH>Detail</TH></tr></THead>
            <TBody>
              {device.log.map((l) => (
                <TR key={l.id}>
                  <TD className="whitespace-nowrap text-fg-muted">{new Date(l.createdAt).toLocaleString()}</TD>
                  <TD>{l.kind}</TD>
                  <TD className="tabular-nums">{l.records}</TD>
                  <TD className="tabular-nums">{l.accepted}</TD>
                  <TD className="tabular-nums">{l.duplicates}</TD>
                  <TD className="tabular-nums">{l.rejected ? <Badge tone="danger">{l.rejected}</Badge> : 0}</TD>
                  <TD className="max-w-xs truncate text-xs text-fg-muted" title={l.detail ?? ''}>{[l.detail, l.remoteIp ? `from ${l.remoteIp}` : null].filter(Boolean).join(' · ') || '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="Nothing received yet" description="Contacts appear here as soon as the device reaches CREW." />}
      </Card>

      {token && <TokenDialog token={token} onClose={() => { setToken(null); router.refresh(); }} />}

      <ResourceDialog
        open={editing}
        onClose={() => setEditing(false)}
        title={`Edit ${device.name}`}
        fields={deviceFields(locations, false)}
        initial={{ ...device, directionFromDevice: String(device.directionFromDevice), allowedIps: device.allowedIps.join(', ') }}
        submitLabel="Save"
        onSubmit={(v) => updateDeviceAction(device.id, v)}
      />
    </div>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={mono ? 'break-all font-mono' : undefined}>{value}</dd>
    </div>
  );
}

type Run = (fn: () => Promise<ActionResult<unknown>>, ok?: (d: unknown) => string) => void;

function SimulatorCard({ device, run, pending }: { device: DeviceDetail; run: Run; pending: boolean }) {
  const [date, setDate] = useState('');
  return (
    <Card>
      <CardHeader title="Send test punches" description="Each button builds a real push message and sends it through the device pipeline, so dedupe, mapping and day calculation all run as they would for a real device. Punches are marked as coming from this simulated device." />
      <CardBody className="grid gap-4">
        <Field label="Day" hint="Leave empty for today. Times in the future are skipped.">
          {(p) => <Input {...p} type="date" className="w-48" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          {SCENARIOS.map((s) => (
            <div key={s.value} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
              <div>
                <div className="text-sm font-medium">{s.label}</div>
                <div className="text-xs text-fg-muted">{s.detail}</div>
              </div>
              <Button size="sm" variant="secondary" loading={pending} onClick={() => run(
                () => simulateAction(device.id, s.value, date || undefined),
                (d) => { const x = d as { records: number; accepted: number; duplicates: number; rejected: number; date: string }; return `Sent ${x.records} punch(es) for ${x.date}: ${x.accepted} accepted, ${x.duplicates} repeat(s) ignored, ${x.rejected} rejected.`; },
              )}>Send</Button>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

function PeopleCard({ device, mappings, employees, run, pending }: { device: DeviceDetail; mappings: DeviceMapping[]; employees: Emp[]; run: Run; pending: boolean }) {
  const [mapping, setMapping] = useState<string | null>(null);
  const unmapped = device.users.filter((u) => !u.employeeId);
  return (
    <Card>
      <CardHeader
        title="People on this device"
        description={`Each person is enrolled on the device under a number. Map each number to an employee so their punches count. ${device.coverage.mapped} of ${device.coverage.seen} numbers seen are mapped.`}
        action={<Button size="sm" variant="secondary" onClick={() => setMapping('')}>Map a number</Button>}
      />
      {unmapped.length > 0 && (
        <CardBody>
          <Alert tone="warning">{unmapped.length} enrolment number(s) have punched but are not mapped. Their punches are stored and will count as soon as you map them.</Alert>
        </CardBody>
      )}
      {device.users.length ? (
        <Table>
          <THead><tr><TH>Enrolment number</TH><TH>Employee</TH><TH>Punches</TH><TH>Last punch</TH><TH /></tr></THead>
          <TBody>
            {device.users.map((u) => (
              <TR key={u.deviceUserId}>
                <TD className="font-mono">{u.deviceUserId}</TD>
                <TD>{u.employeeName ?? <Badge tone="warning">Not mapped</Badge>}</TD>
                <TD className="tabular-nums">{u.punches}</TD>
                <TD className="text-fg-muted">{new Date(u.lastPunchAt).toLocaleString()}</TD>
                <TD className="text-right">{!u.employeeId && <Button size="sm" variant="ghost" onClick={() => setMapping(u.deviceUserId)}>Map</Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="No punches yet" description="Enrolment numbers appear here after the device sends its first punches. You can also map numbers in advance." />}

      {mappings.length > 0 && (
        <>
          <CardHeader title="Mappings" description="A mapping for this device wins over one that applies to every device." />
          <Table>
            <THead><tr><TH>Enrolment number</TH><TH>Employee</TH><TH>Applies to</TH><TH /></tr></THead>
            <TBody>
              {mappings.map((m) => (
                <TR key={m.id}>
                  <TD className="font-mono">{m.deviceUserId}</TD>
                  <TD>{m.employeeName} <span className="text-xs text-fg-muted">{m.employeeCode}</span></TD>
                  <TD>{m.deviceId ? 'This device' : 'Every device'}</TD>
                  <TD className="text-right">
                    <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Remove the mapping for ${m.deviceUserId}? Their punches stop counting for ${m.employeeName}.`) && run(() => unmapAction(m.id))}>Remove</Button>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </>
      )}

      <ResourceDialog
        open={mapping !== null}
        onClose={() => setMapping(null)}
        title="Map enrolment number"
        description="Punches already received under this number are applied to the employee for the last 62 days (locked periods excepted)."
        fields={[
          { name: 'deviceUserId', label: 'Enrolment number', required: true, half: true, hint: 'The user ID on the device' },
          { name: 'scope', label: 'Applies to', type: 'select', required: true, half: true, options: [{ value: 'device', label: 'This device only' }, { value: 'all', label: 'Every device' }] },
          { name: 'employeeId', label: 'Employee', type: 'select', required: true, options: employees.map((e) => ({ value: e.id, label: e.label })) },
        ]}
        initial={{ deviceUserId: mapping ?? '', scope: 'all' }}
        submitLabel="Map"
        onSubmit={(v) => mapUserAction({ deviceUserId: String(v.deviceUserId), employeeId: String(v.employeeId), deviceId: v.scope === 'device' ? device.id : null })}
      />
    </Card>
  );
}

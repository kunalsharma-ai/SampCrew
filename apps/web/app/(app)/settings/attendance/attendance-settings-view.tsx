'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Copy, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type FieldDef, ResourceDialog } from '@/components/resource-form';
import type { ActionResult } from '@/lib/api';
import { hm } from '@/lib/time';
import type { AttendancePolicy, Kiosk, LegalEntity, Location, PeriodLock, ShiftTemplate } from '@/lib/types';
import {
  archiveShiftAction, createKioskAction, lockAction, recomputeAction, removePolicyAction, revokeKioskAction, savePolicyAction, saveShiftAction, unlockAction,
} from '../../attendance/actions';

const yesNo = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];
const GEOFENCE: Record<string, string> = {
  off: 'Off: location is not checked',
  warn: 'Warn: punches outside are kept and flagged',
  enforce: 'Enforce: punches outside the fence are refused',
};

interface Props {
  shifts: ShiftTemplate[];
  policies: AttendancePolicy[];
  locks: PeriodLock[];
  kiosks: Kiosk[] | null;
  locations: Location[];
  entities: LegalEntity[];
}
type Run = (fn: () => Promise<ActionResult<unknown>>, ok?: (data: unknown) => string) => void;

export function AttendanceSettingsView(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const run: Run = (fn, ok) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: ok ? ok(r.data) : r.message ?? 'Saved' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <ShiftsCard {...props} run={run} />
      <PoliciesCard {...props} run={run} />
      <LocksCard {...props} run={run} />
      <KiosksCard {...props} run={run} />
      <RecomputeCard run={run} pending={pending} />
    </div>
  );
}

function ShiftsCard({ shifts, run }: Props & { run: Run }) {
  const [editing, setEditing] = useState<ShiftTemplate | 'new' | null>(null);
  const current = editing && editing !== 'new' ? editing : null;
  const fields: FieldDef[] = [
    { name: 'code', label: 'Code', required: true, half: true, hint: 'e.g. GEN, NIGHT' },
    { name: 'name', label: 'Name', required: true, half: true },
    { name: 'startTime', label: 'Starts', type: 'time', required: true, half: true },
    { name: 'endTime', label: 'Ends', type: 'time', required: true, half: true, hint: 'Earlier than the start means it ends the next day' },
    { name: 'breakMinutes', label: 'Unpaid break (minutes)', type: 'number', required: true, half: true },
    { name: 'graceLateMinutes', label: 'Late grace (minutes)', type: 'number', required: true, half: true },
    { name: 'graceEarlyMinutes', label: 'Early-leave grace (minutes)', type: 'number', required: true, half: true },
    { name: 'halfDayMinutes', label: 'Half day needs (minutes worked)', type: 'number', required: true, half: true },
    { name: 'fullDayMinutes', label: 'Full day needs (minutes worked)', type: 'number', required: true, half: true },
    { name: 'overtimeEnabled', label: 'Count overtime', type: 'select', options: yesNo, required: true, half: true },
    { name: 'overtimeMinMinutes', label: 'Overtime counts from (minutes)', type: 'number', required: true, half: true },
    { name: 'color', label: 'Colour', half: true, placeholder: '#0f766e' },
  ];
  return (
    <Card>
      <CardHeader
        title="Shifts"
        description="A shift sets when the day starts, the grace allowed and how many hours make a full day. Changing a shift recalculates the last few days; locked periods never change."
        action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" /> Add shift</Button>}
      />
      {shifts.length ? (
        <Table>
          <THead><tr><TH>Shift</TH><TH>Hours</TH><TH>Break</TH><TH>Grace (late / early)</TH><TH>Half / full day</TH><TH>Overtime</TH><TH /></tr></THead>
          <TBody>
            {shifts.map((s) => (
              <TR key={s.id}>
                <TD><span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: s.color }} /><span className="font-medium">{s.name}</span><span className="font-mono text-xs text-fg-muted">{s.code}</span></span></TD>
                <TD className="tabular-nums">{s.startTime}–{s.endTime}{s.endTime <= s.startTime && <span className="text-xs text-fg-muted"> (+1 day)</span>}</TD>
                <TD>{hm(s.breakMinutes)}</TD>
                <TD>{s.graceLateMinutes}m / {s.graceEarlyMinutes}m</TD>
                <TD>{hm(s.halfDayMinutes)} / {hm(s.fullDayMinutes)}</TD>
                <TD>{s.overtimeEnabled ? `From ${hm(s.overtimeMinMinutes)}` : 'Not counted'}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Archive ${s.name}? Days already worked keep it; it can no longer be assigned.`) && run(() => archiveShiftAction(s.id))}>Archive</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="No shifts yet" description="Add at least one shift and set it as the default in the policy below." />}
      <ResourceDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={current ? `Edit ${current.name}` : 'Add shift'}
        fields={fields}
        initial={current ? { ...current, overtimeEnabled: String(current.overtimeEnabled) } : {
          startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceLateMinutes: 10, graceEarlyMinutes: 10, halfDayMinutes: 240, fullDayMinutes: 480,
          overtimeEnabled: 'false', overtimeMinMinutes: 30, color: '#0f766e',
        }}
        submitLabel="Save shift"
        onSubmit={(v) => saveShiftAction(current?.id ?? null, v)}
      />
    </Card>
  );
}

function PoliciesCard({ policies, shifts, locations, run }: Props & { run: Run }) {
  const [editing, setEditing] = useState<Partial<AttendancePolicy> | null>(null);
  const live = shifts.filter((s) => !s.archivedAt);
  const isDefault = editing ? !editing.locationId && editing.id !== undefined : false;
  const fields: FieldDef[] = [
    ...(isDefault ? [] : [{
      name: 'locationId', label: 'Location', type: 'select' as const, required: true,
      options: locations.map((l) => ({ value: l.id, label: l.name })), hint: 'This override replaces the workspace default for people based there',
    }]),
    { name: 'defaultShiftId', label: 'Default shift', type: 'select', options: live.map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` })), hint: 'Used on working days when no roster or assignment says otherwise' },
    { name: 'geofenceMode', label: 'Geofence', type: 'select', required: true, options: Object.entries(GEOFENCE).map(([value, label]) => ({ value, label })) },
    { name: 'webPunch', label: 'Punch from the web', type: 'select', options: yesNo, required: true, half: true },
    { name: 'mobilePunch', label: 'Punch from the mobile app', type: 'select', options: yesNo, required: true, half: true },
    { name: 'qrPunch', label: 'Punch at QR kiosks', type: 'select', options: yesNo, required: true, half: true },
    { name: 'overtimeRequiresApproval', label: 'Overtime needs approval', type: 'select', options: yesNo, required: true, half: true },
    { name: 'earlyWindowMinutes', label: 'Day opens before shift (minutes)', type: 'number', required: true, half: true, hint: 'Punches earlier than this count for the previous day' },
    { name: 'correctionWindowDays', label: 'Corrections allowed for (days)', type: 'number', required: true, half: true },
  ];
  const label = (b: boolean) => (b ? 'Yes' : 'No');
  return (
    <Card>
      <CardHeader
        title="Punching policy"
        description="The workspace default applies everywhere unless a location has its own override."
        action={locations.length > 0 && <Button size="sm" variant="secondary" onClick={() => setEditing({ geofenceMode: 'warn', webPunch: true, mobilePunch: true, qrPunch: true, overtimeRequiresApproval: true, earlyWindowMinutes: 240, correctionWindowDays: 30 })}><Plus className="size-3.5" /> Location override</Button>}
      />
      <Table>
        <THead><tr><TH>Applies to</TH><TH>Default shift</TH><TH>Geofence</TH><TH>Web / mobile / QR</TH><TH>OT approval</TH><TH>Corrections</TH><TH /></tr></THead>
        <TBody>
          {policies.map((p) => (
            <TR key={p.id}>
              <TD className="font-medium">{p.locationName ?? 'Workspace default'}</TD>
              <TD>{p.defaultShiftName ?? <span className="text-fg-muted">None</span>}</TD>
              <TD><Badge tone={p.geofenceMode === 'enforce' ? 'warning' : p.geofenceMode === 'warn' ? 'info' : 'neutral'}>{p.geofenceMode}</Badge></TD>
              <TD>{label(p.webPunch)} / {label(p.mobilePunch)} / {label(p.qrPunch)}</TD>
              <TD>{label(p.overtimeRequiresApproval)}</TD>
              <TD>{p.correctionWindowDays} days</TD>
              <TD className="whitespace-nowrap text-right">
                <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
                {p.locationId && <Button size="sm" variant="ghost" onClick={() => confirm(`Remove the override for ${p.locationName}?`) && run(() => removePolicyAction(p.locationId!))}>Remove</Button>}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <ResourceDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={isDefault ? 'Workspace default policy' : editing?.locationName ? `Policy for ${editing.locationName}` : 'Location override'}
        fields={fields}
        initial={editing ? {
          ...editing,
          webPunch: String(editing.webPunch ?? true), mobilePunch: String(editing.mobilePunch ?? true), qrPunch: String(editing.qrPunch ?? true),
          overtimeRequiresApproval: String(editing.overtimeRequiresApproval ?? true),
        } : undefined}
        submitLabel="Save policy"
        onSubmit={(v) => savePolicyAction(isDefault ? { ...v, locationId: null } : v)}
      />
    </Card>
  );
}

function LocksCard({ locks, entities, run }: Props & { run: Run }) {
  const [open, setOpen] = useState(false);
  const fields: FieldDef[] = [
    { name: 'periodStart', label: 'From', type: 'date', required: true, half: true },
    { name: 'periodEnd', label: 'To', type: 'date', required: true, half: true },
    { name: 'legalEntityId', label: 'Legal entity', type: 'select', options: entities.map((e) => ({ value: e.id, label: e.name })), hint: 'None locks the whole workspace' },
    { name: 'note', label: 'Note', placeholder: 'e.g. October payroll' },
  ];
  return (
    <Card>
      <CardHeader
        title="Payroll locks"
        description="A locked period stops changing: corrections are refused and device punches that arrive late are kept but flagged, not applied. Unlocking needs a reason."
        action={<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Lock a period</Button>}
      />
      {locks.length ? (
        <Table>
          <THead><tr><TH>Period</TH><TH>Scope</TH><TH>Status</TH><TH>Note</TH><TH /></tr></THead>
          <TBody>
            {locks.map((l) => (
              <TR key={l.id}>
                <TD className="tabular-nums">{l.periodStart} to {l.periodEnd}</TD>
                <TD>{l.legalEntityName ?? 'Whole workspace'}</TD>
                <TD>{l.unlockedAt ? <span title={l.unlockReason ?? ''}><Badge tone="neutral">Unlocked</Badge></span> : <Badge tone="warning">Locked</Badge>}</TD>
                <TD className="text-fg-muted">{l.unlockedAt ? `Unlocked: ${l.unlockReason}` : l.note ?? '—'}</TD>
                <TD className="text-right">
                  {!l.unlockedAt && <Button size="sm" variant="ghost" onClick={() => {
                    const reason = prompt('Why is this period being unlocked? This is recorded in the audit log.');
                    if (reason && reason.trim().length >= 3) run(() => unlockAction(l.id, reason.trim()));
                  }}>Unlock</Button>}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="Nothing locked" description="Lock each period once payroll has used it." />}
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Lock a period"
        description="Pending corrections for these dates can no longer be approved once locked."
        fields={fields}
        submitLabel="Lock"
        onSubmit={async (v) => {
          const r = await lockAction(v);
          if (r.ok) {
            const n = (r.data as { pendingCorrections?: number } | undefined)?.pendingCorrections ?? 0;
            if (n) alert(`${n} correction request(s) for this period are still pending and now cannot be approved.`);
          }
          return r;
        }}
      />
    </Card>
  );
}

function KiosksCard({ kiosks, locations, run }: Props & { run: Run }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; url: string } | null>(null);
  if (kiosks === null) {
    return (
      <Card>
        <CardHeader title="QR kiosks" />
        <CardBody><Alert tone="info">QR kiosks are part of advanced attendance (Professional plan and above), which this workspace's plan does not include. See Billing to change plan.</Alert></CardBody>
      </Card>
    );
  }
  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Reception tablet' },
    { name: 'locationId', label: 'Location', type: 'select', required: true, options: locations.map((l) => ({ value: l.id, label: l.name })) },
  ];
  return (
    <Card>
      <CardHeader
        title="QR kiosks"
        description="A kiosk is a screen at the entrance that shows a QR code changing every 30 seconds. People scan it with their phone while signed in to punch. A code photographed and sent elsewhere stops working within a minute."
        action={locations.length > 0 && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Add kiosk</Button>}
      />
      {kiosks.length ? (
        <Table>
          <THead><tr><TH>Kiosk</TH><TH>Location</TH><TH>Last on screen</TH><TH>Status</TH><TH /></tr></THead>
          <TBody>
            {kiosks.map((k) => (
              <TR key={k.id}>
                <TD className="font-medium">{k.name}</TD>
                <TD>{k.locationName}</TD>
                <TD className="text-fg-muted">{k.lastSeenAt ? new Date(k.lastSeenAt).toLocaleString() : 'Never opened'}</TD>
                <TD>{k.revokedAt ? <Badge tone="neutral">Revoked</Badge> : <Badge tone="success">Active</Badge>}</TD>
                <TD className="text-right">{!k.revokedAt && <Button size="sm" variant="ghost" onClick={() => confirm(`Revoke ${k.name}? Its screen stops showing codes.`) && run(() => revokeKioskAction(k.id))}>Revoke</Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="No kiosks" description="Add one and open its link on a tablet at the entrance." />}
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Add kiosk"
        fields={fields}
        submitLabel="Create kiosk"
        onSubmit={async (v) => {
          const r = await createKioskAction(v);
          if (r.ok && r.data) setCreated({ name: String(v.name), url: `${window.location.origin}/kiosk#${(r.data as { token: string }).token}` });
          return r;
        }}
      />
      <Dialog
        open={created !== null}
        onClose={() => setCreated(null)}
        title={`Kiosk link for ${created?.name ?? ''}`}
        description="Open this link on the kiosk screen. It is shown only once: if it is lost, revoke the kiosk and create a new one."
        footer={<Button onClick={() => setCreated(null)}>Done</Button>}
      >
        <Field label="Kiosk link">
          {(p) => (
            <div className="flex gap-2">
              <Input {...p} readOnly value={created?.url ?? ''} onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" type="button" onClick={() => created && navigator.clipboard?.writeText(created.url)}><Copy className="size-3.5" /> Copy</Button>
            </div>
          )}
        </Field>
      </Dialog>
    </Card>
  );
}

function RecomputeCard({ run, pending }: { run: Run; pending: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  return (
    <Card>
      <CardHeader title="Recalculate days" description="Rebuilds attendance days from the raw punches, for example after changing a shift or holiday. Raw punches are never changed, and locked periods are skipped." />
      <CardBody className="flex flex-wrap items-end gap-3">
        <Field label="From">{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Button variant="secondary" loading={pending} onClick={() => run(() => recomputeAction(from, to), (d) => { const x = d as { employees: number; days: number }; return `Recalculated ${x.days} day(s) for ${x.employees} employee(s).`; })}>Recalculate</Button>
      </CardBody>
    </Card>
  );
}

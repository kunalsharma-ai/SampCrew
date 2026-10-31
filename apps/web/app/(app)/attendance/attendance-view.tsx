'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, StatusPill, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { CalendarCheck, ChevronLeft, ChevronRight, LogIn, LogOut, MapPin, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { clock, dayLabel, hm, SOURCE_LABEL } from '@/lib/time';
import type { AttendanceDay, AttendanceMonth, AttendanceToday } from '@/lib/types';
import { cancelCorrectionAction, correctionAction, overtimeAction, punchAction } from './actions';

/** Browser location for geofenced punching. Resolves without coordinates if the person declines or it times out. */
function locate(): Promise<{ latitude?: number; longitude?: number; accuracyM?: number; denied?: boolean }> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      (err) => resolve({ denied: err.code === err.PERMISSION_DENIED }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}

export function TodayCard({ today }: { today: AttendanceToday }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  const tz = today.timeZone;
  const next = today.nextDirection;
  const offDay = today.dayType !== 'working';
  const punch = () => start(async () => {
    setNotice(null);
    const where = today.geofence.mode !== 'off' && today.geofence.configured ? await locate() : {};
    if (today.geofence.mode === 'enforce' && where.denied) {
      setNotice({ tone: 'danger', text: 'Your workplace checks that you are on site. Allow location access in your browser and try again.' });
      return;
    }
    const { denied: _denied, ...coords } = where;
    const r = await punchAction({ ...coords, direction: next });
    if (!r.ok) setNotice({ tone: 'danger', text: r.message });
    else {
      const p = r.data!.punch;
      const outside = p.geofence === 'outside';
      setNotice({
        tone: outside ? 'warning' : 'success',
        text: `Punched ${p.direction}.${outside ? ` You appear to be about ${p.distanceM} m from your workplace; this is recorded on the punch.` : ''}`,
      });
      router.refresh();
    }
  });
  return (
    <Card>
      <CardHeader
        title={`Today, ${dayLabel(today.date)}`}
        description={
          today.holidayName ? `Holiday: ${today.holidayName}` :
          today.shift ? `${today.shift.name} (${today.shift.code}) ${today.shift.start} to ${today.shift.end}${offDay ? ', but today is a day off' : ''}` :
          offDay ? 'Day off' : 'No shift assigned'
        }
        action={today.day && <StatusPill status={today.day.status} />}
      />
      <CardBody className="grid gap-4">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {today.locked && <Alert tone="info">Today is in a period locked for payroll, so punching is paused. Ask HR if this is unexpected.</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          {today.allowed.web ? (
            <Button size="lg" onClick={punch} loading={pending} disabled={today.locked}>
              {next === 'in' ? <LogIn className="size-4" /> : <LogOut className="size-4" />} Punch {next}
            </Button>
          ) : (
            <Alert tone="info">Web punching is turned off for your location. Use the mobile app{today.allowed.qr ? ' or scan the QR code on a site kiosk' : ''}.</Alert>
          )}
          {today.geofence.mode !== 'off' && today.geofence.configured && (
            <span className="inline-flex items-center gap-1 text-[13px] text-fg-muted">
              <MapPin className="size-3.5" /> {today.geofence.mode === 'enforce' ? 'Must be' : 'Checked to be'} within {today.geofence.radiusM} m of your workplace
            </span>
          )}
        </div>
        {today.punches.length > 0 ? (
          <ol className="flex flex-wrap gap-2" aria-label="Today's punches">
            {today.punches.map((p) => (
              <li key={p.id}>
                <Badge tone={p.direction === 'in' ? 'success' : p.direction === 'out' ? 'neutral' : 'info'}>
                  {p.direction === 'unknown' ? 'Punch' : p.direction === 'in' ? 'In' : 'Out'} {clock(p.at, tz)} · {p.device ?? SOURCE_LABEL[p.source] ?? p.source}
                  {p.geofence === 'outside' ? ' · outside area' : ''}
                </Badge>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-fg-muted">No punches yet today.</p>
        )}
        {today.day && today.day.workedMinutes > 0 && (
          <p className="text-sm text-fg-muted">Worked so far: <span className="font-medium text-fg">{hm(today.day.workedMinutes)}</span>{today.day.lateMinutes > 0 ? `, ${today.day.lateMinutes} min late` : ''}</p>
        )}
      </CardBody>
    </Card>
  );
}

const shiftMonth = (month: string, n: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export function MonthView({ data, month, own, canClaimFor }: { data: AttendanceMonth; month: string; own: boolean; canClaimFor: boolean }) {
  const tz = data.employee.timeZone;
  const [correcting, setCorrecting] = useState<AttendanceDay | null>(null);
  const [claiming, setClaiming] = useState<AttendanceDay | null>(null);
  const pendingCorrection = new Set(data.corrections.filter((c) => c.status === 'pending').map((c) => c.workDate));
  const claimed = new Map(data.overtimeClaims.filter((c) => c.status !== 'rejected' && c.status !== 'cancelled').map((c) => [c.workDate, c]));
  const q = (m: string) => `?month=${m}${own ? '' : `&employeeId=${data.employee.id}`}`;
  const s = data.summary;
  const canAct = own || canClaimFor;
  return (
    <>
      <Card>
        <CardHeader
          title={new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}
          description={`Present ${s.present} · Half days ${s.halfDay} · Absent ${s.absent} · Missing punch ${s.missingPunch} · On leave ${s.onLeave} · Late ${s.late} · Worked ${hm(s.workedMinutes)} · Overtime ${hm(s.overtimeMinutes)} (${hm(s.approvedOvertimeMinutes)} approved)`}
          action={
            <div className="flex gap-1">
              <Link aria-label="Previous month" className="rounded-md p-1.5 hover:bg-bg-subtle" href={q(shiftMonth(month, -1))}><ChevronLeft className="size-4" /></Link>
              <Link aria-label="Next month" className="rounded-md p-1.5 hover:bg-bg-subtle" href={q(shiftMonth(month, 1))}><ChevronRight className="size-4" /></Link>
            </div>
          }
        />
        {data.days.length === 0 ? (
          <EmptyState icon={<CalendarCheck className="size-5" />} title="Nothing to show for this month" description="Days appear here from the joining date up to today." />
        ) : (
          <Table>
            <THead><TR><TH>Date</TH><TH>Shift</TH><TH>Status</TH><TH>In</TH><TH>Out</TH><TH>Worked</TH><TH>Late</TH><TH>Overtime</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {data.days.map((d) => {
                const fixable = ['missing_punch', 'absent', 'half_day'].includes(d.status) || d.flags.includes('missing_out') || d.flags.includes('missing_in');
                const otClaim = claimed.get(d.workDate);
                return (
                  <TR key={d.workDate}>
                    <TD className="whitespace-nowrap">
                      <Link className="font-medium hover:underline" href={`/attendance/day/${data.employee.id}/${d.workDate}`} title={d.explanation.join(' ')}>{dayLabel(d.workDate)}</Link>
                    </TD>
                    <TD className="text-fg-muted">{d.shiftCode ? `${d.shiftCode} ${d.shiftStart}-${d.shiftEnd}` : '—'}</TD>
                    <TD><StatusPill status={d.status} />{d.flags.includes('outside_geofence') && <Badge tone="warning" className="ml-1">Outside area</Badge>}</TD>
                    <TD className="tabular">{clock(d.firstIn, tz)}</TD>
                    <TD className="tabular">{clock(d.lastOut, tz)}</TD>
                    <TD className="tabular">{hm(d.workedMinutes)}</TD>
                    <TD className="tabular">{d.lateMinutes ? `${d.lateMinutes}m` : '—'}</TD>
                    <TD className="tabular">
                      {d.overtimeMinutes ? `${hm(d.overtimeMinutes)}${d.approvedOvertimeMinutes ? ` (${hm(d.approvedOvertimeMinutes)} ok)` : otClaim ? ` (${otClaim.status})` : ''}` : '—'}
                    </TD>
                    <TD className="text-right whitespace-nowrap">
                      {canAct && fixable && !pendingCorrection.has(d.workDate) && d.status !== 'in_progress' && (
                        <Button size="sm" variant="ghost" onClick={() => setCorrecting(d)}>Fix punches</Button>
                      )}
                      {pendingCorrection.has(d.workDate) && <Badge tone="warning">Correction pending</Badge>}
                      {canAct && d.overtimeMinutes > 0 && d.approvedOvertimeMinutes === 0 && !otClaim && (
                        <Button size="sm" variant="ghost" onClick={() => setClaiming(d)}>Claim overtime</Button>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
      <Corrections data={data} own={own} />
      {correcting && <CorrectionDialog day={correcting} employeeId={own ? undefined : data.employee.id} onClose={() => setCorrecting(null)} />}
      {claiming && <OvertimeDialog day={claiming} employeeId={own ? undefined : data.employee.id} onClose={() => setClaiming(null)} />}
    </>
  );
}

function Corrections({ data, own }: { data: AttendanceMonth; own: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!data.corrections.length) return null;
  return (
    <Card>
      <CardHeader title="Correction requests this month" description="Approved corrections add punches; the original punches are never changed." />
      <Table>
        <THead><TR><TH>Date</TH><TH>Punches to add</TH><TH>Reason</TH><TH>Status</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
        <TBody>
          {data.corrections.map((c) => (
            <TR key={c.id}>
              <TD>{dayLabel(c.workDate)}</TD>
              <TD>{c.punches.map((p) => `${p.direction} ${p.time}${p.nextDay ? ' (+1 day)' : ''}`).join(', ')}</TD>
              <TD className="text-fg-muted">{c.reason}</TD>
              <TD><StatusPill status={c.status} /></TD>
              <TD className="text-right">
                {own && c.status === 'pending' && (
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { await cancelCorrectionAction(c.id); router.refresh(); })}>Withdraw</Button>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </Card>
  );
}

function CorrectionDialog({ day, employeeId, onClose }: { day: AttendanceDay; employeeId?: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const missingOut = day.flags.includes('missing_out');
  const [punches, setPunches] = useState<{ time: string; direction: 'in' | 'out'; nextDay: boolean }[]>(
    missingOut ? [{ time: day.shiftEnd ?? '18:00', direction: 'out', nextDay: false }] :
    day.punchCount === 0 ? [{ time: day.shiftStart ?? '09:00', direction: 'in', nextDay: false }, { time: day.shiftEnd ?? '18:00', direction: 'out', nextDay: false }] :
    [{ time: day.shiftStart ?? '09:00', direction: 'in', nextDay: false }],
  );
  const [reason, setReason] = useState('');
  const set = (i: number, patch: Partial<(typeof punches)[number]>) => setPunches(punches.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Fix punches for ${dayLabel(day.workDate)}`}
      description="Add the punches that are missing. Your approver sees the reason; once approved, the day is recalculated."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="correction-form" loading={pending}>Send for approval</Button></>}
    >
      <form
        id="correction-form"
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await correctionAction({ employeeId, workDate: day.workDate, punches, reason });
            if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        {day.explanation.length > 0 && <Alert tone="info">{day.explanation.join(' ')}</Alert>}
        {punches.map((p, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] items-end gap-2">
            <Field label="Time">{(f) => <Input {...f} type="time" name={`time-${i}`} value={p.time} onChange={(e) => set(i, { time: e.target.value })} required />}</Field>
            <Field label="Type">{(f) => <Select {...f} name={`direction-${i}`} value={p.direction} onChange={(e) => set(i, { direction: e.target.value as 'in' | 'out' })}><option value="in">Punch in</option><option value="out">Punch out</option></Select>}</Field>
            <label className="mb-2 flex items-center gap-1.5 text-[13px]"><input type="checkbox" checked={p.nextDay} onChange={(e) => set(i, { nextDay: e.target.checked })} /> Next day</label>
            <Button type="button" variant="ghost" size="sm" aria-label="Remove punch" disabled={punches.length === 1} onClick={() => setPunches(punches.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
          </div>
        ))}
        {punches.length < 6 && <Button type="button" variant="secondary" size="sm" onClick={() => setPunches([...punches, { time: '13:00', direction: 'in', nextDay: false }])}><Plus className="size-4" /> Add punch</Button>}
        <Field label="Reason" required>{(f) => <Textarea {...f} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required placeholder="For example: forgot to punch out, device was offline" />}</Field>
      </form>
    </Dialog>
  );
}

function OvertimeDialog({ day, employeeId, onClose }: { day: AttendanceDay; employeeId?: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(day.overtimeMinutes);
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Claim overtime for ${dayLabel(day.workDate)}`}
      description={`${hm(day.overtimeMinutes)} of overtime was recorded. Overtime counts for payroll once approved.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="ot-form" loading={pending}>Send for approval</Button></>}
    >
      <form
        id="ot-form"
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const r = await overtimeAction({ employeeId, workDate: day.workDate, minutes, reason: reason.trim() || undefined });
            if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
          });
        }}
      >
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Minutes" hint={`Up to ${day.overtimeMinutes}`} required>{(f) => <Input {...f} type="number" name="minutes" min={1} max={day.overtimeMinutes} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} required />}</Field>
        <Field label="Reason">{(f) => <Textarea {...f} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
      </form>
    </Dialog>
  );
}


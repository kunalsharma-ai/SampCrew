'use client';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Select, StatusPill, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { ArrowLeftRight, CalendarRange, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import { dayLabel } from '@/lib/time';
import type { Department, Location, Roster, ScheduleDay, SwapRequest } from '@/lib/types';
import { createRosterAction, requestSwapAction, swapCandidatesAction, swapResponseAction } from '../attendance/actions';

export function MySchedule({ days, swaps, employeeId }: { days: ScheduleDay[]; swaps: SwapRequest[]; employeeId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [swapDate, setSwapDate] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const respond = (id: string, action: 'accept' | 'decline' | 'cancel') => start(async () => {
    const r = await swapResponseAction(id, action);
    setNotice({ ok: r.ok, text: r.message ?? '' });
    if (r.ok) router.refresh();
  });
  return (
    <>
      <Card>
        <CardHeader title="My shifts" description="From published rosters, approved swaps, or your location's default shift." />
        {notice && <div className="px-5 pb-3"><Alert tone={notice.ok ? 'success' : 'danger'}>{notice.text}</Alert></div>}
        <Table>
          <THead><TR><TH>Date</TH><TH>Shift</TH><TH>Hours</TH><TH>Planned by</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
          <TBody>
            {days.map((d) => (
              <TR key={d.date}>
                <TD className="whitespace-nowrap font-medium">{dayLabel(d.date)}</TD>
                <TD>
                  {d.holidayName ? <Badge tone="info">Holiday: {d.holidayName}</Badge> : d.dayType === 'weekly_off' ? <Badge>Day off</Badge> : d.shift ? (
                    <span className="inline-flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: d.shift.color }} aria-hidden />{d.shift.name} ({d.shift.code})</span>
                  ) : 'No shift'}
                </TD>
                <TD className="tabular text-fg-muted">{d.shift && d.dayType !== 'weekly_off' ? `${d.shift.start} to ${d.shift.end}` : '—'}</TD>
                <TD className="text-fg-muted">{d.source === 'roster' ? 'Roster or swap' : d.source === 'policy' ? 'Default shift' : '—'}</TD>
                <TD className="text-right">{d.date > today && <Button size="sm" variant="ghost" onClick={() => setSwapDate(d.date)}><ArrowLeftRight className="size-4" /> Swap</Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      {swaps.length > 0 && (
        <Card>
          <CardHeader title="Shift swaps" description="A swap needs your colleague to accept, then your manager to approve." />
          <Table>
            <THead><TR><TH>Date</TH><TH>Between</TH><TH>Shifts</TH><TH>Status</TH><TH><span className="sr-only">Actions</span></TH></TR></THead>
            <TBody>
              {swaps.map((s) => {
                const incoming = s.counterpartId === employeeId;
                return (
                  <TR key={s.id}>
                    <TD>{dayLabel(s.workDate)}</TD>
                    <TD>{s.requesterName} and {s.counterpartName}{s.reason && <div className="text-xs text-fg-subtle">{s.reason}</div>}</TD>
                    <TD className="text-fg-muted">{s.requesterShift ?? 'Off'} ⇄ {s.counterpartShift ?? 'Off'}</TD>
                    <TD><StatusPill status={s.status} /></TD>
                    <TD className="text-right whitespace-nowrap">
                      {incoming && s.status === 'awaiting_colleague' && (
                        <>
                          <Button size="sm" loading={pending} onClick={() => respond(s.id, 'accept')}>Accept</Button>{' '}
                          <Button size="sm" variant="ghost" loading={pending} onClick={() => respond(s.id, 'decline')}>Decline</Button>
                        </>
                      )}
                      {!incoming && ['awaiting_colleague', 'pending'].includes(s.status) && <Button size="sm" variant="ghost" loading={pending} onClick={() => respond(s.id, 'cancel')}>Withdraw</Button>}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      )}
      {swapDate && <SwapDialog date={swapDate} onClose={() => setSwapDate(null)} />}
    </>
  );
}

function SwapDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [data, setData] = useState<{ myShift: string; candidates: { employeeId: string; name: string; shift: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState('');
  const [reason, setReason] = useState('');
  if (!data && !error) {
    void swapCandidatesAction(date).then((r) => (r.ok ? (setData(r.data!), setWho(r.data!.candidates[0]?.employeeId ?? '')) : setError(r.message)));
  }
  return (
    <Dialog open onClose={onClose} title={`Swap your shift on ${dayLabel(date)}`} description={data ? `Your shift: ${data.myShift}. Colleagues in your department and location who work a different shift that day:` : 'Loading colleagues…'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="swap-form" loading={pending} disabled={!who}>Ask colleague</Button></>}>
      <form id="swap-form" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await requestSwapAction({ workDate: date, counterpartEmployeeId: who, reason: reason.trim() || undefined });
          if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
        });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        {data && data.candidates.length === 0 && <Alert tone="info">No colleague in your department and location works a different shift that day.</Alert>}
        {data && data.candidates.length > 0 && (
          <Field label="Colleague">{(p) => <Select {...p} name="counterpart" value={who} onChange={(e) => setWho(e.target.value)}>{data.candidates.map((c) => <option key={c.employeeId} value={c.employeeId}>{c.name}: {c.shift}</option>)}</Select>}</Field>
        )}
        <Field label="Reason">{(p) => <Textarea {...p} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}</Field>
      </form>
    </Dialog>
  );
}

export function RostersCard({ rosters, departments, locations }: { rosters: Roster[]; departments: Department[]; locations: Location[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const monday = (() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
    return d.toISOString().slice(0, 10);
  })();
  const sunday = new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
  return (
    <Card>
      <CardHeader title="Rosters" description="Plan shifts for a team. A draft changes nothing until you publish it; publishing notifies everyone on it." action={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-4" /> New roster</Button>} />
      {rosters.length === 0 ? (
        <EmptyState icon={<CalendarRange className="size-5" />} title="No rosters yet" description="Without a roster, people work their location's default shift." />
      ) : (
        <Table>
          <THead><TR><TH>Roster</TH><TH>Dates</TH><TH>For</TH><TH>Shifts set</TH><TH>Status</TH></TR></THead>
          <TBody>
            {rosters.map((r) => (
              <TR key={r.id}>
                <TD><Link className="font-medium hover:underline" href={`/shifts/rosters/${r.id}`}>{r.name}</Link></TD>
                <TD className="text-fg-muted">{dayLabel(r.startDate)} to {dayLabel(r.endDate)}</TD>
                <TD className="text-fg-muted">{[r.departmentName, r.locationName].filter(Boolean).join(', ') || 'Everyone you schedule'}</TD>
                <TD className="tabular">{r.assignments}</TD>
                <TD><StatusPill status={r.status} /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="New roster"
        submitLabel="Create draft"
        initial={{ startDate: monday, endDate: sunday }}
        fields={[
          { name: 'name', label: 'Name', required: true, placeholder: 'Assembly, week of ...' },
          { name: 'startDate', label: 'From', type: 'date', required: true, half: true },
          { name: 'endDate', label: 'To', type: 'date', required: true, half: true, hint: 'Up to 63 days' },
          { name: 'departmentId', label: 'Department', type: 'select', options: departments.map((d) => ({ value: d.id, label: d.name })), half: true },
          { name: 'locationId', label: 'Location', type: 'select', options: locations.map((l) => ({ value: l.id, label: l.name })), half: true },
        ]}
        onSubmit={async (v) => {
          const r = await createRosterAction(v);
          if (r.ok) router.push(`/shifts/rosters/${r.data!.id}`);
          return r;
        }}
      />
    </Card>
  );
}

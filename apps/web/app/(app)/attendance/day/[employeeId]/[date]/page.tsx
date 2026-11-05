import { Alert, Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { clock, dayLabel, hm, SOURCE_LABEL } from '@/lib/time';
import type { AttendanceDay, Punch } from '@/lib/types';

export const metadata: Metadata = { title: 'Attendance day' };

interface Detail {
  employee: { id: string; name: string; code: string; timeZone: string };
  day: AttendanceDay | null;
  window: { from: string; to: string };
  punches: Punch[];
  locked: boolean;
}

/** One day in full: the decision, the reasons for it, and every raw punch behind it. */
export default async function DayPage({ params }: { params: Promise<{ employeeId: string; date: string }> }) {
  const { employeeId, date } = await params;
  const d = await load<Detail>(`/attendance/days/${employeeId}/${date}`);
  const tz = d.employee.timeZone;
  return (
    <>
      <PageHeader
        eyebrow={<Link href={`/attendance?employeeId=${employeeId}&month=${date.slice(0, 7)}`} className="hover:underline">{d.employee.name} · {d.employee.code}</Link>}
        title={dayLabel(date)}
        description={`Times in ${tz}. Punches between ${clock(d.window.from, tz)} and ${clock(d.window.to, tz)} (next day) count for this date.`}
        actions={d.day && <StatusPill status={d.day.status} />}
      />
      <div className="grid gap-6">
        {d.locked && <Alert tone="info">This date is in a period locked for payroll. The result below is frozen until HR unlocks it.</Alert>}
        {d.day ? (
          <Card>
            <CardHeader title="How this day was counted" description={d.day.shiftCode ? `Shift ${d.day.shiftCode} ${d.day.shiftStart} to ${d.day.shiftEnd}` : 'No shift'} />
            <CardBody className="grid gap-4">
              <ol className="list-decimal space-y-1 pl-5 text-sm">{d.day.explanation.map((e, i) => <li key={i}>{e}</li>)}</ol>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {[
                  ['First in', clock(d.day.firstIn, tz)], ['Last out', clock(d.day.lastOut, tz)], ['Worked', hm(d.day.workedMinutes)], ['Breaks', hm(d.day.breakMinutes)],
                  ['Late', d.day.lateMinutes ? `${d.day.lateMinutes} min` : '—'], ['Left early', d.day.earlyLeaveMinutes ? `${d.day.earlyLeaveMinutes} min` : '—'],
                  ['Overtime', hm(d.day.overtimeMinutes)], ['Overtime approved', hm(d.day.approvedOvertimeMinutes)],
                ].map(([k, v]) => <div key={k}><dt className="text-fg-subtle">{k}</dt><dd className="font-medium tabular">{v}</dd></div>)}
              </dl>
              {d.day.flags.length > 0 && <div className="flex flex-wrap gap-1.5">{d.day.flags.map((f) => <Badge key={f} tone="warning">{f.replace(/_/g, ' ')}</Badge>)}</div>}
            </CardBody>
          </Card>
        ) : (
          <Alert tone="info">This day has not been computed yet.</Alert>
        )}
        <Card>
          <CardHeader title="Raw punches" description="Exactly as received. Punches are never edited; corrections add new ones." />
          {d.punches.length === 0 ? (
            <EmptyState title="No punches" />
          ) : (
            <Table>
              <THead><TR><TH>Time</TH><TH>Type</TH><TH>Source</TH><TH>Verified by</TH><TH>Location check</TH><TH>Note</TH></TR></THead>
              <TBody>
                {d.punches.map((p) => (
                  <TR key={p.id}>
                    <TD className="tabular">{clock(p.at, tz)}{p.at.slice(0, 10) !== date ? ' (next day)' : ''}</TD>
                    <TD>{p.direction === 'unknown' ? 'Not given' : p.direction === 'in' ? 'In' : 'Out'}</TD>
                    <TD>{p.device ? `Device: ${p.device}` : SOURCE_LABEL[p.source] ?? p.source}</TD>
                    <TD className="text-fg-muted">{p.verifyMethod ?? '—'}</TD>
                    <TD>{p.geofence ? <Badge tone={p.geofence === 'outside' ? 'warning' : p.geofence === 'inside' || p.geofence === 'kiosk' ? 'success' : 'neutral'}>{p.geofence.replace(/_/g, ' ')}</Badge> : '—'}</TD>
                    <TD className="text-fg-muted">{p.note ?? ''}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

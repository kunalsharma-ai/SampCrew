'use client';
import { Alert, Button, Card, CardBody, EmptyState } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { RosterGrid, ShiftTemplate } from '@/lib/types';
import { deleteRosterAction, publishRosterAction, saveAssignmentsAction } from '../../../attendance/actions';

const OFF = 'off';
const short = (date: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

/** A grid of people by day. Each cell is the shift that will apply, editable when the caller schedules everyone on it. */
export function RosterEditor({ roster, shifts }: { roster: RosterGrid; shifts: ShiftTemplate[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [changes, setChanges] = useState<Record<string, string>>({});
  const dates = roster.rows[0]?.cells.map((c) => c.date) ?? [];
  const key = (e: string, d: string) => `${e}|${d}`;
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) => start(async () => {
    const r = await fn();
    setNotice({ ok: r.ok, text: r.message ?? '' });
    if (r.ok) { setChanges({}); after?.(); router.refresh(); }
  });
  if (!roster.rows.length) return <Card><EmptyState title="Nobody on this roster" description="No one you can see works in this roster's department and location during these dates." /></Card>;
  return (
    <Card>
      <CardBody className="grid gap-4 pt-5">
        {notice && <Alert tone={notice.ok ? 'success' : 'danger'}>{notice.text}</Alert>}
        {!roster.canEdit && <Alert tone="info">You can view this roster but some people on it are outside the team you schedule.</Alert>}
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-0 text-[0.8125rem]">
            <thead>
              <tr>
                <th className="sticky left-0 bg-surface px-2 py-2 text-left font-medium text-fg-subtle">Employee</th>
                {dates.map((d) => <th key={d} className="px-1 py-2 text-left font-medium text-fg-subtle whitespace-nowrap">{short(d)}</th>)}
              </tr>
            </thead>
            <tbody>
              {roster.rows.map((r) => (
                <tr key={r.employeeId} className="border-t border-border">
                  <td className="sticky left-0 bg-surface px-2 py-1.5 whitespace-nowrap"><span className="font-medium">{r.name}</span> <span className="text-fg-subtle">{r.code}</span></td>
                  {r.cells.map((c) => {
                    const value = changes[key(r.employeeId, c.date)] ?? (c.dayType === 'weekly_off' && !c.shiftId ? OFF : c.shiftId ?? OFF);
                    return (
                      <td key={c.date} className="px-1 py-1">
                        <select
                          aria-label={`${r.name} on ${c.date}`}
                          title={c.holidayName ? `Holiday: ${c.holidayName}` : c.inRoster ? 'Set in this roster' : 'Default for this day'}
                          disabled={!roster.canEdit}
                          className={`h-8 w-full min-w-24 rounded-md border px-1 ${changes[key(r.employeeId, c.date)] ? 'border-accent' : c.inRoster ? 'border-border-strong' : 'border-border text-fg-muted'} bg-surface`}
                          value={value}
                          onChange={(e) => setChanges({ ...changes, [key(r.employeeId, c.date)]: e.target.value })}
                        >
                          <option value={OFF}>Off</option>
                          {shifts.map((s) => <option key={s.id} value={s.id}>{s.code} {s.startTime}</option>)}
                        </select>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {roster.canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button loading={pending} disabled={!Object.keys(changes).length} onClick={() => run(() => saveAssignmentsAction(roster.id, Object.entries(changes).map(([k, v]) => {
              const [employeeId, workDate] = k.split('|') as [string, string];
              return { employeeId, workDate, shiftTemplateId: v === OFF ? null : v };
            })))}>Save {Object.keys(changes).length || ''} change{Object.keys(changes).length === 1 ? '' : 's'}</Button>
            {roster.status === 'draft' && (
              <>
                <Button variant="secondary" loading={pending} disabled={Object.keys(changes).length > 0} onClick={() => { if (confirm('Publish this roster? Its shifts apply and everyone on it is notified.')) run(() => publishRosterAction(roster.id)); }}>Publish</Button>
                <Button variant="ghost" loading={pending} onClick={() => { if (confirm('Delete this draft roster?')) run(() => deleteRosterAction(roster.id), () => router.push('/shifts')); }}>Delete draft</Button>
              </>
            )}
          </div>
        )}
        <p className="text-xs text-fg-subtle">Muted cells show the default (location shift or weekly off). Cells with a darker border are set in this roster.</p>
      </CardBody>
    </Card>
  );
}

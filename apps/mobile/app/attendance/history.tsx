import { useMemo, useState } from 'react';
import { useMobileApp } from '../../src/lib/mobile-app';
import { dayStatus } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { AttendanceRange } from '../../src/lib/types';
import { Badge, Card, CardTitle, fmt, ListItem, Notice, Screen, Tile, TileGrid, useLoad, useTheme } from '../../src/ui';
import { type DayMark, monthBounds, monthOf, MonthCalendar } from '../../src/ui/calendar';
import { ModuleGate, SkeletonCard } from '../../src/ui/kit';

const hours = (min: number) => {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};

/** The person's month: a calendar coloured by day status, the summary, and each day's punches and hours. */
function History() {
  const { api } = useSession();
  const { has } = useMobileApp();
  const t = useTheme();
  const [month, setMonth] = useState(() => monthOf(new Date().toISOString()));
  const { from, to } = monthBounds(month);
  const { data, error, loading } = useLoad(() => api.get<AttendanceRange>(`/attendance/days?from=${from}&to=${to}`), [api, from, to]);
  const color: Record<string, string> = { present: t.ok, absent: t.danger, half_day: t.warn, on_leave: t.accent, missing_punch: t.danger, holiday: t.muted, weekly_off: t.muted, incomplete: t.warn, in_progress: t.accent };
  const marks = useMemo(() => {
    const m = new Map<string, DayMark[]>();
    for (const d of data?.days ?? []) m.set(d.workDate, [{ color: color[d.status] ?? t.muted, pending: d.status === 'in_progress', label: dayStatus[d.status] ?? d.status }]);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, t]);
  const s = data?.summary;
  const past = (data?.days ?? []).filter((d) => d.firstIn || d.status !== 'not_started').slice().reverse();

  return (
    <Screen>
      {error && <Notice tone="danger">{error}</Notice>}
      {has('attendance.calendar') && <Card testID="attendance-calendar"><MonthCalendar month={month} onMonthChange={setMonth} marks={marks} today={new Date().toISOString().slice(0, 10)} /></Card>}
      {!data && loading && <SkeletonCard lines={5} />}
      {s && has('attendance.summary') && (
        <TileGrid>
          <Tile testID="month-present" tone="green" icon="checkmark-circle" value={String(s.present)} label="Present" hint={`${s.halfDay} half day${s.halfDay === 1 ? '' : 's'}`} />
          <Tile testID="month-late" tone="orange" icon="alarm" value={String(s.late)} label="Late" hint={`${s.absent} absent · ${s.missingPunch} missing punch`} />
          <Tile testID="month-leave" tone="blue" icon="sunny" value={String(s.onLeave)} label="On leave" hint={fmt.month(month)} />
          <Tile testID="month-hours" tone="violet" icon="time" value={hours(s.workedMinutes)} label="Worked" hint={s.overtimeMinutes ? `${hours(s.overtimeMinutes)} overtime` : 'No overtime'} />
        </TileGrid>
      )}
      {data && has('attendance.history') && (
        <Card testID="attendance-days">
          <CardTitle help="attendance.history">{fmt.month(month)}</CardTitle>
          {past.length === 0 && <ListItem title="No attendance recorded this month yet." />}
          {past.map((d) => (
            <ListItem
              key={d.workDate}
              title={fmt.date(d.workDate)}
              subtitle={[
                d.firstIn ? `In ${fmt.time(d.firstIn)}` : null,
                d.lastOut ? `out ${fmt.time(d.lastOut)}` : null,
                d.workedMinutes ? `${hours(d.workedMinutes)} worked` : null,
                d.breakMinutes ? `${hours(d.breakMinutes)} break` : null,
                d.lateMinutes ? `${d.lateMinutes} min late` : null,
              ].filter(Boolean).join(' · ') || (d.shiftName ?? undefined)}
              right={<Badge tone={d.status === 'present' ? 'ok' : d.status === 'absent' || d.status === 'missing_punch' ? 'danger' : 'neutral'}>{dayStatus[d.status] ?? d.status.replace(/_/g, ' ')}</Badge>}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function AttendanceHistoryScreen() {
  return (
    <ModuleGate module="attendance">
      <History />
    </ModuleGate>
  );
}

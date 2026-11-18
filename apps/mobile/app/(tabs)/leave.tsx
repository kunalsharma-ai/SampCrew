import { useRouter } from 'expo-router';
import { useState } from 'react';
import { leaveStatus } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { Balance, LeaveCalendar, LeaveRequest } from '../../src/lib/types';
import { type DayMark, MonthCalendar, monthBounds } from '../../src/ui/calendar';
import { Badge, Button, Card, CardTitle, Empty, errorText, fmt, ListItem, Meter, Notice, Row, Screen, Text, Tile, TileGrid, Title, useLoad, useReloadOnFocus } from '../../src/ui';

export default function Leave() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(async () => {
    const [b, r] = await Promise.all([api.get<{ year: number; balances: Balance[] }>('/leave/balances'), api.get<LeaveRequest[]>('/leave/requests')]);
    return { balances: b.balances.filter((x) => x.tracked), year: b.year, requests: r };
  }, [api]);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const { data: cal, reload: reloadCal } = useLoad(() => {
    const { from, to } = monthBounds(month);
    return api.get<LeaveCalendar>(`/leave/calendar?from=${from}&to=${to}`);
  }, [api, month]);
  useReloadOnFocus(reload);
  useReloadOnFocus(reloadCal);
  const marks = new Map<string, DayMark[]>();
  for (const r of cal?.requests ?? []) {
    for (let d = r.startDate; d <= r.endDate; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      marks.set(d, [...(marks.get(d) ?? []), { color: /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : '#4f46e5', pending: r.status === 'pending', label: `${r.leaveTypeName} ${r.status}` }]);
    }
  }
  const holidays = new Map((cal?.holidays ?? []).map((h) => [h.date, { name: h.name, optional: h.optional }]));
  const today = new Date().toISOString().slice(0, 10);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  const cancel = async (id: string) => {
    try {
      await api.post(`/leave/requests/${id}/cancel`, { reason: 'Cancelled from the mobile app' });
      setMsg({ tone: 'ok', text: 'Request cancelled.' });
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      <Title>Leave</Title>
      {error && <Notice tone="danger">{error}</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {data && (
        <TileGrid>
          <Tile testID="tile-available" tone="orange" icon="☼" value={String(Number(data.balances.reduce((s, b) => s + Number(b.available), 0).toFixed(1)))} label="Days available" hint={`Across ${data.balances.length} leave type${data.balances.length === 1 ? '' : 's'}`} />
          <Tile testID="tile-pending" tone="pink" icon="…" value={String(data.requests.filter((r) => r.status === 'pending').length)} label="Waiting for approval" hint={`${data.requests.filter((r) => r.status === 'approved').length} approved`} />
        </TileGrid>
      )}
      <Button title="Apply for leave" onPress={() => router.push('/leave/new')} testID="apply-leave" />
      <Card testID="leave-calendar">
        <CardTitle help="leave.requests">My leave calendar</CardTitle>
        <MonthCalendar
          month={month}
          onMonthChange={setMonth}
          marks={marks}
          holidays={holidays}
          weeklyOffs={cal?.weeklyOffs ?? []}
          today={today}
          onSelect={(d) => {
            const h = holidays.get(d);
            if (marks.has(d) || (h && !h.optional) || cal?.weeklyOffs.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) return;
            router.push(`/leave/new?date=${d}`);
          }}
        />
        <Text size={12} muted>Solid bar: approved leave. Dashed: waiting for approval. Dot: public holiday. Tap a working day to apply from that day.</Text>
        {(cal?.holidays.length ?? 0) > 0 && <Text size={12} muted>{cal!.holidays.map((h) => `${fmt.date(h.date)} ${h.name}${h.optional ? ' (optional)' : ''}`).join(' · ')}</Text>}
      </Card>
      <Card testID="balances">
        <CardTitle help="leave.balances">{data ? `Balances ${data.year}` : 'Balances'}</CardTitle>
        {data?.balances.length === 0 && <Empty>No leave balances.</Empty>}
        {data?.balances.map((b) => {
          // The bar shows what is left of what the person has (available plus already pending or used is the balance).
          const total = Math.max(Number(b.balance), Number(b.available));
          return (
            <Meter
              key={b.leaveTypeId}
              label={b.name}
              value={Number(b.available)}
              max={total}
              color={/^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : undefined}
              caption={`${b.available} days${Number(b.pending) > 0 ? ` (${b.pending} pending)` : ''}`}
            />
          );
        })}
      </Card>
      <Card testID="leave-requests">
        <CardTitle help="leave.requests">My requests</CardTitle>
        {data?.requests.length === 0 && <Empty>No leave requests yet.</Empty>}
        {data?.requests.map((r) => {
          const s = leaveStatus[r.status] ?? { label: r.status, tone: 'neutral' as const };
          return (
            <ListItem
              key={r.id}
              title={`${r.leaveTypeName}, ${r.days} day${r.days === '1.00' ? '' : 's'}`}
              subtitle={`${fmt.date(r.startDate)}${r.endDate !== r.startDate ? ` to ${fmt.date(r.endDate)}` : ''}${r.reason ? ` · ${r.reason}` : ''}${r.status === 'pending' && r.waitingOn ? ` · waiting for ${r.waitingOn}` : ''}`}
              right={
                <Row>
                  <Badge tone={s.tone}>{s.label}</Badge>
                  {r.status === 'pending' && <Button title="Cancel" kind="secondary" onPress={() => cancel(r.id)} />}
                </Row>
              }
            />
          );
        })}
      </Card>
    </Screen>
  );
}

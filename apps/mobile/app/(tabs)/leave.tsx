import { useRouter } from 'expo-router';
import { useState } from 'react';
import { leaveStatus } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { Balance, LeaveRequest } from '../../src/lib/types';
import { Badge, Button, Card, Empty, errorText, fmt, ListItem, Notice, Row, Screen, Text, Title, useLoad, useReloadOnFocus } from '../../src/ui';

export default function Leave() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(async () => {
    const [b, r] = await Promise.all([api.get<{ year: number; balances: Balance[] }>('/leave/balances'), api.get<LeaveRequest[]>('/leave/requests')]);
    return { balances: b.balances.filter((x) => x.tracked), year: b.year, requests: r };
  }, [api]);
  useReloadOnFocus(reload);
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
      <Button title="Apply for leave" onPress={() => router.push('/leave/new')} testID="apply-leave" />
      <Card testID="balances">
        <Text weight="700">{data ? `Balances ${data.year}` : 'Balances'}</Text>
        {data?.balances.length === 0 && <Empty>No leave balances.</Empty>}
        {data?.balances.map((b) => (
          <Row key={b.leaveTypeId} style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
            <Text>{b.name}</Text>
            <Text weight="600">{`${b.available} days${Number(b.pending) > 0 ? ` (${b.pending} pending)` : ''}`}</Text>
          </Row>
        ))}
      </Card>
      <Card testID="leave-requests">
        <Text weight="700">My requests</Text>
        {data?.requests.length === 0 && <Empty>No leave requests yet.</Empty>}
        {data?.requests.map((r) => {
          const s = leaveStatus[r.status] ?? { label: r.status, tone: 'neutral' as const };
          return (
            <ListItem
              key={r.id}
              title={`${r.leaveTypeName}, ${r.days} day${r.days === '1.00' ? '' : 's'}`}
              subtitle={`${fmt.date(r.startDate)}${r.endDate !== r.startDate ? ` to ${fmt.date(r.endDate)}` : ''}${r.reason ? ` · ${r.reason}` : ''}`}
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

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { caseStatus, target } from '../../src/lib/labels';
import { useSession } from '../../src/lib/session';
import type { CaseRow } from '../../src/lib/types';
import { Badge, Button, Card, Choice, Empty, fmt, ListItem, Notice, Row, Screen, Text, Title, useLoad, useReloadOnFocus, CardTitle } from '../../src/ui';

export default function Helpdesk() {
  const { api } = useSession();
  const router = useRouter();
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const { data, error, loading, reload } = useLoad(() => api.get<CaseRow[]>(`/helpdesk/cases?view=mine${filter === 'active' ? '&status=active' : ''}`), [api, filter]);
  useReloadOnFocus(reload);

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      <Title>Ask HR</Title>
      <Text muted>Questions about pay, leave, documents or anything else. Only you and HR can see your cases.</Text>
      {error && <Notice tone="danger">{error}</Notice>}
      <Button title="New question" onPress={() => router.push('/helpdesk/new')} testID="new-case" />
      <Card testID="my-cases">
        <Row style={{ justifyContent: 'space-between' }}>
          <CardTitle help="helpdesk.cases">My cases</CardTitle>
          <Choice value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Open' }, { value: 'all', label: 'All' }]} />
        </Row>
        {data?.length === 0 && <Empty>{filter === 'active' ? 'No open cases.' : 'No cases yet.'}</Empty>}
        {data?.map((c) => (
          <ListItem
            key={c.id}
            title={`${c.ref} · ${c.subject}`}
            subtitle={`${c.categoryName} · updated ${fmt.dateTime(c.updatedAt)}`}
            right={
              <Badge tone={c.status === 'waiting_on_employee' ? 'warn' : c.status === 'resolved' ? 'ok' : c.resolution === 'overdue' ? 'danger' : 'neutral'}>
                {c.status === 'resolved' || c.status === 'closed' || c.status === 'waiting_on_employee' ? caseStatus[c.status] : c.resolution === 'overdue' ? target.overdue.label : caseStatus[c.status]}
              </Badge>
            }
            onPress={() => router.push(`/helpdesk/${c.id}`)}
          />
        ))}
      </Card>
    </Screen>
  );
}

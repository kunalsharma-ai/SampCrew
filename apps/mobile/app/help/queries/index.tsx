import { HELP_QUERY_STATUS_LABEL, type HelpQueryList } from '@crew/contracts';
import { useRouter } from 'expo-router';
import { useSession } from '../../../src/lib/session';
import { Badge, Button, Card, Empty, ListItem, Notice, Screen, Text, fmt, useLoad, useReloadOnFocus } from '../../../src/ui';

export default function MyQueriesScreen() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, reload, loading } = useLoad(() => api.get<HelpQueryList>('/help/queries'), [api]);
  useReloadOnFocus(reload);
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {error && <Notice tone="danger">{error}</Notice>}
      <Button title="Raise a Query" onPress={() => router.push('/help/ask')} testID="queries-raise" />
      <Card testID="query-rows">
        {data?.items.map((q) => (
          <ListItem key={q.id} title={`${q.ticketId} · ${q.subject}`} subtitle={`${q.statusLabel}${q.unread ? ' · New reply' : ''} · ${fmt.date(q.lastMessageAt)}`}
            right={<Badge tone={q.status === 'resolved' ? 'ok' : q.status === 'awaiting_user' ? 'warn' : q.status === 'closed' ? 'neutral' : 'info'}>{HELP_QUERY_STATUS_LABEL[q.status].split(' ')[0]!}</Badge>}
            onPress={() => router.push(`/help/queries/${q.id}`)} testID="query-row" />
        ))}
        {data && !data.items.length && <Empty>You have not raised any queries.</Empty>}
        {data && <Text muted size={12}>{`${data.counts.all ?? 0} in all`}</Text>}
      </Card>
    </Screen>
  );
}

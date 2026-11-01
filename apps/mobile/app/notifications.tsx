import { useRouter } from 'expo-router';
import { appRoute } from '../src/lib/format';
import { useSession } from '../src/lib/session';
import type { Notification } from '../src/lib/types';
import { Badge, Button, Card, Empty, fmt, ListItem, Notice, Screen, useLoad } from '../src/ui';

export default function Notifications() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, reload, loading } = useLoad(() => api.get<{ unread: number; items: Notification[] }>('/notifications?limit=50'), [api]);
  const open = async (n: Notification) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`).catch(() => undefined);
    const route = appRoute(n.link);
    if (route) router.push(route as never);
    else void reload();
  };
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {error && <Notice tone="danger">{error}</Notice>}
      {data && data.unread > 0 && <Button title="Mark all read" kind="secondary" onPress={() => api.post('/notifications/read-all').then(reload, reload)} />}
      <Card>
        {data?.items.length === 0 && <Empty>No notifications.</Empty>}
        {data?.items.map((n) => (
          <ListItem key={n.id} title={n.title} subtitle={`${n.body ? `${n.body} · ` : ''}${fmt.dateTime(n.createdAt)}`} right={!n.readAt ? <Badge tone="info">New</Badge> : undefined} onPress={() => open(n)} />
        ))}
      </Card>
    </Screen>
  );
}

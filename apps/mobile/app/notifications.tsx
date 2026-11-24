import { NOTIFICATION_CATEGORIES } from '@crew/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useBadges } from '../src/lib/badges';
import { appRoute } from '../src/lib/format';
import { useSession } from '../src/lib/session';
import type { Notification } from '../src/lib/types';
import { Badge, Button, Card, Choice, Empty, fmt, Notice, Row, Screen, Text, useLoad, useTheme } from '../src/ui';
import { Icon, ModuleGate } from '../src/ui/kit';

const LABEL = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c.key, c.label])) as Record<string, string>;
type Filter = 'all' | 'unread' | 'action';

/**
 * Notifications on the phone: the same notices as the Web Portal's bell, Home and module pages (one read state, shown
 * everywhere), with unread and action-needed filters, the category each came from, and read or unread per notice.
 */
function NotificationsBody() {
  const { api } = useSession();
  const badges = useBadges();
  const router = useRouter();
  const t = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const [more, setMore] = useState<Notification[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const query = filter === 'unread' ? '&unread=true' : filter === 'action' ? '&unread=true&action=true' : '';
  const { data, error, reload, loading } = useLoad(async () => {
    const r = await api.get<{ unread: number; items: Notification[]; nextBefore?: string | null }>(`/notifications?limit=30${query}`);
    setMore([]);
    setNext(r.nextBefore ?? null);
    return r;
  }, [api, query]);
  const after = () => {
    void reload();
    badges.refresh();
  };
  const open = async (n: Notification) => {
    if (!n.readAt) await api.post(`/notifications/${n.id}/read`).catch(() => undefined);
    badges.refresh();
    const route = appRoute(n.link);
    if (route) router.push(route as never);
    else void reload();
  };
  const toggle = (n: Notification) => api.post(`/notifications/${n.id}/${n.readAt ? 'unread' : 'read'}`).then(after, after);
  const loadMore = async () => {
    if (!next) return;
    const r = await api.get<{ items: Notification[]; nextBefore?: string | null }>(`/notifications?limit=30${query}&before=${encodeURIComponent(next)}`);
    setMore((cur) => [...cur, ...r.items]);
    setNext(r.nextBefore ?? null);
  };
  const items = [...(data?.items ?? []), ...more];
  return (
    <Screen onRefresh={after} refreshing={loading && !!data}>
      {error && <Notice tone="danger">{error}</Notice>}
      <Choice<Filter> value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: `Unread${data?.unread ? ` (${data.unread})` : ''}` }, { value: 'action', label: 'Action needed' }]} />
      <Row style={{ justifyContent: 'space-between' }}>
        {data && data.unread > 0 ? <Button title="Mark all read" kind="secondary" onPress={() => api.post('/notifications/read-all').then(after, after)} testID="notifications-read-all" /> : <View />}
        <Button title="Settings" kind="secondary" onPress={() => router.push('/notification-settings' as never)} testID="notification-settings-open" />
      </Row>
      <Card testID="notification-list">
        {items.length === 0 && data && <Empty>{filter === 'action' ? 'Nothing is waiting for you.' : filter === 'unread' ? 'You are all caught up.' : 'No notifications.'}</Empty>}
        {items.map((n) => (
          <View key={n.id} testID="notification-row" style={{ flexDirection: 'row', gap: 10, paddingVertical: 10, borderBottomWidth: 0.5, borderBottomColor: t.border }}>
            <View style={{ width: 4, borderRadius: 2, backgroundColor: n.readAt ? 'transparent' : n.priority === 'urgent' ? t.danger : n.priority === 'high' ? t.warn : t.accent }} />
            <Pressable style={{ flex: 1, gap: 2 }} accessibilityRole="link" onPress={() => void open(n)}>
              <Row style={{ gap: 6, flexWrap: 'wrap' }}>
                <Text weight={n.readAt ? '500' : '700'}>{n.title}</Text>
                {!n.readAt && n.actionRequired && <Badge tone="warn">Action needed</Badge>}
                {!n.readAt && n.priority === 'urgent' && <Badge tone="danger">Urgent</Badge>}
                {!n.readAt && n.priority === 'high' && <Badge tone="warn">Important</Badge>}
              </Row>
              {n.body ? <Text size={13} muted numberOfLines={2}>{n.body}</Text> : null}
              <Text size={12} muted>{`${n.category ? `${LABEL[n.category] ?? 'SampCrew'} · ` : ''}${fmt.dateTime(n.updatedAt ?? n.createdAt)}`}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={n.readAt ? `Mark ${n.title} unread` : `Mark ${n.title} read`} onPress={() => void toggle(n)} hitSlop={8} style={{ padding: 4 }} testID="notification-toggle">
              <Icon name={n.readAt ? 'mail-outline' : 'mail-open-outline'} size={18} color={t.muted} />
            </Pressable>
          </View>
        ))}
        {next && <Button title="Show older" kind="secondary" onPress={() => void loadMore()} />}
      </Card>
    </Screen>
  );
}

export default function Notifications() {
  return (
    <ModuleGate module="notifications">
      <NotificationsBody />
    </ModuleGate>
  );
}

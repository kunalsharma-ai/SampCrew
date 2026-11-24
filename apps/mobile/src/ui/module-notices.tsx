import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useBadges } from '../lib/badges';
import { appRoute } from '../lib/format';
import { useSession } from '../lib/session';
import type { Notification } from '../lib/types';
import { Badge, Card, CardTitle, Row, Text, useLoad, useReloadOnFocus, useTheme } from './index';

/**
 * New notices about one module at the top of its screen (Leave, Attendance, Approvals, Learning), the same ones the
 * bell and Home show: reading one here marks it read everywhere, the Web Portal included.
 */
export function ModuleNotices({ category, label }: { category: string; label: string }) {
  const { api } = useSession();
  const badges = useBadges();
  const router = useRouter();
  const t = useTheme();
  const { data, reload } = useLoad(() => api.get<{ items: Notification[] }>(`/notifications?category=${category}&unread=true&limit=3`).catch(() => ({ items: [] })), [api, category]);
  useReloadOnFocus(reload);
  if (!data?.items.length) return null;
  const read = async (n: Notification, go: boolean) => {
    await api.post(`/notifications/${n.id}/read`).catch(() => undefined);
    badges.refresh();
    void reload();
    const route = go ? appRoute(n.link) : null;
    if (route) router.push(route as never);
  };
  const readAll = async () => {
    await api.post('/notifications/read-all', { category }).catch(() => undefined);
    badges.refresh();
    void reload();
  };
  return (
    <Card testID={`module-notices-${category}`}>
      <CardTitle right={<Pressable onPress={() => void readAll()} hitSlop={8} accessibilityRole="button"><Text size={13} weight="600" style={{ color: t.accent }}>Mark all read</Text></Pressable>}>{`${data.items.length} new ${label.toLowerCase()} notice${data.items.length === 1 ? '' : 's'}`}</CardTitle>
      {data.items.map((n) => (
        <Pressable key={n.id} onPress={() => void read(n, true)} accessibilityRole="link" style={{ flexDirection: 'row', gap: 8, paddingVertical: 6 }}>
          <View style={{ width: 3, borderRadius: 2, backgroundColor: n.priority === 'urgent' ? t.danger : n.priority === 'high' ? t.warn : t.accent }} />
          <View style={{ flex: 1 }}>
            <Row style={{ gap: 6, flexWrap: 'wrap' }}>
              <Text weight="600" size={14}>{n.title}</Text>
              {n.actionRequired && <Badge tone="warn">Action needed</Badge>}
            </Row>
            {n.body ? <Text size={12} muted numberOfLines={1}>{n.body}</Text> : null}
          </View>
        </Pressable>
      ))}
    </Card>
  );
}

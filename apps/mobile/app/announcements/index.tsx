import { useRouter } from 'expo-router';
import { useSession } from '../../src/lib/session';
import type { Announcement } from '../../src/lib/types';
import { Badge, Card, fmt, Notice, Screen, useLoad, useReloadOnFocus } from '../../src/ui';
import { EmptyState, IconRow, ModuleGate, SkeletonCard } from '../../src/ui/kit';

/** Announcements addressed to the person, pinned first, with what still needs an acknowledgement. */
function Announcements() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(() => api.get<Announcement[]>('/announcements'), [api], api.peek<Announcement[]>('/announcements'));
  useReloadOnFocus(reload);
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {error && <Notice tone={data ? 'warn' : 'danger'}>{error}</Notice>}
      {!data && !error && <SkeletonCard lines={5} />}
      {data?.length === 0 && <EmptyState icon="megaphone" tone="orange" title="No announcements" body="Company news addressed to you shows here." />}
      {data && data.length > 0 && (
        <Card testID="announcements-list">
          {data.map((a) => (
            <IconRow
              key={a.id}
              icon={a.pinned ? 'pin' : 'megaphone'}
              tone="orange"
              title={a.title}
              subtitle={`${fmt.date(a.publishedAt)}${a.publishedByName ? ` · ${a.publishedByName}` : ''}`}
              right={a.requiresAck && !a.acknowledgedAt ? <Badge tone="warn">Acknowledge</Badge> : !a.readAt ? <Badge tone="info">New</Badge> : undefined}
              onPress={() => router.push(`/announcements/${a.id}`)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function AnnouncementsScreen() {
  return (
    <ModuleGate module="announcements">
      <Announcements />
    </ModuleGate>
  );
}

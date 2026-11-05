import { useRouter } from 'expo-router';
import { useSession } from '../../src/lib/session';
import type { Announcement, InboxItem, Notification, Today } from '../../src/lib/types';
import { dayStatus } from '../../src/lib/labels';
import { Badge, Button, Card, DemoBanner, Empty, fmt, ListItem, Notice, Row, Screen, Text, Title, useLoad, useReloadOnFocus } from '../../src/ui';

export default function Home() {
  const { api, me, hasFeature, can, queue } = useSession();
  const router = useRouter();
  const attendance = hasFeature('attendance_basic') && can('attendance:punch');
  const hasNews = hasFeature('announcements') && can('announcements:read');
  const { data, error, loading, reload } = useLoad(async () => {
    const [today, inbox, notes, news] = await Promise.all([
      attendance ? api.get<Today>('/attendance/today').catch(() => null) : null,
      api.get<InboxItem[]>('/approvals/inbox').catch(() => []),
      api.get<{ unread: number; items: Notification[] }>('/notifications?limit=5'),
      hasNews ? api.get<Announcement[]>('/announcements') : [],
    ]);
    return { today, inbox, notes, news };
  }, [api, attendance, hasNews]);
  useReloadOnFocus(reload);

  const firstName = me?.user.fullName.split(' ')[0] ?? '';
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      <Title>Hello{firstName ? `, ${firstName}` : ''}</Title>
      <Text muted>{me?.tenant.name}</Text>
      <DemoBanner show={!!me?.tenant.isDemo} />
      {error && <Notice tone={data ? 'warn' : 'danger'}>{data ? `Showing what was loaded earlier. ${error}` : error}</Notice>}
      {queue.pending.length > 0 && (
        <Notice tone="warn" testID="home-queue">{`${queue.pending.length} punch${queue.pending.length === 1 ? '' : 'es'} waiting to be sent. They are saved on this phone.`}</Notice>
      )}

      {data?.today && (
        <Card testID="home-today">
          <Row style={{ justifyContent: 'space-between' }}>
            <Text weight="700">Today</Text>
            {data.today.day && <Badge>{dayStatus[data.today.day.status] ?? data.today.day.status}</Badge>}
          </Row>
          <Text muted size={14}>
            {data.today.shift ? `${data.today.shift.name}, ${data.today.shift.start} to ${data.today.shift.end}` : 'No shift planned'}
            {data.today.holidayName ? ` · ${data.today.holidayName}` : ''}
          </Text>
          <Button title={data.today.nextDirection === 'in' ? 'Punch in' : 'Punch out'} onPress={() => router.push('/attendance')} />
        </Card>
      )}

      {data && data.inbox.length > 0 && (
        <Card>
          <Text weight="700">Waiting for your approval</Text>
          <Text muted size={14}>{`${data.inbox.length} request${data.inbox.length === 1 ? '' : 's'}`}</Text>
          <Button title="Review requests" kind="secondary" onPress={() => router.push('/approvals')} testID="home-approvals" />
        </Card>
      )}

      {hasNews && (
        <Card testID="home-announcements">
          <Text weight="700">Announcements</Text>
          {data?.news.length === 0 && <Empty>No announcements.</Empty>}
          {data?.news.slice(0, 5).map((a) => (
            <ListItem
              key={a.id}
              title={a.title}
              subtitle={`${fmt.date(a.publishedAt)}${a.publishedByName ? ` · ${a.publishedByName}` : ''}`}
              right={a.requiresAck && !a.acknowledgedAt ? <Badge tone="warn">Please acknowledge</Badge> : !a.readAt ? <Badge tone="info">New</Badge> : a.pinned ? <Badge>Pinned</Badge> : undefined}
              onPress={() => router.push(`/announcements/${a.id}`)}
            />
          ))}
        </Card>
      )}

      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text weight="700">Notifications</Text>
          {data && data.notes.unread > 0 && <Badge tone="info">{`${data.notes.unread} unread`}</Badge>}
        </Row>
        {data?.notes.items.length === 0 && <Empty>Nothing new.</Empty>}
        {data?.notes.items.map((n) => (
          <ListItem key={n.id} title={n.title} subtitle={fmt.dateTime(n.createdAt)} right={!n.readAt ? <Badge tone="info">New</Badge> : undefined} />
        ))}
        <Button title="All notifications" kind="secondary" onPress={() => router.push('/notifications')} />
      </Card>
    </Screen>
  );
}

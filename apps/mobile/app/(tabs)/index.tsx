import { useRouter } from 'expo-router';
import { useSession } from '../../src/lib/session';
import type { Announcement, Balance, InboxItem, Notification, Today } from '../../src/lib/types';
import { dayStatus } from '../../src/lib/labels';
import { Badge, Button, Card, CardTitle, DemoBanner, Empty, fmt, Hero, ListItem, Notice, QuickActions, Screen, Text, Tile, TileGrid, useLoad, useReloadOnFocus } from '../../src/ui';

/** The part of the day it is where the person is, for the greeting. */
function partOfDay(timeZone: string | undefined): string {
  let h = new Date().getHours();
  try {
    h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(new Date()));
  } catch {
    // An unknown zone name: use the phone's clock.
  }
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const { api, me, hasFeature, can, queue } = useSession();
  const router = useRouter();
  const attendance = hasFeature('attendance_basic') && can('attendance:punch');
  const hasNews = hasFeature('announcements') && can('announcements:read');
  const leave = hasFeature('leave');
  const helpdesk = hasFeature('helpdesk') && can('helpdesk:use');
  const { data, error, loading, reload } = useLoad(async () => {
    const [today, inbox, notes, news, balances] = await Promise.all([
      attendance ? api.get<Today>('/attendance/today').catch(() => null) : null,
      api.get<InboxItem[]>('/approvals/inbox').catch(() => []),
      api.get<{ unread: number; items: Notification[] }>('/notifications?limit=5'),
      hasNews ? api.get<Announcement[]>('/announcements') : [],
      leave ? api.get<{ balances: Balance[] }>('/leave/balances').then((b) => b.balances.filter((x) => x.tracked)).catch(() => null) : null,
    ]);
    return { today, inbox, notes, news, balances };
  }, [api, attendance, hasNews, leave]);
  useReloadOnFocus(reload);

  const firstName = me?.user.fullName.split(' ')[0] ?? '';
  const role = me?.membership.roles[0]?.name;
  const toAck = data?.news.filter((a) => a.requiresAck && !a.acknowledgedAt).length ?? 0;
  const leaveDays = data?.balances?.reduce((sum, b) => sum + Number(b.available), 0);
  const day = data?.today?.day;
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      <Hero
        testID="home-hero"
        eyebrow={me?.tenant.name}
        title={`${partOfDay(me?.tenant.timezone)}${firstName ? `, ${firstName}` : ''}`}
        subtitle={data ? (data.inbox.length || toAck ? 'Here is what needs you today.' : 'You are all caught up.') : undefined}
        chip={role}
      />
      <DemoBanner show={!!me?.tenant.isDemo} />
      {error && <Notice tone={data ? 'warn' : 'danger'}>{data ? `Showing what was loaded earlier. ${error}` : error}</Notice>}
      {queue.pending.length > 0 && (
        <Notice tone="warn" testID="home-queue">{`${queue.pending.length} punch${queue.pending.length === 1 ? '' : 'es'} waiting to be sent. They are saved on this phone.`}</Notice>
      )}

      {data && (
        <TileGrid>
          {data.today && (
            <Tile
              testID="tile-today"
              tone="violet"
              icon="◷"
              value={day ? (dayStatus[day.status] ?? day.status) : data.today.nextDirection === 'in' ? 'Not in' : 'In'}
              label="Today"
              hint={data.today.shift ? `${data.today.shift.start} to ${data.today.shift.end}` : 'No shift planned'}
              onPress={() => router.push('/attendance')}
            />
          )}
          <Tile testID="tile-approvals" tone="teal" icon="✓" value={String(data.inbox.length)} label="Approvals" hint="Waiting for you" onPress={() => router.push('/approvals')} />
          {data.balances && (
            <Tile testID="tile-leave" tone="orange" icon="☼" value={fmtDays(leaveDays ?? 0)} label="Leave available" hint={`${data.balances.length} leave type${data.balances.length === 1 ? '' : 's'}`} onPress={() => router.push('/leave')} />
          )}
          <Tile testID="tile-notifications" tone="blue" icon="♪" value={String(data.notes.unread)} label="Unread" hint="Notifications" onPress={() => router.push('/notifications')} />
        </TileGrid>
      )}

      <QuickActions
        actions={[
          ...(attendance ? [{ label: data?.today?.nextDirection === 'out' ? 'Punch out' : 'Punch in', icon: '◷', tone: 'violet' as const, onPress: () => router.push('/attendance'), testID: 'qa-punch' }] : []),
          ...(leave ? [{ label: 'Apply for leave', icon: '☼', tone: 'orange' as const, onPress: () => router.push('/leave/new'), testID: 'qa-leave' }] : []),
          ...(helpdesk ? [{ label: 'Ask HR', icon: '?', tone: 'pink' as const, onPress: () => router.push('/helpdesk/new'), testID: 'qa-askhr' }] : []),
          { label: 'Approvals', icon: '✓', tone: 'teal' as const, onPress: () => router.push('/approvals') },
        ]}
      />

      {data?.today && (
        <Card testID="home-today">
          <CardTitle right={data.today.day && <Badge>{dayStatus[data.today.day.status] ?? data.today.day.status}</Badge>}>Today</CardTitle>
          <Text muted size={14}>
            {data.today.shift ? `${data.today.shift.name}, ${data.today.shift.start} to ${data.today.shift.end}` : 'No shift planned'}
            {data.today.holidayName ? ` · ${data.today.holidayName}` : ''}
          </Text>
          <Button title={data.today.nextDirection === 'in' ? 'Punch in' : 'Punch out'} onPress={() => router.push('/attendance')} />
        </Card>
      )}

      {data && data.inbox.length > 0 && (
        <Card>
          <CardTitle>Waiting for your approval</CardTitle>
          <Text muted size={14}>{`${data.inbox.length} request${data.inbox.length === 1 ? '' : 's'}`}</Text>
          <Button title="Review requests" kind="secondary" onPress={() => router.push('/approvals')} testID="home-approvals" />
        </Card>
      )}

      {hasNews && (
        <Card testID="home-announcements">
          <CardTitle right={toAck > 0 ? <Badge tone="warn">{`${toAck} to acknowledge`}</Badge> : undefined}>Announcements</CardTitle>
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
        <CardTitle right={data && data.notes.unread > 0 ? <Badge tone="info">{`${data.notes.unread} unread`}</Badge> : undefined}>Notifications</CardTitle>
        {data?.notes.items.length === 0 && <Empty>Nothing new.</Empty>}
        {data?.notes.items.map((n) => (
          <ListItem key={n.id} title={n.title} subtitle={fmt.dateTime(n.createdAt)} right={!n.readAt ? <Badge tone="info">New</Badge> : undefined} />
        ))}
        <Button title="All notifications" kind="secondary" onPress={() => router.push('/notifications')} />
      </Card>
    </Screen>
  );
}

/** "12.5 days", "1 day": half days kept, trailing zeros dropped. */
function fmtDays(n: number) {
  const v = Number(n.toFixed(1));
  return `${v} day${v === 1 ? '' : 's'}`;
}

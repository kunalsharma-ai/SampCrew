import { workspaceLevelLabel } from '@crew/contracts';
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { useBadges } from '../../src/lib/badges';
import { dayStatus, leaveStatus } from '../../src/lib/labels';
import { useMobileApp } from '../../src/lib/mobile-app';
import { useSession } from '../../src/lib/session';
import type { Announcement, AppraisalBrief, AttendanceRange, Balance, Conversation, EmployeeDocument, InboxItem, LearningAssignment, LeaveRequest, MyRewards, Notification, TaskCounts, TeamAttendance, Today } from '../../src/lib/types';
import { Badge, Button, Card, CardTitle, DemoBanner, Empty, fmt, Hero, ListItem, Meter, Notice, QuickActions, Screen, Text, Tile, TileGrid, useLoad, useReloadOnFocus, useTheme } from '../../src/ui';
import { CountBadge, Icon, IconRow, MODULE_TONE, Section, SkeletonCard } from '../../src/ui/kit';

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

/** Test ids the quick actions had before they came from the configuration (kept so older flows still find them). */
const ACTION_ID: Record<string, string> = { 'attendance.punch': 'qa-punch', 'leave.apply': 'qa-leave', 'tasks.open': 'qa-tasks', 'help.ask': 'qa-askhr' };
const hours = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
const ymd = (tz?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

/**
 * Home for each level: the greeting with the person's level, the quick actions and widgets the Super Workspace chose
 * for that level (in its order), and only the data those widgets need. A widget whose module is off, or that the
 * person may not use, is not drawn and its data is never asked for.
 */
export default function Home() {
  const { api, me, queue } = useSession();
  const { app, has } = useMobileApp();
  const badges = useBadges();
  const router = useRouter();
  const t = useTheme();
  const widgets = app?.widgets.map((w) => w.key) ?? [];
  const on = (k: string) => widgets.includes(k);
  const isEmployee = !!me?.employee;
  const tz = me?.tenant.timezone;
  const month = ymd(tz).slice(0, 7);

  const { data, error, loading, reload } = useLoad(async () => {
    const safe = <T,>(p: Promise<T>) => p.catch(() => null);
    // One request per source, all at once; identical requests from other screens share the same answer.
    const [today, inbox, notes, news, balances, requests, taskCounts, appraisals, rewards, chats, learning, team, monthDays, docs] = await Promise.all([
      on('attendance.today') ? safe(api.get<Today>('/attendance/today')) : null,
      on('approvals.pending') ? safe(api.get<InboxItem[]>('/approvals/inbox')) : null,
      on('notifications.unread') ? safe(api.get<{ unread: number; items: Notification[] }>('/notifications?limit=5')) : null,
      on('announcements.latest') ? safe(api.get<Announcement[]>('/announcements')) : null,
      on('leave.balance') ? safe(api.get<{ balances: Balance[] }>('/leave/balances').then((b) => b.balances.filter((x) => x.tracked))) : null,
      on('leave.pending') ? safe(api.get<LeaveRequest[]>('/leave/requests')) : null,
      on('tasks.pending') && isEmployee ? safe(api.get<TaskCounts>('/tasks/counts')) : null,
      on('tasks.pending') && isEmployee && has('appraisal') ? safe(api.get<AppraisalBrief[]>('/appraisals/mine')) : null,
      on('tasks.pending') && isEmployee && has('attendance') ? safe(api.get<MyRewards>('/workspace/rewards?history=0')) : null,
      on('chat.recent') ? safe(api.get<{ items: Conversation[] }>('/communication/conversations')) : null,
      on('learning.assigned') ? safe(api.get<LearningAssignment[]>('/learning/assignments?view=mine')) : null,
      on('attendance.team') ? safe(api.get<TeamAttendance>(`/attendance/team?date=${ymd(tz)}`)) : null,
      on('attendance.summary') && isEmployee ? safe(api.get<AttendanceRange>(`/attendance/days?from=${month}-01&to=${ymd(tz)}`)) : null,
      on('documents.recent') && me?.employee ? safe(api.get<EmployeeDocument[]>(`/employees/${me.employee.id}/documents`)) : null,
    ]);
    return { today, inbox, notes, news, balances, requests, taskCounts, appraisals, rewards, chats, learning, team, monthDays, docs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, widgets.join(','), isEmployee, has, tz, month]);
  useReloadOnFocus(() => {
    badges.refresh();
    return reload();
  });

  const firstName = me?.user.fullName.split(' ')[0] ?? '';
  const level = app?.levelLabel ?? (me ? workspaceLevelLabel(me.levels, { withName: true }) : undefined);
  const toAck = data?.news?.filter((a) => a.requiresAck && !a.acknowledgedAt).length ?? 0;
  const leaveDays = data?.balances?.reduce((sum, b) => sum + Number(b.available ?? 0), 0);
  const pendingLeave = data?.requests?.filter((r) => r.status === 'pending') ?? [];
  const openLearning = data?.learning?.filter((a) => a.status === 'assigned' || a.status === 'in_progress') ?? [];
  const day = data?.today?.day;
  const go = (route: string) => router.push(route as never);

  const tile = (k: string) => {
    if (!data) return null;
    switch (k) {
      case 'attendance.today':
        return data.today && (
          <Tile key={k} testID="tile-today" tone="violet" icon="time" value={day ? (dayStatus[day.status] ?? day.status) : data.today.nextDirection === 'in' ? 'Not in' : 'In'} label="Today" hint={data.today.shift ? `${data.today.shift.start} to ${data.today.shift.end}` : 'No shift planned'} onPress={() => go('/attendance')} />
        );
      case 'approvals.pending':
        return data.inbox && <Tile key={k} testID="tile-approvals" tone="teal" icon="checkmark-done" value={String(data.inbox.length)} label="Approvals" hint="Waiting for you" onPress={() => go('/approvals')} />;
      case 'leave.balance':
        return data.balances && <Tile key={k} testID="tile-leave" tone="orange" icon="sunny" value={String(Number((leaveDays ?? 0).toFixed(1)))} label="Leave days left" hint={`${data.balances.length} leave type${data.balances.length === 1 ? '' : 's'}`} onPress={() => go('/leave')} />;
      case 'notifications.unread':
        return data.notes && <Tile key={k} testID="tile-notifications" tone="blue" icon="notifications" value={String(data.notes.unread)} label="Unread" hint="Notifications" onPress={() => go('/notifications')} />;
      case 'learning.assigned':
        return data.learning && <Tile key={k} testID="tile-learning" tone="green" icon="school" value={String(openLearning.length)} label="Courses to do" hint={openLearning.some((a) => a.overdue) ? 'Some are overdue' : 'Assigned to you'} onPress={() => go('/learning')} />;
      case 'attendance.team':
        return data.team && <Tile key={k} testID="tile-team" tone="pink" icon="people" value={`${(data.team.summary.present ?? 0) + (data.team.summary.in_progress ?? 0)}/${data.team.summary.total ?? 0}`} label="In today" hint={`${data.team.summary.late ?? 0} late · ${data.team.summary.on_leave ?? 0} on leave`} onPress={() => go('/attendance/team')} />;
      default:
        return null;
    }
  };

  const card = (k: string) => {
    if (!data) return null;
    switch (k) {
      case 'attendance.today':
        return data.today && (
          <Card key={k} testID="home-today">
            <CardTitle right={data.today.day && <Badge>{dayStatus[data.today.day.status] ?? data.today.day.status}</Badge>} help="home.today">Today</CardTitle>
            <Text muted size={14}>
              {data.today.shift ? `${data.today.shift.name}, ${data.today.shift.start} to ${data.today.shift.end}` : 'No shift planned'}
              {data.today.holidayName ? ` · ${data.today.holidayName}` : ''}
              {data.today.state === 'on_break' ? ' · on a break' : ''}
            </Text>
            <Button title={data.today.state === 'on_break' ? 'End break' : data.today.nextDirection === 'in' ? 'Punch in' : 'Punch out'} onPress={() => go('/attendance')} />
          </Card>
        );
      case 'attendance.summary':
        return data.monthDays && (
          <Card key={k} testID="home-month">
            <CardTitle>{fmt.month(month)}</CardTitle>
            <Meter label="Days present" value={data.monthDays.summary.present} max={Math.max(1, data.monthDays.days.filter((d) => !['weekly_off', 'holiday'].includes(d.status)).length)} caption={`${data.monthDays.summary.present} present · ${data.monthDays.summary.late} late`} />
            <Text muted size={13}>{`${hours(data.monthDays.summary.workedMinutes)} worked · ${data.monthDays.summary.absent} absent · ${data.monthDays.summary.onLeave} on leave`}</Text>
            <Button title="My attendance" kind="secondary" onPress={() => go('/attendance/history')} />
          </Card>
        );
      case 'approvals.pending':
        return data.inbox && data.inbox.length > 0 && (
          <Card key={k}>
            <CardTitle help="home.approvals">Waiting for your approval</CardTitle>
            <Text muted size={14}>{`${data.inbox.length} request${data.inbox.length === 1 ? '' : 's'}`}</Text>
            <Button title="Review requests" kind="secondary" onPress={() => go('/approvals')} testID="home-approvals" />
          </Card>
        );
      case 'leave.pending':
        return data.requests && pendingLeave.length > 0 && (
          <Card key={k} testID="home-leave-pending">
            <CardTitle>Leave waiting for approval</CardTitle>
            {pendingLeave.slice(0, 3).map((r) => (
              <ListItem key={r.id} title={r.leaveTypeName} subtitle={`${fmt.date(r.startDate)}${r.endDate !== r.startDate ? ` to ${fmt.date(r.endDate)}` : ''} · ${r.days} day${r.days === '1' ? '' : 's'}`} right={<Badge tone={leaveStatus[r.status]?.tone}>{leaveStatus[r.status]?.label ?? r.status}</Badge>} onPress={() => go('/leave')} />
            ))}
          </Card>
        );
      case 'tasks.pending':
        return (data.taskCounts || data.appraisals?.some((a) => a.stage === 'self') || data.rewards?.rewards.length) ? (
          <Card key={k} testID="home-workspace">
            <CardTitle help="home.workspace">My workspace</CardTitle>
            {data.taskCounts && (
              <ListItem
                testID="home-tasks"
                title={`${data.taskCounts.hr.open + data.taskCounts.manager.open} open task${data.taskCounts.hr.open + data.taskCounts.manager.open === 1 ? '' : 's'}`}
                subtitle={`${data.taskCounts.hr.open} from HR · ${data.taskCounts.manager.open} from your manager`}
                right={data.taskCounts.hr.overdue + data.taskCounts.manager.overdue > 0 ? <Badge tone="danger">{`${data.taskCounts.hr.overdue + data.taskCounts.manager.overdue} overdue`}</Badge> : undefined}
                onPress={() => go('/tasks')}
              />
            )}
            {data.appraisals?.filter((a) => a.stage === 'self').map((a) => (
              <ListItem key={a.id} testID="home-appraisal" title="Self-appraisal waiting" subtitle={`${a.cycleName}${a.selfDue ? ` · due ${fmt.date(a.selfDue)}` : ''}`} right={<Badge tone={a.overdue ? 'danger' : 'warn'}>{`${a.selfCompletion}% done`}</Badge>} onPress={() => go(`/appraisal/${a.id}`)} />
            ))}
            {data.rewards?.rewards.map((r) => (
              <ListItem
                key={r.id}
                testID={`home-reward-${r.kind}`}
                title={r.name}
                subtitle={r.reason ?? (r.description ?? undefined)}
                right={<Badge tone={r.status === 'earned' ? 'ok' : r.status === 'on_track' ? 'info' : r.status === 'missed' ? 'danger' : 'neutral'}>{r.status === 'earned' ? 'Earned' : r.status === 'on_track' ? 'On track' : r.status === 'missed' ? 'Missed this month' : 'Not eligible'}</Badge>}
              />
            ))}
          </Card>
        ) : null;
      case 'chat.recent':
        return data.chats && (
          <Card key={k} testID="home-chats">
            <CardTitle right={badges.chat ? <CountBadge n={badges.chat} /> : undefined}>Recent messages</CardTitle>
            {data.chats.items.length === 0 && <Empty>No conversations yet.</Empty>}
            {data.chats.items.slice(0, 3).map((c) => (
              <IconRow key={c.id} icon={c.kind === 'direct' ? 'person' : 'people'} tone="blue" title={c.title} subtitle={c.lastMessage ? `${c.lastMessage.body || 'Attachment'} · ${fmt.dateTime(c.lastMessage.at)}` : undefined} badge={c.muted ? 0 : c.unread} onPress={() => go(`/chat/${c.id}`)} />
            ))}
          </Card>
        );
      case 'learning.assigned':
        return data.learning && openLearning.length > 0 && (
          <Card key={k} testID="home-learning">
            <CardTitle>Learning to do</CardTitle>
            {openLearning.slice(0, 3).map((a) => (
              <IconRow key={a.id} icon="school" tone="green" title={a.courseTitle} subtitle={a.dueOn ? `Due ${fmt.date(a.dueOn)}` : 'No due date'} right={a.overdue ? <Badge tone="danger">Overdue</Badge> : undefined} onPress={() => go('/learning')} />
            ))}
          </Card>
        );
      case 'announcements.latest':
        return data.news && (
          <Card key={k} testID="home-announcements">
            <CardTitle right={toAck > 0 ? <Badge tone="warn">{`${toAck} to acknowledge`}</Badge> : undefined} help="home.announcements">Announcements</CardTitle>
            {data.news.length === 0 && <Empty>No announcements.</Empty>}
            {data.news.slice(0, 5).map((a) => (
              <ListItem
                key={a.id}
                title={a.title}
                subtitle={`${fmt.date(a.publishedAt)}${a.publishedByName ? ` · ${a.publishedByName}` : ''}`}
                right={a.requiresAck && !a.acknowledgedAt ? <Badge tone="warn">Please acknowledge</Badge> : !a.readAt ? <Badge tone="info">New</Badge> : a.pinned ? <Badge>Pinned</Badge> : undefined}
                onPress={() => go(`/announcements/${a.id}`)}
              />
            ))}
          </Card>
        );
      case 'documents.recent':
        return data.docs && data.docs.length > 0 && (
          <Card key={k} testID="home-documents">
            <CardTitle>Recent documents</CardTitle>
            {data.docs.slice(0, 3).map((d) => <IconRow key={d.id} icon="document-text" tone="pink" title={d.title} subtitle={fmt.date(d.createdAt)} onPress={() => go('/documents')} />)}
          </Card>
        );
      case 'notifications.unread':
        return data.notes && (
          <Card key={k}>
            <CardTitle right={data.notes.unread > 0 ? <Badge tone="info">{`${data.notes.unread} unread`}</Badge> : undefined} help="home.notifications">Notifications</CardTitle>
            {data.notes.items.length === 0 && <Empty>Nothing new.</Empty>}
            {data.notes.items.map((n) => (
              <ListItem key={n.id} title={n.title} subtitle={fmt.dateTime(n.createdAt)} right={!n.readAt ? <Badge tone="info">New</Badge> : undefined} />
            ))}
            <Button title="All notifications" kind="secondary" onPress={() => go('/notifications')} />
          </Card>
        );
      default:
        return null;
    }
  };

  const tiles = widgets.map(tile).filter(Boolean);
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Hero
            testID="home-hero"
            eyebrow={me?.tenant.name}
            title={`${partOfDay(tz)}${firstName ? `, ${firstName}` : ''}`}
            subtitle={app?.welcome || (data ? ((data.inbox?.length ?? 0) || toAck ? 'Here is what needs you today.' : 'You are all caught up.') : undefined)}
            chip={level}
          />
        </View>
        {has('home.search') && (
          <Pressable testID="home-search" accessibilityRole="button" accessibilityLabel="Search" onPress={() => go('/search')} hitSlop={8} style={{ padding: 8, marginTop: 4 }}>
            <Icon name="search" size={24} color={t.fg} />
          </Pressable>
        )}
        {has('notifications') && (
          <Pressable testID="home-bell" accessibilityRole="button" accessibilityLabel={`Notifications${badges.notifications ? `, ${badges.notifications} unread` : ''}`} onPress={() => go('/notifications')} hitSlop={8} style={{ padding: 8, marginTop: 4 }}>
            <Icon name="notifications-outline" size={24} color={t.fg} />
            {badges.notifications > 0 && <View style={{ position: 'absolute', top: 0, right: -2 }}><CountBadge n={badges.notifications} /></View>}
          </Pressable>
        )}
      </View>
      <DemoBanner show={!!me?.tenant.isDemo} />
      {error && <Notice tone={data ? 'warn' : 'danger'}>{data ? `Showing what was loaded earlier. ${error}` : error}</Notice>}
      {queue.pending.length > 0 && (
        <Notice tone="warn" testID="home-queue">{`${queue.pending.length} punch${queue.pending.length === 1 ? '' : 'es'} waiting to be sent. They are saved on this phone.`}</Notice>
      )}

      {!app || (!data && loading) ? <SkeletonCard lines={3} /> : null}
      {tiles.length > 0 && <TileGrid>{tiles}</TileGrid>}

      {app && app.quickActions.length > 0 && (
        <>
          <Section title="Quick actions" />
          <QuickActions
            actions={app.quickActions.map((a) => ({
              label: a.key === 'attendance.punch' && data?.today ? (data.today.nextDirection === 'out' ? 'Punch out' : 'Punch in') : a.name,
              icon: a.icon,
              tone: MODULE_TONE[a.module] ?? 'violet',
              onPress: () => go(a.route),
              testID: ACTION_ID[a.key] ?? `qa-${a.key.replace('.', '-')}`,
            }))}
          />
        </>
      )}

      {widgets.map(card)}
      {app && app.widgets.length === 0 && app.quickActions.length === 0 && (
        <Card>
          <Text muted>Your company has not chosen anything for the Home screen yet. Use the bottom bar or More to open a module.</Text>
        </Card>
      )}
    </Screen>
  );
}

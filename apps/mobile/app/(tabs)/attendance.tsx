import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useMobileApp } from '../../src/lib/mobile-app';
import { useSession } from '../../src/lib/session';
import { dayStatus, riskFlag, syncReason } from '../../src/lib/labels';
import type { Today } from '../../src/lib/types';
import { Badge, Button, Card, CardTitle, Empty, fmt, ListItem, Notice, Screen, Text, Tile, TileGrid, Title, useLoad, useReloadOnFocus } from '../../src/ui';
import { IconRow, ModuleGate } from '../../src/ui/kit';
import { ModuleNotices } from '../../src/ui/module-notices';

type Fix = { latitude: number; longitude: number; accuracyM?: number; mockLocation: boolean } | null;

/** Asks for the location once per punch; a punch without it is still recorded (the server decides if that is allowed). */
type LocationStatus = 'ok' | 'denied' | 'unavailable' | 'timeout';
async function currentLocation(): Promise<{ fix: Fix; status: LocationStatus; note?: string }> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') return { fix: null, status: 'denied', note: 'Location is off for SampCrew, so this punch has no location and waits for HR to verify where you worked.' };
    const pos = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    if (!pos) return { fix: null, status: 'timeout', note: 'Could not get your location in time, so this punch waits for HR to verify where you worked.' };
    return { fix: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? undefined, mockLocation: pos.mocked === true }, status: 'ok' };
  } catch {
    return { fix: null, status: 'unavailable', note: 'Could not read your location, so this punch waits for HR to verify where you worked.' };
  }
}

const MODE_TONE = { office: 'violet', remote: 'teal', hybrid: 'amber', pending_verification: 'rose' } as const;
const hours = (m: number) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;

export default function AttendanceScreen() {
  return (
    <ModuleGate module="attendance">
      <Attendance />
    </ModuleGate>
  );
}

function Attendance() {
  const { api, queue, punch, sync, dismissRefused } = useSession();
  const { has } = useMobileApp();
  const router = useRouter();
  const punchOn = has('attendance.punch');
  const breaksOn = has('attendance.breaks');
  const historyOn = has('attendance.history') || has('attendance.calendar') || has('attendance.summary');
  const teamOn = has('attendance.team');
  const { data: today, error, loading, reload } = useLoad(() => api.get<Today>('/attendance/today'), [api], api.peek<Today>('/attendance/today'));
  useReloadOnFocus(reload);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);

  // While punches are queued, the next direction (and whether a break is running) follows the last queued punch.
  const lastQueued = queue.pending[queue.pending.length - 1];
  const next: 'in' | 'out' = lastQueued?.direction ? (lastQueued.direction === 'in' ? 'out' : 'in') : (today?.nextDirection ?? 'in');
  const onBreak = lastQueued?.direction ? lastQueued.direction === 'out' && lastQueued.purpose === 'break' : today?.state === 'on_break';

  const doPunch = async (kind: 'work' | 'break' = 'work') => {
    setBusy(true);
    setResult(null);
    const direction = kind === 'break' ? (onBreak ? 'in' : 'out') : next;
    try {
      const { fix, status, note } = await currentLocation();
      // Saying what the punch is for lets SampCrew refuse a wrong order (a second check-in, ending a break never started).
      const out = await punch({ direction, purpose: kind, locationStatus: status, ...(fix ?? {}) });
      const at = fmt.time(new Date().toISOString(), today?.timeZone);
      if (out.refused.length) {
        const r = out.refused[out.refused.length - 1];
        setResult({ tone: 'danger', text: `Not recorded: ${r.message}` });
      } else if (out.accepted || out.duplicates) {
        const what = kind === 'break' ? (direction === 'out' ? 'Break started' : 'Break ended') : `Punched ${direction}`;
        setResult({ tone: 'ok', text: `${what} at ${at}.${note ? ` ${note}` : ''}` });
      } else {
        setResult({ tone: 'warn', text: `Saved on this phone at ${at}. It will be sent when you are back online.` });
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const updateLocation = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { fix, status } = await currentLocation();
      const r = await api.post<{ zone: { zone: string; place: { name: string } | null } }>('/attendance/work-mode/checkpoint', { locationStatus: status, ...(fix ? { latitude: fix.latitude, longitude: fix.longitude, accuracyM: fix.accuracyM, mockLocation: fix.mockLocation } : {}) });
      const z = r.zone;
      setResult({ tone: z.zone === 'unverified' ? 'warn' : 'ok', text: z.zone === 'office' ? `Location updated: at ${z.place?.name ?? 'the office'}.` : z.zone === 'remote' ? 'Location updated: away from the office.' : 'Your location could not be verified this time.' });
      await reload();
    } catch (e) {
      setResult({ tone: 'danger', text: e instanceof Error ? e.message : 'Could not update your location.' });
    } finally {
      setBusy(false);
    }
  };
  const wm = today?.workMode?.enabled ? today.workMode : null;
  const wmHeadline = wm ? (wm.state === 'pending_verification' ? 'Waiting for location verification'
    : wm.state ? `${next === 'out' || wm.provisional ? "You're" : 'You were'} ${wm.labels[wm.state].replace(/^Work From/i, 'Working From')} today`
      : next === 'out' ? 'You are checked in' : 'Not checked in yet') : '';

  return (
    <Screen onRefresh={async () => { await sync(); await reload(); }} refreshing={loading && !!today}>
      <ModuleNotices category="attendance" label="Attendance" />
      <Title>Attendance</Title>
      {error && <Notice tone="warn">{today ? `Showing what was loaded earlier. ${error}` : error}</Notice>}
      {today && (
        <TileGrid>
          <Tile testID="tile-worked" tone="violet" icon="time" value={worked(today.day?.workedMinutes ?? 0)} label="Worked today" hint={today.shift ? `Shift ${today.shift.start} to ${today.shift.end}` : 'No shift planned'} />
          <Tile testID="tile-punches" tone="teal" icon="swap-horizontal" value={String(today.punches.length + queue.pending.length)} label="Punches" hint={queue.pending.length ? `${queue.pending.length} not sent yet` : `Next: punch ${next}`} />
        </TileGrid>
      )}
      {wm && (
        <Card testID="work-mode-card">
          <CardTitle right={wm.state ? <Badge tone={wm.state === 'pending_verification' ? 'warn' : undefined}>{wm.state === 'pending_verification' ? 'Pending verification' : wm.labels[wm.state]}</Badge> : undefined} help="attendance.work-mode">{wmHeadline}</CardTitle>
          <TileGrid>
            <Tile testID="tile-office" tone={MODE_TONE.office} icon="business" value={hours(wm.officeMinutes)} label="Office hours" hint={wm.places[0] ?? (wm.offices[0]?.name ? `Office: ${wm.offices[0].name}` : undefined)} />
            <Tile testID="tile-remote" tone={MODE_TONE.remote} icon="home" value={hours(wm.remoteMinutes)} label={`${wm.labels.remote} hours`} hint={wm.unverifiedMinutes ? `${hours(wm.unverifiedMinutes)} not verified` : undefined} />
          </TileGrid>
          {next === 'out' && <Button title="Update my location" kind="secondary" onPress={() => void updateLocation()} busy={busy} testID="update-location" />}
          <Text muted size={13}>Your location is read only when you punch or press Update my location, never in the background.</Text>
        </Card>
      )}
      {(historyOn || teamOn) && (
        <Card>
          {historyOn && <IconRow icon="calendar" tone="violet" title="My attendance" subtitle="Month calendar, history and summary" onPress={() => router.push('/attendance/history')} testID="attendance-history-link" />}
          {teamOn && <IconRow icon="people" tone="teal" title="Team attendance" subtitle="Who is in today" onPress={() => router.push('/attendance/team')} testID="attendance-team-link" />}
        </Card>
      )}
      <Card testID="today-card">
        <CardTitle right={today?.day && <Badge>{dayStatus[today.day.status] ?? today.day.status}</Badge>} help="attendance.today">{today ? fmt.date(today.date) : 'Today'}</CardTitle>
        {today && (
          <Text muted size={14}>
            {today.shift ? `${today.shift.name}, ${today.shift.start} to ${today.shift.end}` : 'No shift planned'}
            {today.holidayName ? ` · ${today.holidayName}` : ''}
          </Text>
        )}
        {punchOn && !onBreak && <Button title={next === 'in' ? 'Punch in' : 'Punch out'} onPress={() => void doPunch('work')} busy={busy} disabled={!today && !error} testID="punch-button" />}
        {punchOn && breaksOn && (onBreak || next === 'out') && (
          <Button title={onBreak ? 'End break' : 'Start break'} kind={onBreak ? 'primary' : 'secondary'} onPress={() => void doPunch('break')} busy={busy} disabled={!today && !error} testID="break-button" />
        )}
        {onBreak && <Badge tone="warn">On a break</Badge>}
        {result && <Notice tone={result.tone} testID="punch-result">{result.text}</Notice>}
        {today?.day?.explanation.map((line) => (
          <Text key={line} size={14} muted>{line}</Text>
        ))}
      </Card>

      {queue.pending.length > 0 && (
        <Card testID="queue-card">
          <CardTitle help="attendance.queue">{`Waiting to send (${queue.pending.length})`}</CardTitle>
          <Text muted size={14}>Saved on this phone with the time you punched. SampCrew sends them as soon as you are online.</Text>
          {queue.pending.map((p) => (
            <ListItem key={p.sequence} title={p.purpose === 'break' ? (p.direction === 'out' ? 'Start break' : 'End break') : `Punch ${p.direction ?? ''}`.trim()} subtitle={fmt.dateTime(p.capturedAt)} right={<Badge tone="warn">Not sent yet</Badge>} />
          ))}
          {queue.last?.error && <Text size={13} muted>{queue.last.error.message}</Text>}
          <Button title="Send now" kind="secondary" busy={queue.syncing} onPress={() => void sync().then(() => reload())} testID="sync-button" />
        </Card>
      )}

      {queue.refused.length > 0 && (
        <Card testID="refused-card">
          <CardTitle help="attendance.missing">Not recorded</CardTitle>
          <Text muted size={14}>SampCrew refused these punches. Ask for an attendance correction if you need them on your record.</Text>
          {queue.refused.map((r) => (
            <ListItem
              key={r.sequence}
              title={`${syncReason[r.reason] ?? 'Refused'}: punch ${r.direction ?? ''}`.trim()}
              subtitle={`${fmt.dateTime(r.capturedAt)} · ${r.message}`}
              right={<Button title="Dismiss" kind="secondary" onPress={() => dismissRefused(r.sequence)} />}
            />
          ))}
        </Card>
      )}

      <Card testID="punches-card">
        <CardTitle help="attendance.punches">Today&apos;s punches</CardTitle>
        {today && today.punches.length === 0 && <Empty>No punches yet today.</Empty>}
        {today?.punches.map((p) => (
          <ListItem
            key={p.id}
            title={`${p.purpose === 'break' ? (p.direction === 'out' ? 'Break started' : 'Break ended') : p.direction === 'in' ? 'In' : 'Out'} at ${fmt.time(p.at, today.timeZone)}`}
            subtitle={[p.source === 'mobile' ? 'Mobile app' : p.source === 'web' ? 'Web' : p.source, p.geofence === 'outside' ? 'outside workplace' : p.geofence === 'inside' ? 'at workplace' : null, ...(p.flags ?? []).map((f) => riskFlag[f] ?? f)]
              .filter(Boolean)
              .join(' · ')}
          />
        ))}
      </Card>
    </Screen>
  );
}

/** Worked minutes as "7h 05m" ("0m" before the first punch). */
function worked(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

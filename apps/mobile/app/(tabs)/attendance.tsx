import * as Location from 'expo-location';
import { useState } from 'react';
import { useSession } from '../../src/lib/session';
import { dayStatus, riskFlag, syncReason } from '../../src/lib/labels';
import type { Today } from '../../src/lib/types';
import { Badge, Button, Card, CardTitle, Empty, fmt, ListItem, Notice, Screen, Text, Tile, TileGrid, Title, useLoad, useReloadOnFocus } from '../../src/ui';

type Fix = { latitude: number; longitude: number; accuracyM?: number; mockLocation: boolean } | null;

/** Asks for the location once per punch; a punch without it is still recorded (the server decides if that is allowed). */
async function currentLocation(): Promise<{ fix: Fix; note?: string }> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') return { fix: null, note: 'Location is off for CREW, so this punch has no location.' };
    const pos = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
      new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
    ]);
    if (!pos) return { fix: null, note: 'Could not get your location in time, so this punch has no location.' };
    return { fix: { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? undefined, mockLocation: pos.mocked === true } };
  } catch {
    return { fix: null, note: 'Could not read your location, so this punch has no location.' };
  }
}

export default function Attendance() {
  const { api, queue, punch, sync, dismissRefused } = useSession();
  const { data: today, error, loading, reload } = useLoad(() => api.get<Today>('/attendance/today'), [api]);
  useReloadOnFocus(reload);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);

  // While punches are queued, the next direction follows the last queued punch, not the server's view.
  const lastQueued = queue.pending[queue.pending.length - 1]?.direction;
  const next: 'in' | 'out' = lastQueued ? (lastQueued === 'in' ? 'out' : 'in') : (today?.nextDirection ?? 'in');

  const doPunch = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { fix, note } = await currentLocation();
      const out = await punch({ direction: next, ...(fix ?? {}) });
      const at = fmt.time(new Date().toISOString(), today?.timeZone);
      if (out.refused.length) {
        const r = out.refused[out.refused.length - 1];
        setResult({ tone: 'danger', text: `Not recorded: ${r.message}` });
      } else if (out.accepted || out.duplicates) {
        setResult({ tone: 'ok', text: `Punched ${next} at ${at}.${note ? ` ${note}` : ''}` });
      } else {
        setResult({ tone: 'warn', text: `Saved on this phone at ${at}. It will be sent when you are back online.` });
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen onRefresh={async () => { await sync(); await reload(); }} refreshing={loading && !!today}>
      <Title>Attendance</Title>
      {error && <Notice tone="warn">{today ? `Showing what was loaded earlier. ${error}` : error}</Notice>}
      {today && (
        <TileGrid>
          <Tile testID="tile-worked" tone="violet" icon="◷" value={worked(today.day?.workedMinutes ?? 0)} label="Worked today" hint={today.shift ? `Shift ${today.shift.start} to ${today.shift.end}` : 'No shift planned'} />
          <Tile testID="tile-punches" tone="teal" icon="⇄" value={String(today.punches.length + queue.pending.length)} label="Punches" hint={queue.pending.length ? `${queue.pending.length} not sent yet` : `Next: punch ${next}`} />
        </TileGrid>
      )}
      <Card testID="today-card">
        <CardTitle right={today?.day && <Badge>{dayStatus[today.day.status] ?? today.day.status}</Badge>}>{today ? fmt.date(today.date) : 'Today'}</CardTitle>
        {today && (
          <Text muted size={14}>
            {today.shift ? `${today.shift.name}, ${today.shift.start} to ${today.shift.end}` : 'No shift planned'}
            {today.holidayName ? ` · ${today.holidayName}` : ''}
          </Text>
        )}
        <Button title={next === 'in' ? 'Punch in' : 'Punch out'} onPress={doPunch} busy={busy} disabled={!today && !error} testID="punch-button" />
        {result && <Notice tone={result.tone} testID="punch-result">{result.text}</Notice>}
        {today?.day?.explanation.map((line) => (
          <Text key={line} size={14} muted>{line}</Text>
        ))}
      </Card>

      {queue.pending.length > 0 && (
        <Card testID="queue-card">
          <CardTitle>{`Waiting to send (${queue.pending.length})`}</CardTitle>
          <Text muted size={14}>Saved on this phone with the time you punched. CREW sends them as soon as you are online.</Text>
          {queue.pending.map((p) => (
            <ListItem key={p.sequence} title={`Punch ${p.direction ?? ''}`.trim()} subtitle={fmt.dateTime(p.capturedAt)} right={<Badge tone="warn">Not sent yet</Badge>} />
          ))}
          {queue.last?.error && <Text size={13} muted>{queue.last.error.message}</Text>}
          <Button title="Send now" kind="secondary" busy={queue.syncing} onPress={() => void sync().then(() => reload())} testID="sync-button" />
        </Card>
      )}

      {queue.refused.length > 0 && (
        <Card testID="refused-card">
          <CardTitle>Not recorded</CardTitle>
          <Text muted size={14}>CREW refused these punches. Ask for an attendance correction if you need them on your record.</Text>
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
        <CardTitle>Today&apos;s punches</CardTitle>
        {today && today.punches.length === 0 && <Empty>No punches yet today.</Empty>}
        {today?.punches.map((p) => (
          <ListItem
            key={p.id}
            title={`${p.direction === 'in' ? 'In' : 'Out'} at ${fmt.time(p.at, today.timeZone)}`}
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

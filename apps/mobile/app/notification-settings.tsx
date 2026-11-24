import { NOTIFICATION_CATEGORIES, notificationLocks, type NotificationPreferences } from '@crew/contracts';
import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import { useSession } from '../src/lib/session';
import { Button, Card, CardTitle, Notice, Row, Screen, Text, useLoad, useTheme } from '../src/ui';

type Channel = 'inApp' | 'push' | 'sound';

/**
 * Notification settings on the phone: the same settings as the Web Portal (one record, so a change here shows there).
 * Per category: in the app, a push to this phone and its sound. A lock means the organisation decided it.
 */
export default function NotificationSettingsScreen() {
  const { api } = useSession();
  const t = useTheme();
  const { data, error } = useLoad(() => api.get<NotificationPreferences>('/notifications/preferences'), [api]);
  const [p, setP] = useState<NotificationPreferences | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(data), [data]);
  if (!p) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Text muted>Loading…</Text>}</Screen>;
  const locks = p.locks ?? notificationLocks();
  const set = (key: string, ch: Channel, v: boolean) => setP({ ...p, categories: { ...p.categories, [key]: { ...p.categories[key as keyof typeof p.categories], [ch]: v } } });
  const save = async () => {
    setBusy(true);
    try {
      const { locks: _l, customised: _c, ...input } = p;
      setP(await api.put<NotificationPreferences>('/notifications/preferences', input));
      setMsg({ tone: 'ok', text: 'Saved. It applies on the web too.' });
    } catch {
      setMsg({ tone: 'danger', text: 'Could not save. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  };
  const locked = (key: string, ch: Channel) => (ch === 'inApp' ? locks.inApp.includes(key as never) : ch === 'push' ? locks.push : locks.sound);
  return (
    <Screen>
      {locks.push && <Notice tone="info">Your organisation does not send notifications to phones. You still see them when you open SampCrew.</Notice>}
      {locks.sound && <Notice tone="info">Your organisation keeps notifications silent.</Notice>}
      <Card>
        <CardTitle>What reaches this phone</CardTitle>
        <Row style={{ justifyContent: 'flex-end', gap: 18, paddingRight: 4 }}>
          {['In app', 'Push', 'Sound'].map((h) => <Text key={h} size={11} muted weight="600">{h}</Text>)}
        </Row>
        {NOTIFICATION_CATEGORIES.map((c) => (
          <View key={c.key} testID={`pref-${c.key}`} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: t.border }}>
            <Text style={{ flex: 1 }} size={14}>{c.label}</Text>
            {(['inApp', 'push', 'sound'] as const).map((ch) => (
              <Switch key={ch} accessibilityLabel={`${c.label} ${ch === 'inApp' ? 'in the app' : ch}`} value={p.categories[c.key][ch] !== false} disabled={locked(c.key, ch)} onValueChange={(v) => set(c.key, ch, v)} style={{ transform: [{ scale: 0.8 }] }} />
            ))}
          </View>
        ))}
      </Card>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Button title="Save" onPress={() => void save()} busy={busy} testID="notification-settings-save" />
    </Screen>
  );
}

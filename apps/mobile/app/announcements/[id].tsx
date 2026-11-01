import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ApiError } from '../../src/lib/api';
import { useSession } from '../../src/lib/session';
import type { Announcement } from '../../src/lib/types';
import { Badge, Button, Card, fmt, Loading, Notice, Screen, Text, useLoad } from '../../src/ui';

export default function AnnouncementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  // Opening it records that I have read it.
  const { data: a, error, setData } = useLoad(() => api.get<Announcement>(`/announcements/${id}`), [api, id]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!a) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Loading />}</Screen>;
  const acknowledge = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ acknowledgedAt: string }>(`/announcements/${a.id}/acknowledge`);
      setData({ ...a, acknowledgedAt: r.acknowledgedAt });
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Could not record it.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Announcement' }} />
      <Card testID="announcement">
        {a.pinned && <Badge>Pinned</Badge>}
        <Text size={18} weight="700">{a.title}</Text>
        <Text muted size={13}>{`${fmt.date(a.publishedAt)}${a.publishedByName ? ` · ${a.publishedByName}` : ''}`}</Text>
        <Text>{a.body}</Text>
      </Card>
      {msg && <Notice tone="danger">{msg}</Notice>}
      {a.requiresAck &&
        (a.acknowledgedAt ? (
          <Notice tone="ok" testID="acknowledged">{`You acknowledged this on ${fmt.dateTime(a.acknowledgedAt)}.`}</Notice>
        ) : (
          <Card>
            <Text>HR has asked everyone to confirm they have read this.</Text>
            <Button title="I have read this" onPress={acknowledge} busy={busy} testID="acknowledge" />
          </Card>
        ))}
    </Screen>
  );
}

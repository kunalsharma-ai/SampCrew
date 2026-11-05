import { useState } from 'react';
import { useSession } from '../src/lib/session';
import { Badge, Button, Card, Empty, errorText, fmt, ListItem, Notice, Row, Screen, Text, useLoad } from '../src/ui';

interface DeviceRow {
  id: string;
  platform: string;
  model: string;
  appVersion: string;
  pushEnabled: boolean;
  lastSeenAt: string;
  lastSyncAt: string | null;
  revokedAt: string | null;
}

/** Phones signed in to my account in this workspace. Signing one out ends its sign-in and stops its push. */
export default function Devices() {
  const { api, device, signOut } = useSession();
  const { data, error, reload } = useLoad(() => api.get<DeviceRow[]>('/mobile/devices'), [api]);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const out = async (d: DeviceRow) => {
    if (d.id === device?.id) return signOut();
    try {
      await api.post(`/mobile/devices/${d.id}/sign-out`);
      setMsg({ tone: 'ok', text: 'That device is signed out.' });
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    }
  };
  return (
    <Screen onRefresh={reload}>
      {error && <Notice tone="danger">{error}</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <Card>
        {data?.length === 0 && <Empty>No devices.</Empty>}
        {data?.map((d) => (
          <ListItem
            key={d.id}
            title={`${d.model || d.platform}${d.id === device?.id ? ' (this device)' : ''}`}
            subtitle={`${d.platform} · app ${d.appVersion || '?'} · last seen ${fmt.dateTime(d.lastSeenAt)}${d.lastSyncAt ? ` · last punch sync ${fmt.dateTime(d.lastSyncAt)}` : ''}`}
            right={
              d.revokedAt ? <Badge>Signed out</Badge> : (
                <Row>
                  {d.pushEnabled && <Badge tone="ok">Push</Badge>}
                  <Button title="Sign out" kind="secondary" onPress={() => out(d)} testID={d.id === device?.id ? "sign-out-this-device" : "sign-out-device"} />
                </Row>
              )
            }
          />
        ))}
      </Card>
      <Text muted size={13}>You can also sign devices out from the Web Portal under Settings, Security.</Text>
    </Screen>
  );
}

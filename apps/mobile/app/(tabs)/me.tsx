import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { biometricEnabled, biometricSupport, type BiometricSupport, setBiometric } from '../../src/lib/biometric';
import { getPushToken } from '../../src/lib/push';
import { useSession } from '../../src/lib/session';
import type { PayslipRow } from '../../src/lib/types';
import { Badge, Button, Card, DemoBanner, Empty, errorText, fmt, ListItem, Notice, Row, Screen, Text, Title, useLoad, useReloadOnFocus } from '../../src/ui';

export default function Me() {
  const { api, me, device, setDevice, signOut, can, hasFeature } = useSession();
  const router = useRouter();
  const payslips = hasFeature('payroll') && can('payslips:read');
  const { data, error, reload, loading } = useLoad(() => (payslips ? api.get<PayslipRow[]>('/payslips?mine=true') : Promise.resolve([])), [api, payslips]);
  useReloadOnFocus(reload);
  const [bio, setBio] = useState<{ support: BiometricSupport; on: boolean } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([biometricSupport(), biometricEnabled()]).then(([support, on]) => setBio({ support, on }));
  }, []);

  const toggleBio = async () => {
    if (!bio) return;
    const r = await setBiometric(!bio.on);
    if (!r.ok) return setMsg({ tone: 'danger', text: r.message ?? 'Could not change it.' });
    setBio({ ...bio, on: !bio.on });
    setMsg({ tone: 'ok', text: !bio.on ? `CREW now asks for your ${bio.support.label} when it opens.` : 'Biometric unlock is off.' });
  };

  const togglePush = async () => {
    if (!device) return;
    setBusy('push');
    try {
      if (device.pushEnabled) {
        await api.put(`/mobile/devices/${device.id}/push-token`, { token: null });
        setDevice({ ...device, pushEnabled: false });
        setMsg({ tone: 'ok', text: 'Push notifications are off for this phone.' });
      } else {
        const t = await getPushToken();
        if (!t.ok) return setMsg({ tone: 'warn', text: t.message });
        await api.put(`/mobile/devices/${device.id}/push-token`, { token: t.token });
        setDevice({ ...device, pushEnabled: true });
        setMsg({ tone: 'ok', text: 'Push notifications are on. They say only that something is new; details open in the app.' });
      }
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      <Title>{me?.user.fullName ?? 'Me'}</Title>
      <Text muted>{`${me?.user.email ?? ''} · ${me?.tenant.name ?? ''}`}</Text>
      <DemoBanner show={!!me?.tenant.isDemo} />
      {msg && <Notice tone={msg.tone} testID="me-message">{msg.text}</Notice>}

      {payslips && (
        <Card testID="payslips">
          <Text weight="700">Payslips</Text>
          {error && <Notice tone="danger">{error}</Notice>}
          {data?.length === 0 && <Empty>No payslips yet.</Empty>}
          {data?.map((p) => (
            <ListItem key={p.id} title={fmt.month(p.month)} subtitle={`Paid ${fmt.date(p.payDate)}`} right={<Text weight="600">{fmt.money(p.net, p.currency)}</Text>} onPress={() => router.push(`/payslips/${p.id}`)} />
          ))}
        </Card>
      )}

      <Card>
        <Text weight="700">Security</Text>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text>Two-step sign-in</Text>
          <Badge tone={me?.user.mfaEnabled ? 'ok' : 'neutral'}>{me?.user.mfaEnabled ? 'On' : 'Off'}</Badge>
        </Row>
        {!me?.user.mfaEnabled && <Text muted size={13}>Turn it on in the Web Portal under Settings, Security.</Text>}
        {bio && (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text>{`Unlock with ${bio.support.label}`}</Text>
              <Badge tone={bio.on ? 'ok' : 'neutral'}>{bio.on ? 'On' : 'Off'}</Badge>
            </Row>
            {bio.support.available ? <Button title={bio.on ? 'Turn off' : 'Turn on'} kind="secondary" onPress={toggleBio} /> : <Text muted size={13}>{bio.support.reason}</Text>}
          </>
        )}
        {device && (
          <>
            <Row style={{ justifyContent: 'space-between' }}>
              <Text>Push notifications</Text>
              <Badge tone={device.pushEnabled ? 'ok' : 'neutral'}>{device.pushEnabled ? 'On' : 'Off'}</Badge>
            </Row>
            <Button title={device.pushEnabled ? 'Turn off' : 'Turn on'} kind="secondary" busy={busy === 'push'} onPress={togglePush} testID="push-toggle" />
          </>
        )}
        <Button title="Signed-in devices" kind="secondary" onPress={() => router.push('/devices')} />
      </Card>

      <Button title="Sign out" kind="danger" onPress={signOut} testID="sign-out" />
    </Screen>
  );
}

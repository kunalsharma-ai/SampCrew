import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useMobileApp } from '../src/lib/mobile-app';
import { useSession } from '../src/lib/session';
import type { SignIn, SignIns } from '../src/lib/types';
import { Badge, Button, Card, CardTitle, errorText, fmt, ListItem, Notice, Screen, Text, Tile, TileGrid, useLoad } from '../src/ui';
import { IconRow, ModuleGate, SkeletonCard } from '../src/ui/kit';

/** A readable device name from a browser or app user agent (no fingerprinting, just the obvious words). */
function deviceOf(s: SignIn) {
  const ua = s.userAgent ?? '';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iPhone or iPad' : /Windows/i.test(ua) ? 'Windows' : /Mac OS|Macintosh/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : null;
  const app = s.client === 'mobile' ? 'SampCrew app' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Web Portal';
  return [app, os].filter(Boolean).join(' on ');
}
const STATUS: Record<SignIn['status'], { label: string; tone: 'ok' | 'neutral' }> = { active: { label: 'Signed in', tone: 'ok' }, signed_out: { label: 'Signed out', tone: 'neutral' }, expired: { label: 'Ended', tone: 'neutral' } };

/** Last sign-in, recent sign-ins with time and device, and signing out every other device. Tokens are never shown. */
function Sessions() {
  const { api } = useSession();
  const { has } = useMobileApp();
  const router = useRouter();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api.get<SignIns>('/me/sign-ins'), [api]);
  const others = (data?.signIns ?? []).filter((s) => s.status === 'active' && !s.current).length;
  const signOutOthers = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ signedOut: number }>('/me/sessions/sign-out-others');
      setMsg({ tone: 'ok', text: r.signedOut ? `Signed out ${r.signedOut} other ${r.signedOut === 1 ? 'session' : 'sessions'}.` : 'No other device was signed in.' });
      await reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {msg && <Notice tone={msg.tone} testID="sessions-message">{msg.text}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && !error && <SkeletonCard lines={4} />}
      {data && (
        <TileGrid>
          <Tile testID="sessions-current" tone="teal" icon="shield-checkmark" value={data.current ? fmt.time(data.current.at) : 'Now'} label="This sign-in" hint={data.current ? `${fmt.date(data.current.at)} · ${deviceOf(data.current)}` : 'This device'} />
          <Tile testID="sessions-previous" tone="violet" icon="time" value={data.previous ? fmt.date(data.previous.at) : 'None'} label="Previous sign-in" hint={data.previous ? `${fmt.time(data.previous.at)} · ${deviceOf(data.previous)}` : 'This is your first'} />
        </TileGrid>
      )}
      {data && has('sessions.history') && (
        <Card testID="sign-in-history">
          <CardTitle>Recent sign-ins</CardTitle>
          {data.signIns.map((s) => (
            <ListItem
              key={s.id}
              title={`${deviceOf(s)}${s.current ? ' (this device)' : ''}`}
              subtitle={`${fmt.dateTime(s.at)}${s.ip ? ` · ${s.ip}` : ''}${s.endedAt ? ` · ended ${fmt.dateTime(s.endedAt)}` : ''}`}
              right={<Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>}
            />
          ))}
          <Text muted size={12}>If you see a sign-in you do not recognise, sign out other devices and change your password on the Web Portal.</Text>
        </Card>
      )}
      {data && has('sessions.manage') && (
        <Card>
          <CardTitle>Other devices</CardTitle>
          <Text muted size={14}>{others ? `${others} other ${others === 1 ? 'session is' : 'sessions are'} signed in.` : 'Only this device is signed in.'}</Text>
          <Button title="Sign out all other devices" kind="danger" onPress={signOutOthers} busy={busy} disabled={!others} testID="sign-out-others" />
          <IconRow icon="phone-portrait" tone="teal" title="Phones with the app" subtitle="Push notifications and punch sync per phone" onPress={() => router.push('/devices')} />
        </Card>
      )}
    </Screen>
  );
}

export default function SessionsScreen() {
  return (
    <ModuleGate module="sessions">
      <Sessions />
    </ModuleGate>
  );
}

import { buildTheme, DEFAULT_APPEARANCE, THEME_PRESETS, THEME_TEMPLATES } from '@crew/contracts';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useAppearance } from '../../src/lib/appearance';
import { biometricEnabled, biometricSupport, type BiometricSupport, setBiometric } from '../../src/lib/biometric';
import { pickPhoto, uploadPhoto } from '../../src/lib/photo';
import { getPushToken } from '../../src/lib/push';
import { useSession } from '../../src/lib/session';
import type { PayslipRow } from '../../src/lib/types';
import { Avatar, Badge, Button, Card, CardTitle, Choice, DemoBanner, Empty, errorText, fmt, gradient, ListItem, Notice, Row, Screen, Text, Title, useLoad, useReloadOnFocus } from '../../src/ui';

export default function Me() {
  const { api, me, device, setDevice, signOut, can, hasFeature, refreshMe } = useSession();
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

  // The photo is behind the session, so it is downloaded with it and shown from memory.
  const employee = me?.employee ?? null;
  const [photo, setPhoto] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (!employee?.photoUpdatedAt) { setPhoto(null); return; }
    void api.imageDataUrl(`/employees/${employee.id}/photo?v=${encodeURIComponent(employee.photoUpdatedAt)}`).then((u) => { if (live) setPhoto(u); });
    return () => { live = false; };
  }, [api, employee?.id, employee?.photoUpdatedAt]);

  const changePhoto = async (source: 'library' | 'camera') => {
    if (!employee) return;
    setMsg(null);
    const picked = await pickPhoto(source);
    if (!picked.ok) { if (picked.message) setMsg({ tone: 'warn', text: picked.message }); return; }
    setBusy('photo');
    try {
      await uploadPhoto(api, employee.id, picked.photo);
      await refreshMe();
      setMsg({ tone: 'ok', text: 'Your photo is saved. Your colleagues see it across SampCrew.' });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const removePhoto = async () => {
    if (!employee) return;
    setBusy('photo-remove');
    try {
      await api.delete(`/employees/${employee.id}/photo`);
      await refreshMe();
      setMsg({ tone: 'ok', text: 'Your photo is removed.' });
    } catch (e) {
      setMsg({ tone: 'danger', text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const toggleBio = async () => {
    if (!bio) return;
    const r = await setBiometric(!bio.on);
    if (!r.ok) return setMsg({ tone: 'danger', text: r.message ?? 'Could not change it.' });
    setBio({ ...bio, on: !bio.on });
    setMsg({ tone: 'ok', text: !bio.on ? `SampCrew now asks for your ${bio.support.label} when it opens.` : 'Biometric unlock is off.' });
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
      <Row style={{ gap: 14 }} testID="me-hero">
        <Avatar name={me?.user.fullName ?? ''} size={60} uri={photo} testID="me-photo" />
        <View style={{ flex: 1, gap: 2 }}>
          <Title>{me?.user.fullName ?? 'Me'}</Title>
          <Text muted size={14}>{me?.membership.roles.map((r) => r.name).join(', ') || me?.user.email || ''}</Text>
        </View>
      </Row>
      <Text muted size={14}>{`${me?.user.email ?? ''} · ${me?.tenant.name ?? ''}`}</Text>
      <DemoBanner show={!!me?.tenant.isDemo} />
      {msg && <Notice tone={msg.tone} testID="me-message">{msg.text}</Notice>}

      {employee && (
        <Card testID="photo-card">
          <CardTitle>Your photo</CardTitle>
          <Text muted size={13}>Shown on your profile and to your colleagues. PNG, JPEG or WebP, up to 5 MB.</Text>
          <Button title={photo ? 'Change photo' : 'Choose a photo'} kind="secondary" busy={busy === 'photo'} onPress={() => void changePhoto('library')} testID="photo-choose" />
          {Platform.OS !== 'web' && <Button title="Take a photo" kind="secondary" disabled={!!busy} onPress={() => void changePhoto('camera')} testID="photo-camera" />}
          {employee.photoUpdatedAt && <Button title="Remove photo" kind="danger" busy={busy === 'photo-remove'} onPress={() => void removePhoto()} testID="photo-remove" />}
        </Card>
      )}

      {payslips && (
        <Card testID="payslips">
          <CardTitle>Payslips</CardTitle>
          {error && <Notice tone="danger">{error}</Notice>}
          {data?.length === 0 && <Empty>No payslips yet.</Empty>}
          {data?.map((p) => (
            <ListItem key={p.id} title={fmt.month(p.month)} subtitle={`Paid ${fmt.date(p.payDate)}`} right={<Text weight="600">{fmt.money(p.net, p.currency)}</Text>} onPress={() => router.push(`/payslips/${p.id}`)} />
          ))}
        </Card>
      )}

      <Card>
        <CardTitle>Security</CardTitle>
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

      <AppearanceCard onMessage={setMsg} />

      <Button title="Sign out" kind="danger" onPress={signOut} testID="sign-out" />
    </Screen>
  );
}

/**
 * Theme and light or dark mode. These are the same saved settings as Appearance in the Web Portal, so a change on
 * the phone shows up there too, and the other way round.
 */
function AppearanceCard({ onMessage }: { onMessage: (m: { tone: 'ok' | 'warn' | 'danger'; text: string }) => void }) {
  const { appearance, theme, update } = useAppearance();
  const save = (patch: Parameters<typeof update>[0], done: string) =>
    update(patch).then(() => onMessage({ tone: 'ok', text: done }), (e) => onMessage({ tone: 'danger', text: errorText(e) }));
  return (
    <Card testID="appearance">
      <CardTitle>Appearance</CardTitle>
      <Text muted size={13}>Saved to your account, so the Web Portal uses the same theme.</Text>
      <Text size={13} weight="600">Templates</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Templates" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {THEME_TEMPLATES.map((tpl) => {
          const p = tpl.patch;
          const on = (Object.keys(p) as (keyof typeof p)[]).every((k) => appearance[k] === p[k]);
          const mode = p.mode === 'dark' ? 'dark' : 'light';
          const sw = buildTheme({ ...DEFAULT_APPEARANCE, ...p }, mode);
          return (
            <Pressable
              key={tpl.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              aria-checked={on}
              accessibilityLabel={`${tpl.name}: ${tpl.description}`}
              testID={`template-${tpl.key}`}
              onPress={() => !on && save(p, `${tpl.name} applied.`)}
              style={{ width: '47%', flexGrow: 1, borderWidth: on ? 2 : 1, borderColor: on ? theme.accent : theme.border, borderRadius: 12, overflow: 'hidden', backgroundColor: theme.card }}
            >
              <View style={[{ height: 44, padding: 8, justifyContent: 'flex-end' }, gradient(`linear-gradient(135deg, ${sw.bg}, ${sw.accent} 140%)`, sw.bg)]}>
                <View style={{ flexDirection: 'row', gap: 4 }}>
                  {[sw.accent, sw.ember, sw['glow-3']].map((c, i) => <View key={i} style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: c, borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' }} />)}
                </View>
              </View>
              <View style={{ padding: 8, gap: 2 }}>
                <Text size={13} weight={on ? '700' : '600'} numberOfLines={1}>{tpl.name}</Text>
                <Text size={12} muted numberOfLines={2}>{tpl.description}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      <Choice
        label="Visual style"
        value={appearance.style}
        options={[{ value: 'neon', label: 'Neon' }, { value: 'classic', label: 'Classic' }]}
        onChange={(style) => save({ style }, style === 'neon' ? 'The neon design is on.' : 'The classic design is on.')}
      />
      {appearance.style === 'neon' && (
        <Choice
          label="Background"
          value={appearance.backdrop}
          options={[{ value: 'aurora', label: 'Aurora' }, { value: 'cosmos', label: 'Cosmos' }, { value: 'gradient', label: 'Gradient' }, { value: 'plain', label: 'Plain' }]}
          onChange={(backdrop) => save({ backdrop }, `Background changed to ${backdrop}.`)}
        />
      )}
      <Choice
        label="Mode"
        value={appearance.mode}
        options={[{ value: 'system', label: 'Match phone' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
        onChange={(mode) => save({ mode }, mode === 'system' ? 'SampCrew now follows your phone’s light or dark setting.' : `SampCrew now uses ${mode} mode.`)}
      />
      <Choice
        label="Contrast"
        value={appearance.contrast}
        options={[{ value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }]}
        onChange={(contrast) => save({ contrast }, contrast === 'high' ? 'High contrast is on.' : 'Standard contrast.')}
      />
      <Text size={13} weight="600">Theme</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel="Theme" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {THEME_PRESETS.map((p) => {
          const on = p.key === appearance.preset;
          const swatch = buildTheme({ ...DEFAULT_APPEARANCE, preset: p.key }, theme.mode);
          return (
            <Pressable
              key={p.key}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              aria-checked={on}
              accessibilityLabel={p.name}
              testID={`theme-${p.key}`}
              onPress={() => !on && save({ preset: p.key }, `Theme changed to ${p.name}.`)}
              style={{ width: '47%', flexGrow: 1, borderWidth: on ? 2 : 1, borderColor: on ? theme.accent : theme.border, borderRadius: 10, padding: 8, gap: 6, backgroundColor: theme.card }}
            >
              <View style={{ flexDirection: 'row', height: 18, borderRadius: 6, overflow: 'hidden' }}>
                {[swatch.bg, swatch.accent, swatch.ember, swatch['glow-3']].map((c, i) => <View key={i} style={{ flex: 1, backgroundColor: c }} />)}
              </View>
              <Text size={13} weight={on ? '700' : '500'} numberOfLines={1}>{p.name}</Text>
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

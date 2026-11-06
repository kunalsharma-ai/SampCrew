import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useSession } from '../src/lib/session';
import { Button, Notice, Screen, Text, Title } from '../src/ui';

export default function Unlock() {
  const { unlock, signOut } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const r = await unlock();
    setBusy(false);
    if (!r.ok) setError(r.message ?? 'Could not unlock.');
  };
  useEffect(() => {
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Screen>
      <View style={{ height: 60 }} />
      <Title>SampCrew is locked</Title>
      <Text muted>Unlock with your fingerprint or face to continue.</Text>
      {error && <Notice tone="danger">{error}</Notice>}
      <Button title="Unlock" onPress={go} busy={busy} />
      <Button title="Sign out" kind="secondary" onPress={signOut} />
    </Screen>
  );
}

import { welcomeSceneFor } from '@crew/contracts';
import { useEffect, useState } from 'react';
import { useSession } from '../src/lib/session';
import { Button, Notice, Screen, Text, Title } from '../src/ui';
import { WelcomeHero } from '../src/ui/welcome';

export default function Unlock() {
  const { unlock, signOut, me } = useSession();
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
      {/* The level's welcome; biometric unlock starts at once and is not held back by the animation. */}
      <WelcomeHero scene={welcomeSceneFor(me?.levels)} />
      <Title>SampCrew is locked</Title>
      <Text muted>Unlock with your fingerprint or face to continue.</Text>
      {error && <Notice tone="danger">{error}</Notice>}
      <Button title="Unlock" onPress={go} busy={busy} />
      <Button title="Sign out" kind="secondary" onPress={signOut} />
    </Screen>
  );
}

import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { ApiError } from '../src/lib/api';
import { useSession } from '../src/lib/session';
import { Button, Card, Loading, Notice, Screen, Title } from '../src/ui';

/**
 * Where single sign-on comes back to with a one-time code. In the browser preview the whole tab went to the identity
 * provider, so the code is exchanged here. On a phone the system browser hands the address straight to the sign-in
 * screen, which exchanges it; if the phone opens this screen as well, it simply goes back.
 */
export default function SsoReturn() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const { finishSso } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (Platform.OS !== 'web') return router.replace('/login');
    if (!code) return setError('The sign-in did not return a code. Start again.');
    finishSso(code)
      .then((step) => {
        if (step.step !== 'done') setError('Your account needs another step. Sign in again from the start.');
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not finish signing in. Start again.'));
  }, [code, finishSso, router]);

  if (!error) return <Loading />;
  return (
    <Screen>
      <View style={{ height: 40 }} />
      <Title>SampCrew</Title>
      <Card>
        <Notice tone="danger" testID="sso-error">{error}</Notice>
        <Button title="Back to sign-in" onPress={() => router.replace('/login')} />
      </Card>
    </Screen>
  );
}

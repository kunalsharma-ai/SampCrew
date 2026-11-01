import * as Notifications from 'expo-notifications';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { appRoute } from '../src/lib/format';
import { configureForeground } from '../src/lib/push';
import { SessionProvider, useSession } from '../src/lib/session';
import { Loading, useTheme } from '../src/ui';

configureForeground();

/** Sends the person to sign-in, the lock screen or the app, depending on the session. */
function Gate() {
  const { status } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const t = useTheme();

  useEffect(() => {
    if (status === 'loading') return;
    const at = segments[0];
    if (status === 'signedOut' && at !== 'login') router.replace('/login');
    else if (status === 'locked' && at !== 'unlock') router.replace('/unlock');
    else if (status === 'ready' && (at === 'login' || at === 'unlock')) router.replace('/');
  }, [status, segments, router]);

  // Tapping a push notification opens the screen it is about (after sign-in and unlock).
  useEffect(() => {
    if (Platform.OS === 'web' || status !== 'ready') return;
    const open = (n: Notifications.NotificationResponse | null) => {
      const route = appRoute(n?.notification.request.content.data?.link as string | undefined);
      if (route) router.push(route as never);
    };
    void Notifications.getLastNotificationResponseAsync().then(open);
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, [status, router]);

  if (status === 'loading') return <Loading />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.card }, headerTintColor: t.fg, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="unlock" options={{ headerShown: false }} />
      <Stack.Screen name="approvals" options={{ title: 'Approvals' }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
      <Stack.Screen name="leave/new" options={{ title: 'Apply for leave' }} />
      <Stack.Screen name="helpdesk/new" options={{ title: 'Ask HR' }} />
      <Stack.Screen name="helpdesk/[id]" options={{ title: 'Case' }} />
      <Stack.Screen name="payslips/[id]" options={{ title: 'Payslip' }} />
      <Stack.Screen name="announcements/[id]" options={{ title: 'Announcement' }} />
      <Stack.Screen name="devices" options={{ title: 'Signed-in devices' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <Gate />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

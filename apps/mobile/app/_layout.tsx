import * as Notifications from 'expo-notifications';
import { type ErrorBoundaryProps, Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { appRoute } from '../src/lib/format';
import { configureForeground } from '../src/lib/push';
import { AppearanceProvider, useAppearanceTheme } from '../src/lib/appearance';
import { BadgesProvider } from '../src/lib/badges';
import { MobileAppProvider } from '../src/lib/mobile-app';
import { API_URL, SessionProvider, useSession } from '../src/lib/session';
import { hostOf } from '../src/lib/startup';
import { screenHelp, useTheme } from '../src/ui';

try {
  configureForeground();
} catch {
  // Notifications are optional: the app must still open if they cannot be set up on this phone.
}

const LOGO = { light: require('../assets/logo-light.png'), dark: require('../assets/logo-dark.png') } as const;

/**
 * Takes the native splash screen down. Expo Router only does that once a navigator has mounted, and the app shows
 * its own starting screen (not a navigator) while it checks the saved sign-in, so without this a slow or failed
 * check left the phone on the splash screen for good.
 */
function hideSplash() {
  SplashScreen.hideAsync().catch(() => {});
}

/** Shown while the app checks the saved sign-in. Says what it is waiting for if that takes more than a moment. */
function Starting() {
  const t = useTheme();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    hideSplash();
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View testID="app-starting" style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 20 }}>
      <Image source={LOGO[t.mode]} style={{ width: 220, height: 58 }} resizeMode="contain" accessibilityLabel="SampCrew" />
      <ActivityIndicator color={t.accent} />
      {slow && (
        <Text style={{ color: t.muted, textAlign: 'center' }}>
          Connecting to {hostOf(API_URL)}…
        </Text>
      )}
    </View>
  );
}

/** If anything in the app fails to draw, say so with a way to try again, instead of a blank or frozen screen. */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const t = useAppearanceTheme();
  useEffect(hideSplash, []);
  return (
    <View testID="app-error" style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}>
      <Text style={{ color: t.fg, fontSize: 18, fontWeight: '700', textAlign: 'center' }}>SampCrew could not open this screen</Text>
      <Text style={{ color: t.muted, textAlign: 'center' }}>{error.message}</Text>
      <Pressable accessibilityRole="button" onPress={() => void retry()} style={{ backgroundColor: t.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 24 }}>
        <Text style={{ color: t.accentFg, fontWeight: '600' }}>Try again</Text>
      </Pressable>
    </View>
  );
}

/** Sends the person to sign-in, the lock screen or the app, depending on the session. */
function Gate() {
  const { status } = useSession();
  const segments = useSegments();
  const router = useRouter();
  const t = useTheme();

  useEffect(() => {
    if (status === 'loading') return;
    const at = segments[0];
    // /sso is where single sign-on comes back to in the browser preview; it signs the person in itself.
    if (status === 'signedOut' && at !== 'login' && at !== 'sso') router.replace('/login');
    else if (status === 'locked' && at !== 'unlock') router.replace('/unlock');
    else if (status === 'ready' && (at === 'login' || at === 'unlock' || at === 'sso')) router.replace('/');
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

  if (status === 'loading') return <Starting />;
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: t.neon ? t.bg : t.card }, headerShadowVisible: !t.neon, headerTitleStyle: { fontWeight: t.neon ? '700' : '600' }, headerTintColor: t.fg, contentStyle: { backgroundColor: t.bg } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="unlock" options={{ headerShown: false }} />
      <Stack.Screen name="sso" options={{ headerShown: false }} />
      <Stack.Screen name="approvals" options={{ title: 'Approvals', ...screenHelp('approvals') }} />
      <Stack.Screen name="notifications" options={{ title: 'Notifications', ...screenHelp('notifications') }} />
      <Stack.Screen name="leave/new" options={{ title: 'Apply for leave', ...screenHelp('leave.new') }} />
      <Stack.Screen name="helpdesk/new" options={{ title: 'Ask HR', ...screenHelp('helpdesk.new') }} />
      <Stack.Screen name="helpdesk/[id]" options={{ title: 'Case', ...screenHelp('helpdesk.case') }} />
      <Stack.Screen name="payslips/[id]" options={{ title: 'Payslip', ...screenHelp('payslip') }} />
      <Stack.Screen name="announcements/[id]" options={{ title: 'Announcement', ...screenHelp('announcement') }} />
      <Stack.Screen name="devices" options={{ title: 'Signed-in devices', ...screenHelp('devices') }} />
      <Stack.Screen name="tasks/index" options={{ title: 'My tasks', ...screenHelp('tasks') }} />
      <Stack.Screen name="tasks/[id]" options={{ title: 'Task', ...screenHelp('tasks.task') }} />
      <Stack.Screen name="appraisal/index" options={{ title: 'Appraisal', ...screenHelp('appraisal') }} />
      <Stack.Screen name="appraisal/[id]" options={{ title: 'Appraisal', ...screenHelp('appraisal.form') }} />
      <Stack.Screen name="profile" options={{ title: 'My profile', ...screenHelp('profile') }} />
      <Stack.Screen name="chat/[id]" options={{ title: 'Conversation', ...screenHelp('chat.conversation') }} />
      <Stack.Screen name="chat/new" options={{ title: 'New conversation', ...screenHelp('chat.new') }} />
      <Stack.Screen name="email/[id]" options={{ title: 'Email', ...screenHelp('email.read') }} />
      <Stack.Screen name="email/compose" options={{ title: 'New email', ...screenHelp('email.compose') }} />
      <Stack.Screen name="attendance/history" options={{ title: 'Attendance history', ...screenHelp('attendance.history') }} />
      <Stack.Screen name="attendance/team" options={{ title: 'Team attendance', ...screenHelp('attendance.team') }} />
      <Stack.Screen name="announcements/index" options={{ title: 'Announcements', ...screenHelp('announcements') }} />
      <Stack.Screen name="payslips/index" options={{ title: 'Payslips', ...screenHelp('payslips') }} />
      <Stack.Screen name="directory" options={{ title: 'Directory', ...screenHelp('directory') }} />
      <Stack.Screen name="sessions" options={{ title: 'Login and sessions', ...screenHelp('sessions') }} />
      <Stack.Screen name="search" options={{ title: 'Search', ...screenHelp('search') }} />
      <Stack.Screen name="help/index" options={{ title: 'Help & Support', ...screenHelp('help') }} />
      <Stack.Screen name="help/search" options={{ title: 'Search help', ...screenHelp('help.search') }} />
      <Stack.Screen name="help/category/[key]" options={{ title: 'Help category', ...screenHelp('help.category') }} />
      <Stack.Screen name="help/article/[slug]" options={{ title: 'Help article', ...screenHelp('help.article') }} />
      <Stack.Screen name="help/ask" options={{ title: 'Raise a Query', ...screenHelp('help.ask') }} />
      <Stack.Screen name="help/queries/index" options={{ title: 'My queries', ...screenHelp('help.queries') }} />
      <Stack.Screen name="help/queries/[id]" options={{ title: 'Query', ...screenHelp('help.query') }} />
    </Stack>
  );
}

function ThemedStatusBar() {
  const t = useTheme();
  return <StatusBar style={t.mode === 'dark' ? 'light' : 'dark'} />;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <AppearanceProvider>
          <MobileAppProvider>
            <BadgesProvider>
              <ThemedStatusBar />
              <Gate />
            </BadgesProvider>
          </MobileAppProvider>
        </AppearanceProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

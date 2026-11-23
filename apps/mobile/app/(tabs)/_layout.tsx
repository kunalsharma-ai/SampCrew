import { Tabs } from 'expo-router';
import { cloneElement, type ReactElement } from 'react';
import { type ColorValue, View } from 'react-native';
import { useBadges } from '../../src/lib/badges';
import { useMobileApp } from '../../src/lib/mobile-app';
import { useSession } from '../../src/lib/session';
import { gradient, glow, screenHelp, useTheme } from '../../src/ui';
import { Icon } from '../../src/ui/kit';

/** Short names for the bottom bar (the full module names are used in More and on Home). */
const TAB_LABEL: Record<string, string> = {
  attendance: 'Attendance', leave: 'Leave', chat: 'Chat', email: 'Email', documents: 'Documents', learning: 'Learning', help: 'Ask HR', profile: 'Me',
};
/** The screen in this folder that each tabbable module opens. */
const TAB_SCREEN: Record<string, string> = {
  attendance: 'attendance', leave: 'leave', chat: 'chat', email: 'email', documents: 'documents', learning: 'learning', help: 'helpdesk', profile: 'me',
};

/**
 * The bottom bar: Home, the modules the Super Workspace placed there for this person's level (at most three, in its
 * order) and More. Every other module screen stays reachable from More and links, without a tab of its own. The
 * bar follows the published configuration as soon as the app receives it.
 */
export default function TabsLayout() {
  const t = useTheme();
  const { can, queue } = useSession();
  const { app } = useMobileApp();
  const badges = useBadges();
  const tabs = (app?.tabs ?? []).filter((k) => TAB_SCREEN[k]);
  const handler = can('helpdesk:manage');

  const glyph = (name: string) =>
    function TabIcon({ color, focused }: { color: ColorValue; focused: boolean }) {
      const icon = focused ? name : `${name}-outline`;
      if (!t.neon || !focused) return <Icon name={icon} size={22} color={String(color)} />;
      return (
        <View style={[{ width: 44, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, gradient(`linear-gradient(120deg, ${t.gradient[0]}, ${t.gradient[1]})`, t.accent), glow(t.accent, 0.7, 6, 16)]}>
          <Icon name={icon} size={19} color={t.accentFg} />
        </View>
      );
    };
  const shown = (module: string) => (tabs.includes(module) ? undefined : null);
  const badge = (n: number) => (n > 0 ? (n > 99 ? '99+' : n) : undefined);

  const screens: Record<string, ReactElement> = {
    attendance: <Tabs.Screen name="attendance" options={{ title: TAB_LABEL.attendance, ...screenHelp('attendance'), href: shown('attendance'), tabBarIcon: glyph('time'), tabBarBadge: badge(queue.pending.length) }} />,
    leave: <Tabs.Screen name="leave" options={{ title: TAB_LABEL.leave, ...screenHelp('leave'), href: shown('leave'), tabBarIcon: glyph('sunny') }} />,
    chat: <Tabs.Screen name="chat" options={{ title: TAB_LABEL.chat, ...screenHelp('chat'), href: shown('chat'), tabBarIcon: glyph('chatbubbles'), tabBarBadge: badge(badges.chat) }} />,
    email: <Tabs.Screen name="email" options={{ title: TAB_LABEL.email, ...screenHelp('email'), href: shown('email'), tabBarIcon: glyph('mail') }} />,
    documents: <Tabs.Screen name="documents" options={{ title: TAB_LABEL.documents, ...screenHelp('documents'), href: shown('documents'), tabBarIcon: glyph('document-text') }} />,
    learning: <Tabs.Screen name="learning" options={{ title: TAB_LABEL.learning, ...screenHelp('learning'), href: shown('learning'), tabBarIcon: glyph('school') }} />,
    help: <Tabs.Screen name="helpdesk" options={{ title: handler ? 'HR helpdesk' : 'Ask HR', ...screenHelp('helpdesk'), href: shown('help'), tabBarIcon: glyph('help-buoy') }} />,
    profile: <Tabs.Screen name="me" options={{ title: TAB_LABEL.profile, ...screenHelp('me'), href: shown('profile'), tabBarIcon: glyph('person-circle') }} />,
  };
  // Tabs keep the order of their screens: the configured ones first (in the configured order), then the hidden ones.
  const order = [...tabs, ...Object.keys(screens).filter((k) => !tabs.includes(k))];

  const bar = t.neon
    ? { tabBarStyle: { backgroundColor: t.night.bg, borderTopColor: t.night.border, height: 64, paddingTop: 6, paddingBottom: 8 }, tabBarActiveTintColor: t.night.fg, tabBarInactiveTintColor: t.night.muted }
    : { tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border }, tabBarActiveTintColor: t.accent, tabBarInactiveTintColor: t.muted };
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.neon ? t.bg : t.card, ...(t.neon ? { borderBottomWidth: 0, shadowOpacity: 0, elevation: 0 } : {}) },
        headerTitleStyle: { fontWeight: t.neon ? '700' : '600' },
        headerTintColor: t.fg,
        ...bar,
        tabBarLabelStyle: { fontWeight: '600', fontSize: 11 },
        // Screens that are not open are not kept drawing in the background.
        freezeOnBlur: true,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', ...screenHelp('home'), tabBarIcon: glyph('home') }} />
      {order.map((k) => cloneElement(screens[k]!, { key: k }))}
      <Tabs.Screen name="more" options={{ title: 'More', ...screenHelp('more'), tabBarIcon: glyph('grid'), tabBarBadge: tabs.includes('chat') ? undefined : badge(badges.chat) }} />
    </Tabs>
  );
}

import { Tabs } from 'expo-router';
import { type ColorValue, Text, View } from 'react-native';
import { useSession } from '../../src/lib/session';
import { NIGHT } from '../../src/lib/theme';
import { gradient, glow, screenHelp, useTheme } from '../../src/ui';

export default function TabsLayout() {
  const t = useTheme();
  const { hasFeature, can, queue } = useSession();
  const attendance = hasFeature('attendance_basic') && can('attendance:punch');
  const leave = hasFeature('leave');
  const helpdesk = hasFeature('helpdesk') && can('helpdesk:use');
  // Neon: a night tab bar in every mode (like the Web Portal's sidebar), the current tab's icon in a gradient pill.
  const glyph = (g: string) =>
    function TabIcon({ color, focused }: { color: ColorValue; focused: boolean }) {
      if (!t.neon || !focused) return <Text style={{ color, fontSize: 18 }}>{g}</Text>;
      return (
        <View style={[{ width: 44, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, gradient(`linear-gradient(120deg, ${t.gradient[0]}, ${t.gradient[1]})`, t.accent), glow(t.accent, 0.7, 6, 16)]}>
          <Text style={{ color: t.accentFg, fontSize: 17 }}>{g}</Text>
        </View>
      );
    };
  const bar = t.neon
    ? { tabBarStyle: { backgroundColor: NIGHT.bg, borderTopColor: NIGHT.border, height: 64, paddingTop: 6, paddingBottom: 8 }, tabBarActiveTintColor: NIGHT.fg, tabBarInactiveTintColor: NIGHT.muted }
    : { tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border }, tabBarActiveTintColor: t.accent, tabBarInactiveTintColor: t.muted };
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.neon ? t.bg : t.card, ...(t.neon ? { borderBottomWidth: 0, shadowOpacity: 0, elevation: 0 } : {}) },
        headerTitleStyle: { fontWeight: t.neon ? '700' : '600' },
        headerTintColor: t.fg,
        ...bar,
        tabBarLabelStyle: { fontWeight: '600', fontSize: 11 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', ...screenHelp('home'), tabBarIcon: glyph('⌂') }} />
      <Tabs.Screen name="attendance" options={{ title: 'Attendance', ...screenHelp('attendance'), href: attendance ? undefined : null, tabBarIcon: glyph('◷'), tabBarBadge: queue.pending.length || undefined }} />
      <Tabs.Screen name="leave" options={{ title: 'Leave', ...screenHelp('leave'), href: leave ? undefined : null, tabBarIcon: glyph('☼') }} />
      <Tabs.Screen name="helpdesk" options={{ title: 'Ask HR', ...screenHelp('helpdesk'), href: helpdesk ? undefined : null, tabBarIcon: glyph('?') }} />
      <Tabs.Screen name="me" options={{ title: 'Me', ...screenHelp('me'), tabBarIcon: glyph('☺') }} />
    </Tabs>
  );
}

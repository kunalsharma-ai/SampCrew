import { Tabs } from 'expo-router';
import { type ColorValue, Text } from 'react-native';
import { useSession } from '../../src/lib/session';
import { useTheme } from '../../src/ui';

const glyph = (g: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }}>{g}</Text>;

export default function TabsLayout() {
  const t = useTheme();
  const { hasFeature, can, queue } = useSession();
  const attendance = hasFeature('attendance_basic') && can('attendance:punch');
  const selfService = hasFeature('self_service');
  return (
    <Tabs screenOptions={{ headerStyle: { backgroundColor: t.card }, headerTintColor: t.fg, tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border }, tabBarActiveTintColor: t.accent, tabBarInactiveTintColor: t.muted }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: glyph('⌂') }} />
      <Tabs.Screen name="attendance" options={{ title: 'Attendance', href: attendance ? undefined : null, tabBarIcon: glyph('◷'), tabBarBadge: queue.pending.length || undefined }} />
      <Tabs.Screen name="leave" options={{ title: 'Leave', tabBarIcon: glyph('☼') }} />
      <Tabs.Screen name="helpdesk" options={{ title: 'Ask HR', href: selfService ? undefined : null, tabBarIcon: glyph('?') }} />
      <Tabs.Screen name="me" options={{ title: 'Me', tabBarIcon: glyph('☺') }} />
    </Tabs>
  );
}

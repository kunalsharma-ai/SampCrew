import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text as RNText, View, type ViewStyle } from 'react-native';
import { useMobileApp } from '../lib/mobile-app';
import { alpha, NEON_TILES, type TileTone } from '../lib/theme';
import { Button, Card, gradient, glow, Text, useTheme } from './index';

export type IconName = ComponentProps<typeof Ionicons>['name'];

/** One icon set across the app (Ionicons), so every screen draws icons the same way. */
export function Icon({ name, size = 20, color, style }: { name: string; size?: number; color?: string; style?: object }) {
  const t = useTheme();
  const glyph = (name in Ionicons.glyphMap ? name : 'ellipse-outline') as IconName;
  return <Ionicons name={glyph} size={size} color={color ?? t.fg} style={style} accessibilityElementsHidden importantForAccessibility="no" aria-hidden />;
}

/** Which tile colour each module's icon uses, so a module looks the same in the menu, on Home and in its screen. */
export const MODULE_TONE: Record<string, TileTone> = {
  attendance: 'violet', leave: 'orange', chat: 'blue', email: 'teal', documents: 'pink', learning: 'green', announcements: 'orange', notifications: 'violet',
  approvals: 'green', tasks: 'blue', appraisal: 'pink', payslips: 'teal', help: 'blue', directory: 'violet', profile: 'violet', sessions: 'teal', home: 'violet', search: 'blue',
};

/**
 * A dimensional icon: a glossy gradient tile with a highlight on top and a soft coloured shadow beneath, the "3D"
 * look of the brand drawn with plain views (no images to download, nothing to slow a list down).
 */
export function Icon3D({ name, tone = 'violet', size = 44, testID }: { name: string; tone?: TileTone; size?: number; testID?: string }) {
  const t = useTheme();
  const [c1, c2] = NEON_TILES[tone];
  return (
    <View testID={testID} style={[{ width: size, height: size, borderRadius: size * 0.32, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, gradient(`linear-gradient(145deg, ${c1}, ${c2})`, c1), glow(c1, t.mode === 'dark' ? 0.55 : 0.4, Math.round(size / 6), Math.round(size / 2.2))]}>
      <View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: size * 0.48, borderTopLeftRadius: size * 0.32, borderTopRightRadius: size * 0.32 }, gradient('linear-gradient(180deg, rgba(255,255,255,0.38), rgba(255,255,255,0))', 'transparent')]} />
      <View pointerEvents="none" style={{ position: 'absolute', bottom: -size * 0.25, right: -size * 0.2, width: size * 0.7, height: size * 0.7, borderRadius: size, backgroundColor: 'rgba(255,255,255,0.10)' }} />
      <Icon name={name} size={Math.round(size * 0.5)} color="#ffffff" />
    </View>
  );
}

/**
 * A small scene for empty and welcome states: the module's 3D icon floating on soft brand circles. Light enough
 * to draw instantly; it never stands in for real data.
 */
export function Illustration({ name, tone = 'violet', size = 120 }: { name: string; tone?: TileTone; size?: number }) {
  const [c1] = NEON_TILES[tone];
  const float = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // One short bob when it appears, not a loop: nothing keeps running in the background.
    Animated.sequence([
      Animated.timing(float, { toValue: -6, duration: 380, useNativeDriver: true }),
      Animated.timing(float, { toValue: 0, duration: 420, useNativeDriver: true }),
    ]).start();
  }, [float]);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} accessibilityElementsHidden importantForAccessibility="no">
      <View style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: alpha(c1, 0.08) }} />
      <View style={{ position: 'absolute', width: size * 0.72, height: size * 0.72, borderRadius: size, backgroundColor: alpha(c1, 0.12) }} />
      <View style={{ position: 'absolute', top: size * 0.12, right: size * 0.1, width: 10, height: 10, borderRadius: 5, backgroundColor: alpha(c1, 0.45) }} />
      <View style={{ position: 'absolute', bottom: size * 0.16, left: size * 0.08, width: 7, height: 7, borderRadius: 4, backgroundColor: alpha(c1, 0.35) }} />
      <Animated.View style={{ transform: [{ translateY: float }] }}>
        <Icon3D name={name} tone={tone} size={Math.round(size * 0.46)} />
      </Animated.View>
    </View>
  );
}

/** An empty or setup state: illustration, a plain title, what to do, and an optional action. */
export function EmptyState({ icon, tone, title, body, action, testID }: { icon: string; tone?: TileTone; title: string; body?: string; action?: { title: string; onPress: () => void }; testID?: string }) {
  return (
    <View testID={testID} style={{ alignItems: 'center', gap: 8, paddingVertical: 20, paddingHorizontal: 12 }}>
      <Illustration name={icon} tone={tone} />
      <Text weight="700" size={17} style={{ textAlign: 'center' }}>{title}</Text>
      {body ? <Text muted size={14} style={{ textAlign: 'center', maxWidth: 320 }}>{body}</Text> : null}
      {action ? <View style={{ marginTop: 6, alignSelf: 'stretch' }}><Button title={action.title} onPress={action.onPress} /></View> : null}
    </View>
  );
}

/** A section label between cards. */
export function Section({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
      <Text weight="800" size={13} style={{ letterSpacing: 0.8, textTransform: 'uppercase', color: t.muted }} accessibilityRole="header">{title}</Text>
      {action && onAction ? (
        <Pressable accessibilityRole="link" onPress={onAction} hitSlop={8}>
          <RNText style={{ color: t.accent, fontWeight: '600', fontSize: 13 }}>{action}</RNText>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A placeholder block with the size of the content it waits for, so nothing jumps when data arrives. */
export function Skeleton({ height = 16, width = '100%', radius = 8, style }: { height?: number; width?: ViewStyle['width']; radius?: number; style?: ViewStyle }) {
  const t = useTheme();
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.5, duration: 650, useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [pulse]);
  return <Animated.View style={[{ height, width, borderRadius: radius, backgroundColor: alpha(t.accent, t.mode === 'dark' ? 0.18 : 0.1), opacity: pulse }, style]} />;
}

/** A card-shaped loading placeholder (a few lines). */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <Card>
      <Skeleton height={18} width="45%" />
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} height={14} width={i === lines - 1 ? '70%' : '100%'} />)}
    </Card>
  );
}

/** A row with a 3D icon, title, subtitle and an optional right side; tappable when it leads somewhere. */
export function IconRow({ icon, tone, title, subtitle, right, onPress, testID, badge }: { icon: string; tone?: TileTone; title: string; subtitle?: string; right?: ReactNode; onPress?: () => void; testID?: string; badge?: number }) {
  const t = useTheme();
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 }}>
      <Icon3D name={icon} tone={tone} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text weight="600" numberOfLines={1} testID={testID ? `${testID}-title` : undefined}>{title}</Text>
        {subtitle ? <Text muted size={13} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {badge ? <CountBadge n={badge} /> : null}
      {right ?? (onPress ? <Icon name="chevron-forward" size={18} color={t.muted} /> : null)}
    </View>
  );
  if (!onPress) return <View testID={testID}>{body}</View>;
  return <Pressable testID={testID} accessibilityRole="link" accessibilityLabel={subtitle ? undefined : title} onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>{body}</Pressable>;
}

/** An unread count; 99+ above that. */
export function CountBadge({ n, testID }: { n: number; testID?: string }) {
  const t = useTheme();
  if (!n) return null;
  return (
    <View testID={testID} style={{ minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: t.danger }}>
      <RNText style={{ color: '#ffffff', fontSize: 11, fontWeight: '700' }}>{n > 99 ? '99+' : n}</RNText>
    </View>
  );
}

/**
 * Wraps a module's screen: when the Super Workspace hid the module (or the person may not use it), the screen says
 * so instead of opening, also when its address is opened directly. The server refuses its data either way.
 */
export function ModuleGate({ module, feature, children }: { module: string; feature?: string; children: ReactNode }) {
  const { app, has } = useMobileApp();
  const router = useRouter();
  if (!app) return null;
  if (has(feature ? `${module}.${feature}` : module)) return <>{children}</>;
  return (
    <View testID="module-off" style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
      <EmptyState
        icon="lock-closed"
        tone="violet"
        title="Not available in the app"
        body="Your company’s Super Workspace decides which modules the SampCrew app shows. This one is not available to you here. Your records are safe."
        action={{ title: 'Go to Home', onPress: () => router.replace('/') }}
      />
    </View>
  );
}

/** A value that follows another after it stopped changing for a moment (search boxes ask once, not per letter). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setV(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return v;
}

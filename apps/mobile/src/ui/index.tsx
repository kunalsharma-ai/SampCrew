import { useFocusEffect } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError } from '../lib/api';
import { useAppearanceTheme } from '../lib/appearance';
import { alpha, type MobileTheme, NEON_TILES, type TileTone } from '../lib/theme';
import { money } from '../lib/format';

export type Theme = MobileTheme;
/** The member's palette (see lib/theme): their saved preset and mode, or the default before sign-in. */
export function useTheme(): Theme {
  return useAppearanceTheme();
}

export function Text({ children, muted, size = 15, weight, style, testID, numberOfLines, accessibilityRole }: { children: ReactNode; muted?: boolean; size?: number; weight?: TextStyle['fontWeight']; style?: TextStyle; testID?: string; numberOfLines?: number; accessibilityRole?: 'header' }) {
  const t = useTheme();
  return (
    <RNText testID={testID} numberOfLines={numberOfLines} accessibilityRole={accessibilityRole} style={[{ color: muted ? t.muted : t.fg, fontSize: size, fontWeight: weight, lineHeight: Math.round(size * 1.4) }, style]}>
      {children}
    </RNText>
  );
}

export function Title({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" size={t.neon ? 26 : 22} weight={t.neon ? '800' : '700'} style={{ marginBottom: 4, letterSpacing: t.neon ? -0.4 : 0 }}>
      {children}
    </Text>
  );
}

/**
 * A CSS gradient as a style. React Native draws it natively (new architecture) and React Native Web as CSS; the solid
 * colour underneath is what shows if a platform cannot draw it, so text on it stays readable either way.
 */
export function gradient(css: string, fallback: string): ViewStyle {
  return (Platform.OS === 'web' ? { backgroundColor: fallback, backgroundImage: css } : { backgroundColor: fallback, experimental_backgroundImage: css }) as ViewStyle;
}

/** A soft coloured glow under a neon surface. */
export function glow(color: string, strength = 0.45, y = 14, blur = 30): ViewStyle {
  return { boxShadow: `0 ${y}px ${blur}px -${Math.round(blur / 2)}px ${alpha(color, strength)}` } as ViewStyle;
}

/** The background art behind every screen in the neon style, built on the theme's background colour. */
function Backdrop() {
  const t = useTheme();
  if (!t.neon || t.backdrop === 'plain') return null;
  const [g1, g2, g3] = t.glow;
  const fade = t.mode === 'dark' ? 1.4 : 1;
  const layers =
    t.backdrop === 'gradient'
      ? `radial-gradient(circle at 0% 0%, ${alpha(g1, 0.3 * fade)}, transparent 60%), radial-gradient(circle at 100% 15%, ${alpha(g3, 0.26 * fade)}, transparent 60%), radial-gradient(circle at 50% 110%, ${alpha(g2, 0.26 * fade)}, transparent 60%)`
      : `radial-gradient(circle at 5% -5%, ${alpha(g1, 0.22 * fade)}, transparent 55%), radial-gradient(circle at 100% 0%, ${alpha(g3, 0.16 * fade)}, transparent 55%), radial-gradient(circle at 75% 105%, ${alpha(g2, 0.15 * fade)}, transparent 55%)`;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, gradient(layers, t.bg)]}>
      {t.backdrop === 'aurora' && (
        <>
          <View style={[{ position: 'absolute', left: 0, right: 0, top: 0, height: 260 }, gradient(`linear-gradient(180deg, ${alpha(g1, 0.16 * fade)}, transparent)`, 'transparent')]} />
          {RIDGES.map((r, i) => (
            <View
              key={i}
              style={[
                { position: 'absolute', top: r.top, left: `${r.left}%`, width: r.size, height: r.size, transform: [{ rotate: '45deg' }], borderRadius: 18 },
                gradient(`linear-gradient(135deg, ${alpha(i % 2 ? g3 : g1, 0.13 * fade)}, transparent 70%)`, 'transparent'),
              ]}
            />
          ))}
        </>
      )}
      {t.backdrop === 'cosmos' &&
        STARS.map((s, i) => (
          <View key={i} style={{ position: 'absolute', left: `${s[0]}%`, top: `${s[1]}%`, width: s[2], height: s[2], borderRadius: s[2], backgroundColor: alpha(t.fg === '#ffffff' ? '#ffffff' : t.fg, t.mode === 'dark' ? 0.5 : 0.28) }} />
        ))}
    </View>
  );
}
/** Mountain ridges across the top (aurora): rotated squares whose tops form peaks, faded out downwards. */
const RIDGES = [
  { left: -12, top: 70, size: 170 }, { left: 22, top: 40, size: 200 }, { left: 58, top: 80, size: 160 }, { left: 80, top: 30, size: 210 },
  { left: 5, top: 120, size: 150 }, { left: 40, top: 110, size: 170 }, { left: 70, top: 125, size: 150 },
];
/** Star field (cosmos): fixed positions so the art does not move between renders. [x%, y%, size]. */
const STARS: [number, number, number][] = [
  [8, 6, 2], [22, 14, 1.5], [37, 4, 2], [52, 11, 1.5], [68, 7, 2.5], [86, 13, 1.5], [93, 3, 2], [14, 27, 1.5], [44, 23, 2], [77, 25, 1.5],
  [5, 41, 2], [30, 37, 1.5], [61, 39, 2], [90, 44, 1.5], [18, 55, 1.5], [48, 58, 2], [72, 53, 1.5], [96, 62, 2], [10, 72, 2], [36, 76, 1.5],
  [58, 71, 2], [83, 79, 1.5], [24, 90, 2], [66, 92, 1.5], [91, 95, 2],
];

/** Scrollable screen with pull-to-refresh. */
export function Screen({ children, onRefresh, refreshing = false }: { children: ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  const t = useTheme();
  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
      <Backdrop />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Card({ children, style, testID }: { children: ReactNode; style?: ViewStyle; testID?: string }) {
  const t = useTheme();
  return (
    <View
      testID={testID}
      style={[
        t.neon
          ? [{ backgroundColor: t.glass, borderRadius: t.radius, borderWidth: 1, borderColor: alpha(t.accent, 0.14), padding: 16, gap: 10 }, glow(t.glow[0], t.mode === 'dark' ? 0.5 : 0.28, 16, 36)]
          : { backgroundColor: t.card, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, padding: 14, gap: 8 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A card heading; in the neon style with a small brand bar in front, as on the Web Portal's cards. */
export function CardTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Row style={{ flex: 1 }}>
        {t.neon && <View style={[{ width: 4, height: 16, borderRadius: 2 }, gradient(`linear-gradient(180deg, ${t.gradient[0]}, ${t.gradient[1]})`, t.accent)]} />}
        <Text weight="700" size={t.neon ? 16 : 15} accessibilityRole="header">{children}</Text>
      </Row>
      {right}
    </Row>
  );
}

/**
 * The top of a main screen: a small eyebrow (workspace), a big greeting and an optional chip (role, status). In the
 * neon style it sits on a soft brand glow.
 */
export function Hero({ eyebrow, title, subtitle, chip, testID }: { eyebrow?: string; title: string; subtitle?: string; chip?: string; testID?: string }) {
  const t = useTheme();
  return (
    <View testID={testID} style={{ gap: 4, paddingTop: t.neon ? 6 : 0 }}>
      {eyebrow ? <Text size={12} weight="700" style={{ color: t.accent, letterSpacing: 1.2, textTransform: 'uppercase' }}>{eyebrow}</Text> : null}
      <Text accessibilityRole="header" size={t.neon ? 28 : 22} weight={t.neon ? '800' : '700'} style={{ letterSpacing: t.neon ? -0.5 : 0 }}>{title}</Text>
      {subtitle ? <Text muted>{subtitle}</Text> : null}
      {chip ? (
        <View style={{ alignSelf: 'flex-start', marginTop: 4, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: t.infoBg, borderWidth: 1, borderColor: alpha(t.accent, 0.2) }}>
          <RNText style={{ color: t.accent, fontSize: 12, fontWeight: '600' }}>{chip}</RNText>
        </View>
      ) : null}
    </View>
  );
}

/**
 * A KPI tile. Neon: a saturated gradient with white text (every stop checked at 4.5:1). Classic: a plain card with a
 * tinted value. Tappable when it leads somewhere; the visible label is part of its accessible name.
 */
export function Tile({ value, label, hint, tone, icon, onPress, testID }: { value: string; label: string; hint?: string; tone: TileTone; icon?: string; onPress?: () => void; testID?: string }) {
  const t = useTheme();
  const [c1, c2] = NEON_TILES[tone];
  const fg = t.neon ? '#ffffff' : t.fg;
  const body = (
    <>
      {t.neon && <View pointerEvents="none" style={{ position: 'absolute', right: -34, top: -34, width: 104, height: 104, borderRadius: 52, borderWidth: 16, borderColor: 'rgba(255,255,255,0.09)' }} />}
      <Row style={{ gap: 10 }}>
        {icon ? (
          <View style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: t.neon ? 'rgba(255,255,255,0.18)' : alpha(c1, 0.12) }}>
            <RNText style={{ color: t.neon ? '#ffffff' : c1, fontSize: 16 }}>{icon}</RNText>
          </View>
        ) : null}
        <RNText style={{ flexShrink: 1, color: t.neon ? fg : c1, fontSize: value.length > 7 ? 19 : 26, fontWeight: '800', letterSpacing: -0.5 }} numberOfLines={2}>{value}</RNText>
      </Row>
      <RNText style={{ color: fg, fontSize: 14, fontWeight: '600' }}>{label}</RNText>
      {hint ? <RNText style={{ color: t.neon ? 'rgba(255,255,255,0.9)' : t.muted, fontSize: 12 }} numberOfLines={2}>{hint}</RNText> : null}
    </>
  );
  const style: ViewStyle[] = [
    { flexBasis: '46%', flexGrow: 1, borderRadius: t.radius, padding: 14, gap: 6, overflow: 'hidden', minHeight: 112 },
    t.neon ? { ...gradient(`linear-gradient(135deg, ${c1}, ${c2})`, c1), ...glow(c1, 0.55, 14, 28) } : { backgroundColor: t.card, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border },
  ];
  if (!onPress) return <View testID={testID} style={style}>{body}</View>;
  return (
    <Pressable testID={testID} accessibilityRole="link" onPress={onPress} style={({ pressed }) => [...style, { opacity: pressed ? 0.85 : 1 }]}>
      {body}
    </Pressable>
  );
}

/** Two tiles per row on a phone. */
export function TileGrid({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>{children}</View>;
}

/** A labelled progress bar (leave balance, worked hours). value and max are numbers; the bar never overflows. */
export function Meter({ label, value, max, caption, color, testID }: { label: string; value: number; max: number; caption: string; color?: string; testID?: string }) {
  const t = useTheme();
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const c = color ?? t.accent;
  return (
    <View testID={testID} style={{ gap: 6, paddingVertical: 4 }} accessible accessibilityLabel={`${label}: ${caption}`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Text weight="600">{label}</Text>
        <Text weight="600" size={14}>{caption}</Text>
      </Row>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: alpha(c, t.mode === 'dark' ? 0.25 : 0.14), overflow: 'hidden' }}>
        <View style={[{ width: `${Math.round(pct * 100)}%`, height: '100%', borderRadius: 4 }, t.neon ? gradient(`linear-gradient(90deg, ${c}, ${alpha(c, 0.7)})`, c) : { backgroundColor: c }]} />
      </View>
    </View>
  );
}

/** Round shortcut buttons under the hero (Apply for leave, Ask HR, ...). Only the ones a person can use are passed. */
export function QuickActions({ actions }: { actions: { label: string; icon: string; tone: TileTone; onPress: () => void; testID?: string }[] }) {
  const t = useTheme();
  if (!actions.length) return null;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }} accessibilityRole="toolbar" accessibilityLabel="Quick actions">
      {actions.map((a) => {
        const [c1, c2] = NEON_TILES[a.tone];
        return (
          <Pressable key={a.label} testID={a.testID} accessibilityRole="button" accessibilityLabel={a.label} onPress={a.onPress} style={({ pressed }) => ({ flex: 1, alignItems: 'center', gap: 6, opacity: pressed ? 0.7 : 1 })}>
            <View style={[{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' }, t.neon ? { ...gradient(`linear-gradient(135deg, ${c1}, ${c2})`, c1), ...glow(c1, 0.5, 8, 18) } : { backgroundColor: alpha(c1, 0.12) }]}>
              <RNText style={{ color: t.neon ? '#ffffff' : c1, fontSize: 20 }}>{a.icon}</RNText>
            </View>
            <Text size={12} weight="600" style={{ textAlign: 'center' }} numberOfLines={2}>{a.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Initials in a gradient circle (the person on Me, the greeting on Home). */
export function Avatar({ name, size = 48 }: { name: string; size?: number }) {
  const t = useTheme();
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return (
    <View accessibilityElementsHidden importantForAccessibility="no" style={[{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }, t.neon ? { ...gradient(`linear-gradient(135deg, ${t.gradient[0]}, ${t.gradient[1]})`, t.accent), ...glow(t.accent, 0.5, 8, 18) } : { backgroundColor: t.accent }]}>
      <RNText style={{ color: t.accentFg, fontSize: size * 0.36, fontWeight: '700' }}>{initials}</RNText>
    </View>
  );
}

export function Row({ children, style, testID }: { children: ReactNode; style?: ViewStyle; testID?: string }) {
  return <View testID={testID} style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]}>{children}</View>;
}

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info';
const toneColors = (t: Theme, tone: Tone) =>
  ({
    neutral: { bg: t.border, fg: t.fg },
    ok: { bg: t.okBg, fg: t.ok },
    warn: { bg: t.warnBg, fg: t.warn },
    danger: { bg: t.dangerBg, fg: t.danger },
    info: { bg: t.infoBg, fg: t.accent },
  })[tone];

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  const c = toneColors(useTheme(), tone);
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' }}>
      <RNText style={{ color: c.fg, fontSize: 12, fontWeight: '600' }}>{children}</RNText>
    </View>
  );
}

export function Notice({ children, tone = 'info', testID }: { children: ReactNode; tone?: Tone; testID?: string }) {
  const c = toneColors(useTheme(), tone);
  return (
    <View testID={testID} accessibilityRole="alert" style={{ backgroundColor: c.bg, borderRadius: 10, padding: 12 }}>
      <RNText style={{ color: c.fg, fontSize: 14, lineHeight: 20 }}>{children}</RNText>
    </View>
  );
}

export function Button({ title, onPress, kind = 'primary', disabled, busy, testID }: { title: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; testID?: string }) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.accent : kind === 'danger' ? t.danger : 'transparent';
  const fg = kind === 'secondary' ? t.accent : t.accentFg;
  const off = disabled || busy;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: kind === 'secondary' ? (t.neon ? alpha(t.accent, 0.35) : t.border) : bg,
          borderWidth: 1,
          borderRadius: t.neon ? Math.max(12, t.radius - 2) : 10,
          paddingVertical: 12,
          paddingHorizontal: 16,
          alignItems: 'center' as const,
          opacity: off ? 0.5 : pressed ? 0.8 : 1,
        },
        t.neon && kind === 'primary' ? { ...gradient(`linear-gradient(120deg, ${t.gradient[0]}, ${t.gradient[1]})`, t.accent), ...(off ? {} : glow(t.accent, 0.6, 8, 22)) } : null,
        t.neon && kind === 'danger' && !off ? glow(t.danger, 0.45, 8, 20) : null,
        t.neon && kind === 'secondary' ? { backgroundColor: alpha(t.accent, t.mode === 'dark' ? 0.12 : 0.06) } : null,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <RNText style={{ color: fg, fontWeight: '600', fontSize: 15 }}>{title}</RNText>}
    </Pressable>
  );
}

export function Field({ label, error, hint, ...props }: TextInputProps & { label: string; error?: string; hint?: string }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <Text size={13} weight="600">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.muted}
        {...props}
        style={[
          { borderWidth: 1, borderColor: error ? t.danger : t.neon ? alpha(t.accent, 0.22) : t.border, borderRadius: t.neon ? 12 : 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: t.fg, backgroundColor: t.card },
          props.multiline ? { minHeight: 96, textAlignVertical: 'top' } : null,
        ]}
      />
      {error ? <Text size={13} style={{ color: t.danger }}>{error}</Text> : hint ? <Text size={13} muted>{hint}</Text> : null}
    </View>
  );
}

/** A row of choices (segmented control). */
export function Choice<T extends string>({ label, value, options, onChange }: { label?: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      {label ? <Text size={13} weight="600">{label}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              aria-checked={on}
              onPress={() => onChange(o.value)}
              style={[
                { borderWidth: 1, borderColor: on ? t.accent : t.border, backgroundColor: on ? t.infoBg : t.card, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
                on && t.neon ? { ...gradient(`linear-gradient(120deg, ${t.gradient[0]}, ${t.gradient[1]})`, t.accent), borderColor: 'transparent', ...glow(t.accent, 0.5, 6, 16) } : null,
              ]}
            >
              <RNText style={{ color: on ? (t.neon ? t.accentFg : t.accent) : t.fg, fontSize: 14, fontWeight: on ? '600' : '400' }}>{o.label}</RNText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function ListItem({ title, subtitle, right, onPress, testID }: { title: string; subtitle?: string; right?: ReactNode; onPress?: () => void; testID?: string }) {
  const t = useTheme();
  const body = (
    <Row style={{ justifyContent: 'space-between' }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text weight="600">{title}</Text>
        {subtitle ? <Text size={13} muted>{subtitle}</Text> : null}
      </View>
      {right}
    </Row>
  );
  const line = { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.border };
  // A row without an action is plain content, so buttons inside it stay usable.
  if (!onPress) return <View testID={testID} style={line}>{body}</View>;
  return (
    <Pressable testID={testID} accessibilityRole="link" onPress={onPress} style={({ pressed }) => ({ ...line, opacity: pressed ? 0.7 : 1 })}>
      {body}
    </Pressable>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <Text muted style={{ textAlign: 'center', paddingVertical: 12 }}>
      {children}
    </Text>
  );
}

export function Loading() {
  return <ActivityIndicator style={{ marginVertical: 24 }} />;
}

export function errorText(e: unknown) {
  if (e instanceof ApiError) return e.message;
  return 'Something went wrong. Please try again.';
}

/**
 * Loads data from the API for a screen. Keeps the last good data when a reload fails (for example offline)
 * and reports the error alongside it.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}

export function DemoBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return <Notice tone="warn" testID="demo-banner">Demo workspace: the people, pay and requests here are sample data.</Notice>;
}

export const fmt = {
  date: (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
  time: (iso: string, timeZone?: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone }),
  dateTime: (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  money,
  month: (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
};

/** Reloads a screen's data when the person comes back to it (not on the first visit, which already loads). */
export function useReloadOnFocus(reload: () => unknown) {
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      void reload();
    }, [reload]),
  );
}

import { useFocusEffect } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  type TextInputProps,
  type TextStyle,
  useColorScheme,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ApiError } from '../lib/api';
import { money } from '../lib/format';

const light = {
  bg: '#f6f7f9',
  card: '#ffffff',
  fg: '#111827',
  muted: '#6b7280',
  border: '#e5e7eb',
  accent: '#1d4ed8',
  accentFg: '#ffffff',
  danger: '#b91c1c',
  dangerBg: '#fef2f2',
  warn: '#92400e',
  warnBg: '#fffbeb',
  ok: '#047857',
  okBg: '#ecfdf5',
  infoBg: '#eff6ff',
};
const dark: typeof light = {
  bg: '#0b0f17',
  card: '#151b26',
  fg: '#f3f4f6',
  muted: '#9ca3af',
  border: '#273041',
  accent: '#60a5fa',
  accentFg: '#0b0f17',
  danger: '#fca5a5',
  dangerBg: '#2a1215',
  warn: '#fcd34d',
  warnBg: '#2a2110',
  ok: '#6ee7b7',
  okBg: '#0f2a22',
  infoBg: '#111d33',
};

export type Theme = typeof light;
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export function Text({ children, muted, size = 15, weight, style, testID, numberOfLines }: { children: ReactNode; muted?: boolean; size?: number; weight?: TextStyle['fontWeight']; style?: TextStyle; testID?: string; numberOfLines?: number }) {
  const t = useTheme();
  return (
    <RNText testID={testID} numberOfLines={numberOfLines} style={[{ color: muted ? t.muted : t.fg, fontSize: size, fontWeight: weight, lineHeight: Math.round(size * 1.4) }, style]}>
      {children}
    </RNText>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text size={22} weight="700" style={{ marginBottom: 4 }}>
      {children}
    </Text>
  );
}

/** Scrollable screen with pull-to-refresh. */
export function Screen({ children, onRefresh, refreshing = false }: { children: ReactNode; onRefresh?: () => void; refreshing?: boolean }) {
  const t = useTheme();
  return (
    <SafeAreaView edges={['left', 'right']} style={{ flex: 1, backgroundColor: t.bg }}>
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
    <View testID={testID} style={[{ backgroundColor: t.card, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.border, padding: 14, gap: 8 }, style]}>
      {children}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]}>{children}</View>;
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
      style={({ pressed }) => ({
        backgroundColor: bg,
        borderColor: kind === 'secondary' ? t.border : bg,
        borderWidth: 1,
        borderRadius: 10,
        paddingVertical: 12,
        paddingHorizontal: 16,
        alignItems: 'center',
        opacity: off ? 0.5 : pressed ? 0.8 : 1,
      })}
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
          { borderWidth: 1, borderColor: error ? t.danger : t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: t.fg, backgroundColor: t.card },
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
              onPress={() => onChange(o.value)}
              style={{ borderWidth: 1, borderColor: on ? t.accent : t.border, backgroundColor: on ? t.infoBg : t.card, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <RNText style={{ color: on ? t.accent : t.fg, fontSize: 14, fontWeight: on ? '600' : '400' }}>{o.label}</RNText>
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

import { WELCOME_COPY, WORKSPACE_WELCOME_CHOICES, type WelcomeScene } from '@crew/contracts';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Platform, Pressable, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { gradient } from './index';

/**
 * Each level's world, the same as the Web Portal and Console sign-in: the Super Admin Console is a night-blue command
 * centre, the Super Workspace emerald and gold, the HR Workspace violet and coral, the Employee Workspace warm daylight
 * (and the team welcome a fresher daylight).
 */
interface World { bg: string; base: string; ink: string; ink2: string; name: [string, string]; glowA: string; glowB: string; light: boolean; chip: string; accent: string }
export const WORLDS: Record<WelcomeScene, World> = {
  console: { bg: 'radial-gradient(circle at 85% 0%, #0f2a5c, #050a16 60%, #02040b)', base: '#050a16', ink: '#ffffff', ink2: 'rgba(224,242,254,0.78)', name: ['#67e8f9', '#3b82f6'], glowA: '#1d4ed8', glowB: '#06b6d4', light: false, chip: 'rgba(255,255,255,0.1)', accent: '#2563eb' },
  super: { bg: 'radial-gradient(circle at 15% 0%, #14532d, #0c2620 50%, #04110d)', base: '#0c2620', ink: '#ffffff', ink2: 'rgba(254,243,199,0.8)', name: ['#fde68a', '#e3b341'], glowA: '#059669', glowB: '#e3b341', light: false, chip: 'rgba(227,179,65,0.16)', accent: '#047857' },
  hr: { bg: 'linear-gradient(140deg, #2e1065, #5b21b6 42%, #a21caf 72%, #e8697a)', base: '#5b21b6', ink: '#ffffff', ink2: 'rgba(255,255,255,0.85)', name: ['#ffffff', '#fdba74'], glowA: '#fb8a7e', glowB: '#a78bfa', light: false, chip: 'rgba(255,255,255,0.16)', accent: '#7c3aed' },
  employee: { bg: 'linear-gradient(160deg, #fff7ed, #fdf2f8 45%, #eef2ff)', base: '#fff7ed', ink: '#1e1b4b', ink2: '#475569', name: ['#4f46e5', '#f97316'], glowA: '#fdba74', glowB: '#a5b4fc', light: true, chip: 'rgba(255,255,255,0.8)', accent: '#4f46e5' },
  team: { bg: 'linear-gradient(160deg, #ecfdf5, #eef2ff 55%, #fff7ed)', base: '#ecfdf5', ink: '#1e1b4b', ink2: '#475569', name: ['#059669', '#4f46e5'], glowA: '#6ee7b7', glowB: '#a5b4fc', light: true, chip: 'rgba(255,255,255,0.8)', accent: '#4f46e5' },
};
/** The colour dot beside each level on the level chips. */
const CHOICE_DOT: Record<string, string> = { super: '#e3b341', hr: '#fb8a7e', employee: '#4f46e5' };
const LOGO_DARK = require('../../assets/logo-dark.png');
const LOGO_LIGHT = require('../../assets/logo-light.png');

/** Whether the person asked their phone for less motion (then everything shows still, at its final place). */
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setReduced(v)).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduced;
}

/** A value that swings 0 to 1 and back for as long as the screen is open (native driver: smooth on low-end phones). */
function useSwing(ms: number, run: boolean, delay = 0) {
  const v = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (!run) {
      v.setValue(0.5);
      return;
    }
    v.setValue(0);
    const a = Animated.loop(Animated.sequence([Animated.delay(delay), Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true }), Animated.timing(v, { toValue: 0, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true })]));
    a.start();
    return () => a.stop();
  }, [v, ms, run, delay]);
  return v;
}

/** A value that runs 0 to 1 again and again (turning, travelling). */
function useCycle(ms: number, run: boolean, delay = 0) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!run) {
      v.setValue(0);
      return;
    }
    const a = Animated.loop(Animated.sequence([Animated.delay(delay), Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.linear, useNativeDriver: true })]));
    a.start();
    return () => a.stop();
  }, [v, ms, run, delay]);
  return v;
}

/**
 * The animated welcome at the top of the phone sign-in: the level's own world, the official logo, and the workspace's
 * name written large so nobody signs in to the wrong place. It sizes itself to the screen and orientation, stands still
 * when the phone asks for reduced motion, and never blocks the form below (no waiting, no touch capture except the
 * level chips).
 */
export function WelcomeHero({ scene, onChoose }: { scene: WelcomeScene; onChoose?: (s: WelcomeScene) => void }) {
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const heroH = Math.round(Math.min(landscape ? height * 0.7 : height * 0.44, 390));
  const reduced = useReducedMotion();
  const w = WORLDS[scene];
  const copy = WELCOME_COPY[scene];
  const reveal = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const name = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const words = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      for (const v of [reveal, name, words]) v.setValue(1);
      return;
    }
    for (const v of [reveal, name, words]) v.setValue(0);
    Animated.parallel([
      Animated.timing(reveal, { toValue: 1, duration: 800, easing: Easing.out(Easing.exp), useNativeDriver: true }),
      Animated.timing(name, { toValue: 1, duration: 900, delay: 150, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true }),
      Animated.timing(words, { toValue: 1, duration: 700, delay: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [scene, reduced, reveal, name, words]);
  const logoW = Math.min(width - 120, 190);
  const nameSize = landscape ? 30 : Math.min(40, Math.max(28, width / 10.5));
  return (
    <View testID="welcome-hero" style={[{ height: heroH, overflow: 'hidden', borderRadius: 24, marginHorizontal: -4 }, gradient(w.bg, w.base)]} accessibilityLabel={`${copy.level} welcome`}>
      <Glow color={w.glowA} size={heroH * 1.1} style={{ left: -heroH * 0.35, top: -heroH * 0.5 }} run={!reduced} light={w.light} />
      <Glow color={w.glowB} size={heroH} style={{ right: -heroH * 0.45, bottom: -heroH * 0.55 }} run={!reduced} light={w.light} delay={1500} />
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', inset: 0 } as ViewStyle}>
        <Stage scene={scene} w={width} h={heroH} run={!reduced} />
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: BAND, gap: 5 }}>
        <Animated.View
          accessible
          accessibilityRole="image"
          accessibilityLabel="SampCrew. People, simplified. By SAMPLEDGE"
          testID="brand"
          style={{ opacity: reveal, transform: [{ translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] }}
        >
          {/* The artwork is 1458 x 384: its proportions are kept. */}
          <Image source={w.light ? LOGO_LIGHT : LOGO_DARK} style={{ width: logoW, height: Math.round((logoW * 384) / 1458) }} resizeMode="contain" />
        </Animated.View>
        <Text style={{ color: w.ink2, fontSize: 10.5, fontWeight: '700', letterSpacing: 1.6, textTransform: 'uppercase', marginTop: 4 }}>You are signing in to</Text>
        <Animated.View style={{ opacity: name, transform: [{ translateY: name.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }, { scale: name.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }}>
          <Text
            testID="welcome-level"
            accessibilityRole="header"
            style={[{ fontSize: nameSize, lineHeight: nameSize * 1.08, fontWeight: '900', letterSpacing: -1, textAlign: 'center', color: w.name[0], fontFamily: scene === 'console' ? 'monospace' : undefined }, gradientText(w.name)]}
          >
            {copy.level}
          </Text>
        </Animated.View>
        <Animated.View style={{ alignItems: 'center', opacity: words, transform: [{ translateY: words.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
          <View style={{ width: 56, height: 4, borderRadius: 2, marginBottom: 6, ...gradient(`linear-gradient(90deg, ${w.name[0]}, ${w.name[1]})`, w.name[1]) }} />
          <Text testID="welcome-title" style={{ color: w.ink, fontSize: landscape ? 15 : 16, fontWeight: '800', textAlign: 'center', letterSpacing: -0.2 }}>{copy.title}</Text>
        </Animated.View>
        {onChoose && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 4 }} accessibilityRole="tablist" accessibilityLabel="Choose where you are signing in">
            {WORKSPACE_WELCOME_CHOICES.map((c) => {
              const active = c.scene === scene || (c.scene === 'employee' && scene === 'team');
              return (
                <Pressable key={c.scene} testID={`welcome-choice-${c.scene}`} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={() => onChoose(c.scene)} hitSlop={6}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: active ? w.ink : 'transparent', backgroundColor: active ? w.ink : w.chip }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: CHOICE_DOT[c.scene] }} />
                  <Text style={{ color: active ? (w.light ? '#fff' : '#0b1020') : w.ink, fontSize: 12, fontWeight: '700' }}>{c.label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}

/** Gradient-filled text where the platform can draw it (the web build); a solid colour elsewhere. */
function gradientText([a, b]: [string, string]) {
  if (Platform.OS !== 'web') return null;
  return { backgroundImage: `linear-gradient(90deg, ${a}, ${b})`, backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' } as never;
}

function Glow({ color, size, style, run, light, delay = 0 }: { color: string; size: number; style: ViewStyle; run: boolean; light: boolean; delay?: number }) {
  const v = useSwing(9000, run, delay);
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: light ? 0.28 : 0.35 }, style, {
      transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, size * 0.08] }) }, { scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }],
    }]} />
  );
}

/** The strip at the bottom of the hero where each level's scene moves, clear of the words above it. */
const BAND = 54;

const abs = (s: ViewStyle): ViewStyle => ({ position: 'absolute', ...s });

/** Each level's moving scene, kept light: a handful of views animated on the native thread. */
function Stage({ scene, w, h, run }: { scene: WelcomeScene; w: number; h: number; run: boolean }) {
  const turn = useCycle(14000, run);
  const fast = useCycle(5000, run);
  const swing = useSwing(2600, run);
  const swing2 = useSwing(3400, run, 700);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const rotateFast = fast.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  if (scene === 'console') {
    const R = Math.min(h * 0.22, 80);
    const cx = w - R * 0.7;
    const cy = h - R * 0.55;
    return (
      <>
        {Array.from({ length: Math.ceil(w / 36) }, (_, i) => <View key={`v${i}`} style={abs({ left: i * 36, top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(34,211,238,0.07)' })} />)}
        {Array.from({ length: Math.ceil(h / 36) }, (_, i) => <View key={`h${i}`} style={abs({ top: i * 36, left: 0, right: 0, height: 1, backgroundColor: 'rgba(34,211,238,0.07)' })} />)}
        <View style={abs({ left: cx - R, top: cy - R, width: R * 2, height: R * 2, borderRadius: R, borderWidth: 1.5, borderColor: 'rgba(56,189,248,0.6)', backgroundColor: 'rgba(29,78,216,0.18)' })} />
        {[0, 1, 2].map((i) => (
          <Animated.View key={i} style={abs({ left: cx - R, top: cy - R, width: R * 2, height: R * 2, borderRadius: R, borderWidth: 1, borderColor: 'rgba(34,211,238,0.45)', transform: [{ scaleX: (i === 1 ? swing2 : swing).interpolate({ inputRange: [0, 1], outputRange: i === 2 ? [0.3, 0.9] : [0.05, 0.75] }) }] })} />
        ))}
        <View style={abs({ left: cx - R, top: cy - R * 0.16, width: R * 2, height: R * 0.32, borderRadius: R, borderWidth: 1, borderColor: 'rgba(34,211,238,0.3)' })} />
        <View style={abs({ left: cx - R * 1.5, top: cy - R * 1.5, width: R * 3, height: R * 3, transform: [{ scaleY: 0.3 }, { rotate: '-14deg' }] })}>
          <Animated.View style={abs({ left: 0, top: 0, width: R * 3, height: R * 3, borderRadius: R * 1.5, borderWidth: 1, borderColor: 'rgba(96,165,250,0.45)', borderStyle: 'dashed', transform: [{ rotate: rotateFast }] })}>
            <View style={abs({ left: R * 3 - 8, top: R * 1.5 - 8, width: 16, height: 16, borderRadius: 8, backgroundColor: '#60a5fa' })} />
          </Animated.View>
        </View>
        {[[0.06, 0.92], [0.22, 0.9], [0.4, 0.94]].map(([x, y], i) => (
          <Animated.View key={i} style={abs({ left: x! * w, top: y! * h - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: '#34d399', opacity: (i % 2 ? swing : swing2).interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) })} />
        ))}
      </>
    );
  }
  if (scene === 'super') {
    const R = Math.min(h * 0.2, 72);
    const cx = w - R * 0.9;
    const cy = h - R * 0.45;
    const stars: [number, number][] = [[0.06, 0.12], [0.2, 0.86], [0.32, 0.1], [0.5, 0.94], [0.66, 0.08], [0.9, 0.18], [0.12, 0.5], [0.72, 0.5], [0.42, 0.66], [0.96, 0.92]];
    return (
      <>
        {stars.map(([x, y], i) => <Animated.View key={i} style={abs({ left: x * w, top: y * h, width: 3, height: 3, borderRadius: 2, backgroundColor: '#fef3c7', opacity: (i % 2 ? swing : swing2).interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }) })} />)}
        {[0, 1].map((i) => (
          <View key={i} style={abs({ left: cx - R * (1.2 + i * 0.4), top: cy - R * (1.2 + i * 0.4), width: R * (2.4 + i * 0.8), height: R * (2.4 + i * 0.8), transform: [{ scaleY: 0.34 }, { rotate: i ? '12deg' : '-10deg' }] })}>
            <Animated.View style={abs({ left: 0, top: 0, right: 0, bottom: 0, borderRadius: R * 2, borderWidth: 1, borderColor: 'rgba(227,179,65,0.5)', transform: [{ rotate: i ? rotate : rotateFast }] })}>
              <View style={abs({ right: -9, top: R * (1.2 + i * 0.4) - 9, width: 18, height: 18, borderRadius: 9, backgroundColor: i ? '#34d399' : '#fde68a' })} />
            </Animated.View>
          </View>
        ))}
        <Animated.View style={abs({ left: cx - R * 0.42, top: cy - R * 0.42, width: R * 0.84, height: R * 0.84, borderRadius: R, borderWidth: 2, borderColor: 'rgba(227,179,65,0.7)', opacity: fast.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }), transform: [{ scale: fast.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) }] })} />
        <View style={abs({ left: cx - R * 0.42, top: cy - R * 0.42, width: R * 0.84, height: R * 0.84, borderRadius: R, alignItems: 'center', justifyContent: 'center', ...gradient('radial-gradient(circle at 40% 35%, #fde68a, #e3b341 55%, #a16207)', '#e3b341') })}>
          <Text style={{ fontSize: R * 0.36, color: '#0c2620', fontWeight: '900' }}>♛</Text>
        </View>
      </>
    );
  }
  if (scene === 'hr') {
    const colW = Math.min(96, w * 0.26);
    const top = h - BAND + 8;
    const x0 = w / 2 - colW * 1.5 - 8;
    const travel = fast.interpolate({ inputRange: [0, 0.15, 0.35, 0.5, 0.7, 0.95, 1], outputRange: [0, 0, colW + 8, colW + 8, 2 * (colW + 8), 2 * (colW + 8), 0] });
    const lift = fast.interpolate({ inputRange: [0, 0.15, 0.25, 0.35, 0.5, 0.6, 0.7, 1], outputRange: [0, 0, -10, 0, 0, -10, 0, 0] });
    const hired = fast.interpolate({ inputRange: [0, 0.7, 0.76, 0.95, 1], outputRange: [0, 0, 1, 1, 0] });
    return (
      <>
        {[0, 1, 2].map((i) => (
          <View key={i} style={abs({ left: x0 + i * (colW + 8), top, width: colW, height: h, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' })} />
        ))}
        <Animated.View style={abs({ left: x0 + 6, top: top + 10, width: colW - 12, height: 30, borderRadius: 10, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, transform: [{ translateX: travel }, { translateY: lift }] })}>
          <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: '#fb8a7e' }} />
          <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: '#2e1065', opacity: 0.7 }} />
          <Animated.View style={abs({ right: -6, top: -8, width: 18, height: 18, borderRadius: 9, backgroundColor: '#10b981', alignItems: 'center', justifyContent: 'center', transform: [{ scale: hired }] })}>
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '900' }}>✓</Text>
          </Animated.View>
        </Animated.View>
        {[[0.1, 0.2], [0.88, 0.16], [0.06, 0.6], [0.94, 0.55]].map(([x, y], i) => (
          <Animated.View key={i} style={abs({ left: x! * w, top: y! * h, width: 10, height: 10, borderRadius: 3, backgroundColor: ['#fbbf24', '#fb8a7e', '#a78bfa', '#34d399'][i], opacity: 0.8, transform: [{ rotate }, { translateY: (i % 2 ? swing : swing2).interpolate({ inputRange: [0, 1], outputRange: [-6, 6] }) }] })} />
        ))}
      </>
    );
  }
  // Employee Workspace and team: daylight, a turning sun, a drifting cloud, and a friendly tick or the team.
  const sun = Math.min(h * 0.12, 40);
  return (
    <>
      <Animated.View style={abs({ right: 8, top: 8, width: sun * 1.6, height: sun * 1.6, alignItems: 'center', justifyContent: 'center', transform: [{ rotate }] })}>
        {Array.from({ length: 8 }, (_, i) => <View key={i} style={abs({ width: 4, height: sun * 1.6, borderRadius: 2, backgroundColor: 'rgba(251,146,60,0.35)', transform: [{ rotate: `${i * 22.5}deg` }] })} />)}
      </Animated.View>
      <View style={abs({ right: 8 + sun * 0.3, top: 8 + sun * 0.3, width: sun, height: sun, borderRadius: sun / 2, ...gradient('radial-gradient(circle, #fde68a, #fb923c 60%, #f97316)', '#fb923c') })} />
      <Animated.View style={abs({ left: 10, top: 14, width: 46, height: 18, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.95)', transform: [{ translateX: swing2.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }) }] })} />
      <Animated.View style={abs({ right: w * 0.3, bottom: 18, width: 40, height: 14, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.9)', transform: [{ translateX: swing.interpolate({ inputRange: [0, 1], outputRange: [0, -24] }) }] })} />
      {scene === 'team'
        ? [0, 1, 2, 3].map((i) => (
            <Animated.View key={i} style={abs({ left: 14 + i * 22, bottom: 14, width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: '#fff', backgroundColor: ['#6366f1', '#fb923c', '#34d399', '#f472b6'][i], transform: [{ translateY: (i % 2 ? swing : swing2).interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] })} />
          ))
        : (
            <Animated.View style={abs({ left: 14, bottom: 14, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#fff', transform: [{ translateY: swing.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) }] })}>
              <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#10b981', alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 11, fontWeight: '900' }}>✓</Text></View>
              <Text style={{ color: '#1e1b4b', fontSize: 11, fontWeight: '800' }}>Checked in</Text>
            </Animated.View>
          )}
    </>
  );
}

/**
 * The welcome that plays right after signing in (not when the app opens with a saved session): the level's world, a
 * time greeting, the person's first name in big letters, the workspace in bold, pulsing rings and a progress line, then
 * it fades and grows away to show Home, which loads underneath. A tap skips it; with reduced motion it is a short card.
 */
export function WelcomeIntro({ scene, name, workspace, onDone }: { scene: WelcomeScene; name: string; workspace?: string | null; onDone: () => void }) {
  const w = WORLDS[scene];
  const reduced = useReducedMotion();
  const { width } = useWindowDimensions();
  const show = useRef(new Animated.Value(0)).current;
  const out = useRef(new Animated.Value(0)).current;
  const bar = useRef(new Animated.Value(0)).current;
  const rings = useCycle(2400, !reduced);
  const native = Platform.OS !== 'web';
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    Animated.timing(out, { toValue: 1, duration: reduced ? 200 : 520, easing: Easing.in(Easing.cubic), useNativeDriver: native }).start(() => onDone());
  };
  useEffect(() => {
    Animated.timing(show, { toValue: 1, duration: reduced ? 1 : 900, easing: Easing.out(Easing.back(1.4)), useNativeDriver: native }).start();
    Animated.timing(bar, { toValue: 1, duration: reduced ? 600 : 2400, easing: Easing.inOut(Easing.cubic), useNativeDriver: false }).start();
    const t = setTimeout(finish, reduced ? 900 : 2900);
    return () => clearTimeout(t);
  }, []);
  const first = name.trim().split(/\s+/)[0] || name;
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const ring = (i: number) => {
    const size = Math.min(width * 1.1, 520);
    const phase = Animated.modulo(Animated.add(rings, i / 3), 1);
    return (
      <Animated.View key={i} pointerEvents="none" style={{ position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: w.name[1], opacity: phase.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }), transform: [{ scale: phase.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1.3] }) }] }} />
    );
  };
  const rise = (from: number) => ({ opacity: show, transform: [{ translateY: show.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) }] });
  return (
    <Animated.View
      testID="welcome-intro"
      accessibilityRole="alert"
      accessibilityLabel={`${hello}, ${first}. Welcome to your ${WELCOME_COPY[scene].level}`}
      style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1000, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, gradient(w.bg, w.base), {
        opacity: out.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [{ scale: out.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }],
      }]}
    >
      <Pressable accessibilityRole="button" accessibilityLabel="Skip the welcome" onPress={finish} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      <Glow color={w.glowA} size={340} style={{ top: -80, left: -120 }} run={!reduced} light={w.light} />
      <Glow color={w.glowB} size={300} style={{ bottom: -90, right: -110 }} run={!reduced} light={w.light} delay={1200} />
      {!reduced && [0, 1, 2].map(ring)}
      <View pointerEvents="none" style={{ alignItems: 'center', paddingHorizontal: 28, gap: 8 }}>
        <Animated.Image source={w.light ? LOGO_LIGHT : LOGO_DARK} style={[{ width: 150, height: 40, marginBottom: 10 }, rise(10)]} resizeMode="contain" />
        <Animated.Text style={[{ color: w.ink2, fontSize: 16, fontWeight: '600' }, rise(14)]}>{hello}</Animated.Text>
        <Animated.Text testID="welcome-intro-name" numberOfLines={1} adjustsFontSizeToFit style={[{ color: w.name[0], fontSize: 64, fontWeight: '900', letterSpacing: -2, textAlign: 'center' }, gradientText(w.name), {
          opacity: show, transform: [{ scale: show.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
        }]}>{first}</Animated.Text>
        <Animated.Text style={[{ color: w.ink2, fontSize: 17, textAlign: 'center' }, rise(18)]}>
          Welcome to your <Text style={{ color: w.ink, fontWeight: '800' }}>{WELCOME_COPY[scene].level}</Text>
          {workspace ? <>{' at '}<Text style={{ color: w.ink, fontWeight: '800' }}>{workspace}</Text></> : null}
        </Animated.Text>
        <View style={{ width: 200, height: 5, borderRadius: 3, overflow: 'hidden', backgroundColor: w.light ? 'rgba(30,27,75,0.12)' : 'rgba(255,255,255,0.16)', marginTop: 22 }}>
          <Animated.View style={[{ height: 5, borderRadius: 3 }, gradient(`linear-gradient(90deg, ${w.name[0]}, ${w.name[1]})`, w.name[1]), { width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
        </View>
        <Text style={{ color: w.ink2, fontSize: 13, marginTop: 4 }}>Preparing your Home…</Text>
      </View>
    </Animated.View>
  );
}

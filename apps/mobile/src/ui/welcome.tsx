import { WELCOME_COPY, WORKSPACE_WELCOME_CHOICES, type WelcomeScene } from '@crew/contracts';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Image, Pressable, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { gradient } from './index';

/** SampCrew colours from the official mark and wordmark. */
const C = { rose: '#FB7185', pink: '#F472B6', violet: '#8B5CF6', indigo: '#7B4DFF', blue: '#2F6BFF', cyan: '#0BC5FF' };
/** Each level's base and glow colours (the same palette as the Web Portal and Console welcome). */
const SCENE: Record<WelcomeScene, { base: string; a: string; b: string }> = {
  console: { base: '#070b1f', a: C.indigo, b: C.cyan },
  super: { base: '#0d0b2b', a: C.pink, b: C.violet },
  hr: { base: '#0a0e2c', a: C.rose, b: C.blue },
  team: { base: '#100b2e', a: C.violet, b: C.rose },
  employee: { base: '#160d2e', a: C.rose, b: C.pink },
};
const LOGO = require('../../assets/logo-dark.png');

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

/** A value that loops 0 to 1 for as long as the screen is open (native driver: smooth on low-end phones too). */
function useLoop(ms: number, run: boolean, delay = 0) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!run) {
      v.setValue(0.5);
      return;
    }
    const a = Animated.loop(Animated.sequence([Animated.delay(delay), Animated.timing(v, { toValue: 1, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true }), Animated.timing(v, { toValue: 0, duration: ms, easing: Easing.inOut(Easing.sin), useNativeDriver: true })]));
    a.start();
    return () => a.stop();
  }, [v, ms, run, delay]);
  return v;
}

/**
 * The animated SampCrew welcome at the top of the phone sign-in: the official logo rises onto a tilted glass card,
 * the level's own motion moves behind it, and the welcome words fade in. It sizes itself to the screen and orientation,
 * stands still when the phone asks for reduced motion, and never blocks the form below (no waiting, no touch capture
 * except the level chips).
 */
export function WelcomeHero({ scene, onChoose }: { scene: WelcomeScene; onChoose?: (s: WelcomeScene) => void }) {
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const heroH = Math.round(Math.min(landscape ? height * 0.62 : height * 0.4, 360));
  const reduced = useReducedMotion();
  const pal = SCENE[scene];
  const copy = WELCOME_COPY[scene];
  const reveal = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const words = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      reveal.setValue(1);
      words.setValue(1);
      return;
    }
    reveal.setValue(0);
    words.setValue(0);
    Animated.parallel([
      Animated.timing(reveal, { toValue: 1, duration: 1100, easing: Easing.out(Easing.exp), useNativeDriver: true }),
      Animated.timing(words, { toValue: 1, duration: 700, delay: 350, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [scene, reduced, reveal, words]);
  const float = useLoop(4500, !reduced);
  const logoW = Math.min(width - 96, 260);
  return (
    <View testID="welcome-hero" style={[{ height: heroH, overflow: 'hidden', borderRadius: 24, marginHorizontal: -4 }, gradient(`radial-gradient(circle at 20% 0%, ${pal.a}55, ${pal.base} 60%)`, pal.base)]} accessibilityLabel={`${copy.level} welcome`}>
      <Glow color={pal.a} size={heroH * 1.1} style={{ left: -heroH * 0.35, top: -heroH * 0.45 }} run={!reduced} />
      <Glow color={pal.b} size={heroH} style={{ right: -heroH * 0.4, bottom: -heroH * 0.5 }} run={!reduced} delay={1500} />
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ position: 'absolute', inset: 0 } as ViewStyle}>
        <Motif scene={scene} w={width} h={heroH} run={!reduced} />
      </View>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, gap: 10 }}>
        <Animated.View
          accessible
          accessibilityRole="image"
          accessibilityLabel="SampCrew. People, simplified. By SAMPLEDGE"
          testID="brand"
          style={{
            opacity: reveal,
            transform: [
              { perspective: 800 },
              { translateY: Animated.add(reveal.interpolate({ inputRange: [0, 1], outputRange: [26, 0] }), float.interpolate({ inputRange: [0, 1], outputRange: [0, -4] })) },
              { rotateX: reveal.interpolate({ inputRange: [0, 1], outputRange: ['28deg', '0deg'] }) },
              { rotateY: float.interpolate({ inputRange: [0, 1], outputRange: ['-3deg', '3deg'] }) },
              { scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) },
            ],
            borderRadius: 20, paddingHorizontal: 18, paddingVertical: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', backgroundColor: 'rgba(255,255,255,0.09)',
            boxShadow: '0 18px 40px -16px rgba(0,0,0,0.6)',
          } as never}
        >
          {/* The artwork is 1458 x 384: its proportions are kept. */}
          <Image source={LOGO} style={{ width: logoW, height: Math.round((logoW * 384) / 1458) }} resizeMode="contain" />
        </Animated.View>
        <Animated.View style={{ alignItems: 'center', opacity: words, transform: [{ translateY: words.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
          <Text testID="welcome-level" style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' }}>{copy.level}</Text>
          <Text testID="welcome-title" accessibilityRole="header" style={{ color: '#fff', fontSize: landscape ? 18 : 21, fontWeight: '800', textAlign: 'center', marginTop: 4, letterSpacing: -0.3 }}>{copy.title}</Text>
          {!landscape && heroH > 300 && <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 13, textAlign: 'center', marginTop: 4, maxWidth: 320 }}>{copy.message}</Text>}
        </Animated.View>
        {onChoose && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }} accessibilityRole="tablist" accessibilityLabel="Choose where you are signing in">
            {WORKSPACE_WELCOME_CHOICES.map((c) => {
              const active = c.scene === scene || (c.scene === 'employee' && scene === 'team');
              return (
                <Pressable key={c.scene} testID={`welcome-choice-${c.scene}`} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={() => onChoose(c.scene)} hitSlop={6}
                  style={{ borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: active ? 'rgba(255,255,255,0.4)' : 'transparent', backgroundColor: active ? 'rgba(255,255,255,0.16)' : 'transparent' }}>
                  <Text style={{ color: active ? '#fff' : 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: active ? '700' : '500' }}>{c.label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}

function Glow({ color, size, style, run, delay = 0 }: { color: string; size: number; style: ViewStyle; run: boolean; delay?: number }) {
  const v = useLoop(9000, run, delay);
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: 0.32 }, style, {
      transform: [{ translateX: v.interpolate({ inputRange: [0, 1], outputRange: [0, size * 0.08] }) }, { scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }],
    }]} />
  );
}

/** Each level's moving shapes, kept light: a handful of views animated on the native thread. */
function Motif({ scene, w, h, run }: { scene: WelcomeScene; w: number; h: number; run: boolean }) {
  const a = useLoop(3200, run);
  const b = useLoop(4100, run, 600);
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!run) return;
    const l = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 24000, easing: Easing.linear, useNativeDriver: true }));
    l.start();
    return () => l.stop();
  }, [run, spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const dot = (key: string, x: number, y: number, r: number, color: string, extra?: object) => (
    <Animated.View key={key} style={[{ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: r, backgroundColor: color, opacity: 0.6 }, extra]} />
  );
  if (scene === 'console' || scene === 'team') {
    const R = Math.min(w, h) * 0.42;
    return (
      <Animated.View style={{ position: 'absolute', left: w / 2 - R, top: h / 2 - R, width: R * 2, height: R * 2, transform: [{ rotate }] }}>
        <View style={{ position: 'absolute', inset: 0, borderRadius: R, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderStyle: 'dashed' } as ViewStyle} />
        <View style={{ position: 'absolute', inset: R * 0.3, borderRadius: R, borderWidth: 1, borderColor: 'rgba(11,197,255,0.25)' } as ViewStyle} />
        {scene === 'console'
          ? [dot('a', R * 2, R, 5, C.rose), dot('b', R * 0.3, R * 0.4, 4, C.cyan), dot('c', R, R * 1.7, 3, C.violet)]
          : [0, 1, 2].map((i) => {
              const ang = (i * 2 * Math.PI) / 3;
              const cx = R + Math.cos(ang) * R * 0.75;
              const cy = R + Math.sin(ang) * R * 0.75;
              return <View key={i}>{dot('a', cx, cy - 7, 10, C.rose)}{dot('b', cx - 8, cy + 6, 10, C.pink)}{dot('c', cx + 8, cy + 6, 10, C.violet)}</View>;
            })}
      </Animated.View>
    );
  }
  if (scene === 'hr') {
    return (
      <View style={{ position: 'absolute', left: 16, bottom: 0, flexDirection: 'row', alignItems: 'flex-end', gap: 10, height: h * 0.55 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Animated.View key={i} style={{ width: 16, height: h * 0.55, borderTopLeftRadius: 8, borderTopRightRadius: 8, backgroundColor: i % 2 ? C.violet : C.blue, opacity: 0.4, transformOrigin: 'bottom', transform: [{ scaleY: (i % 2 ? b : a).interpolate({ inputRange: [0, 1], outputRange: [0.35 + i * 0.06, 0.9] }) }] } as never} />
        ))}
      </View>
    );
  }
  if (scene === 'super') {
    const pts: [number, number][] = [[0.5, 0.18], [0.2, 0.5], [0.8, 0.5], [0.1, 0.85], [0.4, 0.86], [0.62, 0.86], [0.92, 0.84]];
    return (
      <>
        {pts.map(([x, y], i) => dot(String(i), x * w, y * h, i === 0 ? 9 : 6, i === 0 ? C.rose : i < 3 ? C.pink : C.indigo, { transform: [{ scale: (i % 2 ? a : b).interpolate({ inputRange: [0, 1], outputRange: [0.8, 1.2] }) }] }))}
      </>
    );
  }
  // employee: bubbles drifting up
  return (
    <>
      {[[0.12, 22, a], [0.35, 14, b], [0.62, 26, a], [0.85, 16, b]].map(([x, r, v], i) => dot(String(i), (x as number) * w, h * 0.8, r as number, [C.rose, C.pink, C.violet, C.rose][i]!, {
        transform: [{ translateY: (v as Animated.Value).interpolate({ inputRange: [0, 1], outputRange: [0, -h * 0.55] }) }], opacity: 0.35,
      }))}
    </>
  );
}

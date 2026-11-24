import { SIGN_IN_MODES, SIGN_IN_PALETTES, sceneIsDark, type SignInMode, type WelcomeScene } from '@crew/contracts';

/**
 * The phone sign-in's look: each level's own world (the same as the Web Portal and Console), which people can switch to
 * light or dark and recolour with one of the sign-in palettes. The choice is kept on the phone under the same key the
 * web pages use in the browser.
 */
export interface World { bg: string; base: string; ink: string; ink2: string; name: [string, string]; glowA: string; glowB: string; light: boolean; chip: string; accent: string }

export const WORLDS: Record<WelcomeScene, World> = {
  console: { bg: 'radial-gradient(circle at 85% 0%, #0f2a5c, #050a16 60%, #02040b)', base: '#050a16', ink: '#ffffff', ink2: 'rgba(224,242,254,0.78)', name: ['#67e8f9', '#3b82f6'], glowA: '#1d4ed8', glowB: '#06b6d4', light: false, chip: 'rgba(255,255,255,0.1)', accent: '#2563eb' },
  super: { bg: 'radial-gradient(circle at 15% 0%, #14532d, #0c2620 50%, #04110d)', base: '#0c2620', ink: '#ffffff', ink2: 'rgba(254,243,199,0.8)', name: ['#fde68a', '#e3b341'], glowA: '#059669', glowB: '#e3b341', light: false, chip: 'rgba(227,179,65,0.16)', accent: '#047857' },
  hr: { bg: 'linear-gradient(140deg, #2e1065, #5b21b6 42%, #a21caf 72%, #e8697a)', base: '#5b21b6', ink: '#ffffff', ink2: 'rgba(255,255,255,0.85)', name: ['#ffffff', '#fdba74'], glowA: '#fb8a7e', glowB: '#a78bfa', light: false, chip: 'rgba(255,255,255,0.16)', accent: '#7c3aed' },
  employee: { bg: 'linear-gradient(160deg, #fff7ed, #fdf2f8 45%, #eef2ff)', base: '#fff7ed', ink: '#1e1b4b', ink2: '#475569', name: ['#4f46e5', '#f97316'], glowA: '#fdba74', glowB: '#a5b4fc', light: true, chip: 'rgba(255,255,255,0.8)', accent: '#4f46e5' },
  team: { bg: 'linear-gradient(160deg, #ecfdf5, #eef2ff 55%, #fff7ed)', base: '#ecfdf5', ink: '#1e1b4b', ink2: '#475569', name: ['#059669', '#4f46e5'], glowA: '#6ee7b7', glowB: '#a5b4fc', light: true, chip: 'rgba(255,255,255,0.8)', accent: '#4f46e5' },
};

/** Each world in the other tone, for when someone picks Light on a dark world or Dark on a daylight one. */
const FLIPPED: Record<WelcomeScene, Pick<World, 'bg' | 'base' | 'name' | 'glowA' | 'glowB'>> = {
  console: { bg: 'linear-gradient(160deg, #eff6ff, #ecfeff 55%, #f8fafc)', base: '#eff6ff', name: ['#0891b2', '#1d4ed8'], glowA: '#93c5fd', glowB: '#67e8f9' },
  super: { bg: 'linear-gradient(160deg, #ecfdf5, #fefce8 55%, #f0fdf4)', base: '#ecfdf5', name: ['#047857', '#b45309'], glowA: '#6ee7b7', glowB: '#fde68a' },
  hr: { bg: 'linear-gradient(160deg, #f5f3ff, #fdf4ff 50%, #fff1f2)', base: '#f5f3ff', name: ['#6d28d9', '#e11d48'], glowA: '#c4b5fd', glowB: '#fda4af' },
  employee: { bg: 'radial-gradient(circle at 20% 0%, #312e81, #120f2e 60%, #07061a)', base: '#120f2e', name: ['#a5b4fc', '#fdba74'], glowA: '#6d28d9', glowB: '#be185d' },
  team: { bg: 'radial-gradient(circle at 20% 0%, #064e3b, #0b1a2e 60%, #050a14)', base: '#0b1a2e', name: ['#6ee7b7', '#a5b4fc'], glowA: '#047857', glowB: '#4338ca' },
};

const INK = {
  dark: { ink: '#ffffff', ink2: 'rgba(255,255,255,0.8)', chip: 'rgba(255,255,255,0.12)' },
  light: { ink: '#1e1b4b', ink2: '#475569', chip: 'rgba(255,255,255,0.8)' },
};

/** A solid colour standing in for a gradient where the phone cannot draw one: the gradient's middle colour. */
function solidOf(css: string): string {
  const hexes = css.match(/#[0-9a-f]{6}/gi) ?? [];
  return hexes[Math.floor(hexes.length / 2)] ?? '#0b1020';
}

/** The world the hero draws for a level, a light/dark choice and a palette ("signature" keeps the level's colours). */
export function signInWorld(scene: WelcomeScene, mode: SignInMode = 'auto', palette = 'signature'): World {
  const own = WORLDS[scene];
  const tone: 'dark' | 'light' = mode === 'auto' ? (sceneIsDark(scene) ? 'dark' : 'light') : mode;
  const p = SIGN_IN_PALETTES.find((x) => x.key === palette);
  if (p) {
    const t = p[tone];
    return { ...INK[tone], bg: t.base, base: solidOf(t.base), name: [t.name[0], t.name[2]], glowA: p.colors[0], glowB: p.colors[2], light: tone === 'light', accent: p.tint };
  }
  if (own.light === (tone === 'light')) return own;
  return { ...own, ...INK[tone], ...FLIPPED[scene], light: tone === 'light' };
}

export const SIGN_IN_THEME_KEY = 'crew-signin-theme';

/** Reads the kept choice (the same JSON the web pages store), falling back to Auto and Signature. */
export function parseSignInTheme(raw: string | null | undefined): { mode: SignInMode; palette: string } {
  try {
    const v = JSON.parse(raw ?? '{}') as { mode?: unknown; palette?: unknown };
    const mode = (SIGN_IN_MODES as readonly unknown[]).includes(v.mode) ? (v.mode as SignInMode) : 'auto';
    const palette = typeof v.palette === 'string' && SIGN_IN_PALETTES.some((p) => p.key === v.palette) ? v.palette : 'signature';
    return { mode, palette };
  } catch {
    return { mode: 'auto', palette: 'signature' };
  }
}

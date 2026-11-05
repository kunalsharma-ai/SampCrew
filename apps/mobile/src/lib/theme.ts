import { type Appearance, buildTheme, DEFAULT_APPEARANCE, ensureContrast, mix, normaliseAppearance } from '@crew/contracts';

/** The colours the app's components use. */
export interface MobileTheme {
  mode: 'light' | 'dark';
  bg: string;
  card: string;
  fg: string;
  muted: string;
  border: string;
  accent: string;
  accentFg: string;
  danger: string;
  dangerBg: string;
  warn: string;
  warnBg: string;
  ok: string;
  okBg: string;
  infoBg: string;
  /**
   * The neon design (the default, as in the Web Portal): gradient buttons and tiles, glass cards, a night tab bar
   * and a background drawn from the theme's colours. Off for the Classic style, high contrast and focus mode.
   */
  neon: boolean;
  backdrop: Appearance['backdrop'];
  /** Cards in the neon style: the card colour, slightly see-through over the background art. */
  glass: string;
  /** Primary gradient: accent to a mix of accent and the secondary colour. accentFg reads at 4.5:1 on both stops. */
  gradient: [string, string];
  /** The theme's raw brand colours, used only for background glows (never behind text). */
  glow: [string, string, string];
  /** Corner radius of cards, from the member's corner setting. */
  radius: number;
}

/** Neon KPI tile colours: the same pairs as the Web Portal; white text reads at 4.5:1 or more on every stop. */
export const NEON_TILES = {
  violet: ['#6d28d9', '#a21caf'],
  teal: ['#0f766e', '#0e7490'],
  orange: ['#c2410c', '#b45309'],
  blue: ['#1d4ed8', '#0369a1'],
  pink: ['#be185d', '#9d174d'],
  green: ['#15803d', '#047857'],
} as const satisfies Record<string, readonly [string, string]>;
export type TileTone = keyof typeof NEON_TILES;

/** The night panel behind the tab bar in the neon style, in every mode (like the Web Portal's sidebar). */
export const NIGHT = { bg: '#140e33', fg: '#f6f3ff', muted: '#c9c1f2', border: 'rgba(255,255,255,0.12)' } as const;

/** Whether the neon look applies: the neon style, unless high contrast or focus mode asks for plain surfaces. */
export function neonOn(a: Pick<Appearance, 'style' | 'contrast' | 'focusMode'>): boolean {
  return a.style === 'neon' && a.contrast !== 'high' && !a.focusMode;
}

/** #rrggbb with an alpha, as an rgba() colour. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

/** Light or dark: "system" follows the phone's setting. */
export function resolveMode(a: Pick<Appearance, 'mode'>, scheme: string | null | undefined): 'light' | 'dark' {
  if (a.mode === 'light' || a.mode === 'dark') return a.mode;
  return scheme === 'dark' ? 'dark' : 'light';
}

/**
 * The app palette for a member's saved appearance. It is built by the same theme engine as the Web Portal (preset,
 * custom colours, high contrast), so a theme chosen on either one looks the same on both.
 */
export function mobileTheme(a: Appearance, scheme: string | null | undefined): MobileTheme {
  const mode = resolveMode(a, scheme);
  const t = buildTheme(a, mode);
  return {
    mode,
    bg: t.bg,
    card: t.surface,
    fg: t.fg,
    muted: t['fg-muted'],
    border: t.border,
    accent: t.accent,
    accentFg: t['accent-fg'],
    danger: t.danger,
    dangerBg: t['danger-subtle'],
    warn: t.warning,
    warnBg: t['warning-subtle'],
    ok: t.success,
    okBg: t['success-subtle'],
    infoBg: t['accent-subtle'],
    neon: neonOn(a),
    backdrop: a.backdrop,
    glass: neonOn(a) ? alpha(t.surface, 0.9) : t.surface,
    gradient: [t.accent, ensureContrast(mix(t.accent, t.ember, 0.45), t['accent-fg'], 4.5, t['accent-fg'] === '#ffffff' ? '#000000' : '#ffffff')],
    glow: [t['glow-1'], t['glow-2'], t['glow-3']],
    radius: a.radius === 'sharp' ? 8 : a.radius === 'round' ? 22 : 16,
  };
}

/** A cached appearance from storage, or the default when there is none or it no longer parses. */
export function cachedAppearance(raw: string | null): Appearance {
  if (!raw) return DEFAULT_APPEARANCE;
  try {
    return normaliseAppearance(JSON.parse(raw));
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

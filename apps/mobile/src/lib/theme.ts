import { type Appearance, buildTheme, DEFAULT_APPEARANCE, normaliseAppearance } from '@crew/contracts';

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

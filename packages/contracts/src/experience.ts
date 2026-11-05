import { z } from 'zod';

/**
 * CREW workspace experience: theme presets, per-member appearance preferences, favourites, recent pages and the
 * Home dashboard layout. The theme builder is shared by the Web Portal and the mobile app so both render the same
 * palette from the same saved preference, and every generated palette is checked for WCAG contrast in tests.
 */

// ---------------------------------------------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------------------------------------------

export const THEME_PRESET_KEYS = [
  'midnight', 'aurora', 'pearl', 'graphite', 'oceanic', 'emerald', 'amethyst', 'sunset', 'arctic', 'copper', 'rose', 'monochrome', 'cyber',
] as const;
export type ThemePresetKey = (typeof THEME_PRESET_KEYS)[number];

interface NeutralSeed { bg: string; surface: string; fg: string }
interface ModeSeed { primary: string; secondary: string; tertiary: string; neutral: NeutralSeed }
export interface ThemePreset {
  key: ThemePresetKey;
  name: string;
  description: string;
  light: ModeSeed;
  dark: ModeSeed;
}

const preset = (key: ThemePresetKey, name: string, description: string, light: ModeSeed, dark: ModeSeed): ThemePreset => ({ key, name, description, light, dark });

export const THEME_PRESETS: readonly ThemePreset[] = [
  preset('midnight', 'Midnight Intelligence', 'Navy, violet and electric blue',
    { primary: '#5b4cf0', secondary: '#2563eb', tertiary: '#0891b2', neutral: { bg: '#f5f6fc', surface: '#ffffff', fg: '#0d1230' } },
    { primary: '#8b7dff', secondary: '#4f8dff', tertiary: '#22d3ee', neutral: { bg: '#070b1a', surface: '#0e1430', fg: '#e8ecff' } }),
  preset('aurora', 'Aurora Glass', 'Teal, indigo and violet',
    { primary: '#0f8f84', secondary: '#4f46e5', tertiary: '#9333ea', neutral: { bg: '#f3f8f8', surface: '#ffffff', fg: '#0b1f24' } },
    { primary: '#2dd4bf', secondary: '#818cf8', tertiary: '#c084fc', neutral: { bg: '#05141a', surface: '#0b1f27', fg: '#e3f6f5' } }),
  preset('pearl', 'Executive Pearl', 'White, silver and blue',
    { primary: '#1d4ed8', secondary: '#64748b', tertiary: '#0284c7', neutral: { bg: '#f8fafc', surface: '#ffffff', fg: '#0f172a' } },
    { primary: '#7aa2ff', secondary: '#a5b4c8', tertiary: '#38bdf8', neutral: { bg: '#0c111b', surface: '#141b29', fg: '#eef2f8' } }),
  preset('graphite', 'Graphite Elite', 'Charcoal, graphite and platinum',
    { primary: '#3f3f46', secondary: '#71717a', tertiary: '#0e7490', neutral: { bg: '#f4f4f5', surface: '#ffffff', fg: '#18181b' } },
    { primary: '#d4d4d8', secondary: '#a1a1aa', tertiary: '#67e8f9', neutral: { bg: '#0e0e10', surface: '#18181b', fg: '#f4f4f5' } }),
  preset('oceanic', 'Oceanic Intelligence', 'Deep ocean blue and cyan',
    { primary: '#0369a1', secondary: '#0e7490', tertiary: '#1d4ed8', neutral: { bg: '#f1f7fb', surface: '#ffffff', fg: '#06202f' } },
    { primary: '#38bdf8', secondary: '#22d3ee', tertiary: '#60a5fa', neutral: { bg: '#03111d', surface: '#071d2e', fg: '#e0f2fe' } }),
  preset('emerald', 'Emerald Command', 'Emerald, mint and dark green',
    { primary: '#047857', secondary: '#0d9488', tertiary: '#4d7c0f', neutral: { bg: '#f2f8f5', surface: '#ffffff', fg: '#052e1c' } },
    { primary: '#34d399', secondary: '#5eead4', tertiary: '#a3e635', neutral: { bg: '#03140d', surface: '#082117', fg: '#e6f7ef' } }),
  preset('amethyst', 'Royal Amethyst', 'Purple, lavender and midnight',
    { primary: '#7c3aed', secondary: '#6d28d9', tertiary: '#4338ca', neutral: { bg: '#f7f5fd', surface: '#ffffff', fg: '#1e1338' } },
    { primary: '#b197fc', secondary: '#c4b5fd', tertiary: '#818cf8', neutral: { bg: '#0d0920', surface: '#171030', fg: '#f1ecff' } }),
  preset('sunset', 'Sunset Fusion', 'Coral, amber and violet',
    { primary: '#d9364a', secondary: '#b45309', tertiary: '#7c3aed', neutral: { bg: '#fdf7f4', surface: '#ffffff', fg: '#2a1310' } },
    { primary: '#fb7185', secondary: '#fbbf24', tertiary: '#a78bfa', neutral: { bg: '#170b0d', surface: '#231216', fg: '#fdeee9' } }),
  preset('arctic', 'Arctic Frost', 'Icy blue, white and slate',
    { primary: '#0273b8', secondary: '#475569', tertiary: '#0891b2', neutral: { bg: '#f4f8fb', surface: '#ffffff', fg: '#0f1d2a' } },
    { primary: '#7dd3fc', secondary: '#cbd5e1', tertiary: '#67e8f9', neutral: { bg: '#0a121a', surface: '#121d28', fg: '#eef6fb' } }),
  preset('copper', 'Copper Executive', 'Bronze, graphite and cream',
    { primary: '#9a5a26', secondary: '#57534e', tertiary: '#a16207', neutral: { bg: '#faf6f0', surface: '#fffdf9', fg: '#231a12' } },
    { primary: '#e0a46e', secondary: '#d6d3d1', tertiary: '#facc15', neutral: { bg: '#110d0a', surface: '#1c1612', fg: '#f7efe4' } }),
  preset('rose', 'Rose Quartz', 'Soft rose, plum and pearl',
    { primary: '#be185d', secondary: '#86198f', tertiary: '#9f1239', neutral: { bg: '#fcf6f8', surface: '#ffffff', fg: '#2a1020' } },
    { primary: '#f9a8d4', secondary: '#e879f9', tertiary: '#fda4af', neutral: { bg: '#140910', surface: '#21101b', fg: '#fdeef5' } }),
  preset('monochrome', 'Monochrome Precision', 'Black, white and neutral grey',
    { primary: '#111111', secondary: '#525252', tertiary: '#262626', neutral: { bg: '#f6f6f6', surface: '#ffffff', fg: '#0a0a0a' } },
    { primary: '#f5f5f5', secondary: '#a3a3a3', tertiary: '#e5e5e5', neutral: { bg: '#0a0a0a', surface: '#161616', fg: '#fafafa' } }),
  preset('cyber', 'Cyber Neon', 'Electric magenta, violet and cyan',
    { primary: '#a21caf', secondary: '#6d28d9', tertiary: '#0891b2', neutral: { bg: '#f8f4fe', surface: '#ffffff', fg: '#1b0f33' } },
    { primary: '#e879f9', secondary: '#a78bfa', tertiary: '#22d3ee', neutral: { bg: '#0a0618', surface: '#150d2c', fg: '#f5efff' } }),
];

export const presetByKey = (key: string): ThemePreset => THEME_PRESETS.find((p) => p.key === key) ?? THEME_PRESETS[0]!;

// ---------------------------------------------------------------------------------------------------------------
// Appearance preferences
// ---------------------------------------------------------------------------------------------------------------

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #4f46e5');

export const appearanceSchema = z.object({
  preset: z.enum(THEME_PRESET_KEYS),
  mode: z.enum(['system', 'light', 'dark']),
  primary: hex.nullable(),
  secondary: hex.nullable(),
  accent: hex.nullable(),
  contrast: z.enum(['standard', 'high']),
  density: z.enum(['compact', 'comfortable', 'spacious']),
  motion: z.enum(['cinematic', 'balanced', 'focus']),
  radius: z.enum(['sharp', 'default', 'round']),
  fontSize: z.enum(['small', 'default', 'large']),
  sidebar: z.enum(['expanded', 'collapsed']),
  sidebarStyle: z.enum(['solid', 'glass']),
  tableDensity: z.enum(['compact', 'comfortable']),
  chartPalette: z.enum(['theme', 'colorblind', 'monochrome']),
  focusMode: z.boolean(),
  /** Visual style: "neon" is the glass and gradient design (default); "classic" is the flat original look. */
  style: z.enum(['neon', 'classic']),
  /** Background art behind the app in the neon style. */
  backdrop: z.enum(['aurora', 'cosmos', 'gradient', 'plain']),
});
export type Appearance = z.infer<typeof appearanceSchema>;
export const DEFAULT_APPEARANCE: Appearance = {
  preset: 'midnight', mode: 'system', primary: null, secondary: null, accent: null, contrast: 'standard', density: 'comfortable', motion: 'balanced',
  radius: 'default', fontSize: 'default', sidebar: 'expanded', sidebarStyle: 'glass', tableDensity: 'comfortable', chartPalette: 'theme', focusMode: false,
  style: 'neon', backdrop: 'aurora',
};

/** Colour palette swatches offered in the Themes panel: each sets the primary colour (null keeps the preset's own). */
export const PALETTE_SWATCHES = ['#7c3aed', '#2563eb', '#0d9488', '#ea580c', '#db2777', '#4f46e5'] as const;

/**
 * Ready-made looks in the Themes panel. Each is just a set of appearance fields, saved to the member's preferences
 * like any other change, so a template can be tweaked afterwards.
 */
export interface ThemeTemplate { key: string; name: string; description: string; patch: Partial<Appearance> }
export const THEME_TEMPLATES: readonly ThemeTemplate[] = [
  { key: 'corporate-modern', name: 'Corporate Modern', description: 'Calm blues on light glass', patch: { preset: 'pearl', mode: 'light', style: 'neon', backdrop: 'aurora', primary: null, radius: 'default' } },
  { key: 'creative-gradient', name: 'Creative Gradient', description: 'Violet and pink with a colour wash', patch: { preset: 'amethyst', mode: 'light', style: 'neon', backdrop: 'gradient', primary: '#7c3aed', radius: 'round' } },
  { key: 'dark-elegant', name: 'Dark Elegant', description: 'Deep night with neon edges', patch: { preset: 'midnight', mode: 'dark', style: 'neon', backdrop: 'cosmos', primary: null, radius: 'default' } },
  { key: 'minimal-clean', name: 'Minimal Clean', description: 'Flat, quiet and high contrast', patch: { preset: 'monochrome', mode: 'light', style: 'classic', backdrop: 'plain', primary: null, radius: 'sharp' } },
  { key: 'nature-fresh', name: 'Nature Fresh', description: 'Emerald and mint', patch: { preset: 'emerald', mode: 'light', style: 'neon', backdrop: 'aurora', primary: null, radius: 'round' } },
  { key: 'tech-futuristic', name: 'Tech Futuristic', description: 'Magenta and cyan on deep violet', patch: { preset: 'cyber', mode: 'dark', style: 'neon', backdrop: 'cosmos', primary: null, radius: 'default' } },
];

/** Partial update: any subset of fields; unknown fields are refused. */
export const appearancePatch = appearanceSchema.partial().strict();
export type AppearancePatch = z.infer<typeof appearancePatch>;

/** Reads a stored or cookie value leniently: bad fields fall back to defaults instead of failing the page. */
export function normaliseAppearance(raw: unknown): Appearance {
  const out: Record<string, unknown> = { ...DEFAULT_APPEARANCE };
  if (raw && typeof raw === 'object') {
    for (const [k, field] of Object.entries(appearanceSchema.shape)) {
      const v = (raw as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const r = (field as z.ZodType).safeParse(v);
      if (r.success) out[k] = r.data;
    }
  }
  return out as Appearance;
}

// ---------------------------------------------------------------------------------------------------------------
// Favourites, recents, dashboard layout, notes
// ---------------------------------------------------------------------------------------------------------------

/** In-app path only, so a saved shortcut can never point off-site. */
export const appPath = z.string().min(1).max(200).regex(/^\/(?!\/)[A-Za-z0-9\-._~/?=&%]*$/, 'Must be a page inside CREW');

export const favouritesInput = z.object({ hrefs: z.array(appPath).max(12) }).strict();
export const recentVisitInput = z.object({ href: appPath, label: z.string().trim().min(1).max(120) }).strict();
export const MAX_RECENTS = 8;

export const DASHBOARD_WIDGETS = ['attention', 'announcements', 'headcount', 'tasks', 'recent', 'quick-actions', 'notes', 'helpdesk', 'setup', 'access'] as const;
export type DashboardWidget = (typeof DASHBOARD_WIDGETS)[number];
export const dashboardLayoutInput = z.object({
  order: z.array(z.enum(DASHBOARD_WIDGETS)).max(DASHBOARD_WIDGETS.length).refine((a) => new Set(a).size === a.length, 'Each widget once'),
  hidden: z.array(z.enum(DASHBOARD_WIDGETS)).max(DASHBOARD_WIDGETS.length).default([]),
}).strict();
export type DashboardLayout = z.infer<typeof dashboardLayoutInput>;

/** Saved order first, then any widgets added since in their default place. */
export function resolveLayout(saved: Partial<DashboardLayout> | null | undefined): DashboardLayout {
  const order = (saved?.order ?? []).filter((w): w is DashboardWidget => (DASHBOARD_WIDGETS as readonly string[]).includes(w));
  for (const w of DASHBOARD_WIDGETS) if (!order.includes(w)) order.push(w);
  return { order, hidden: (saved?.hidden ?? []).filter((w) => order.includes(w)) };
}

export const notesInput = z.object({ notes: z.string().max(4000) }).strict();

export interface MemberPreferences {
  appearance: Appearance;
  favourites: string[];
  recents: { href: string; label: string; at: string }[];
  dashboard: DashboardLayout;
  notes: string;
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------------------------------------------

type Rgb = [number, number, number];
const toRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
/** Linear blend from a (t = 0) to b (t = 1). */
export const mix = (a: string, b: string, t: number) => {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as Rgb);
};
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = (h: string) => {
  const [r, g, b] = toRgb(h);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
/** WCAG 2.x contrast ratio, 1 to 21. */
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** Moves `color` towards `toward` in small steps until it reaches `min` contrast against `against`. */
export function ensureContrast(color: string, against: string, min: number, toward: string): string {
  let c = color;
  for (let i = 0; i < 40 && contrast(c, against) < min; i++) c = mix(c, toward, 0.06);
  return c;
}
const readableOn = (bg: string) => (contrast('#ffffff', bg) >= contrast('#0a0a0a', bg) ? '#ffffff' : '#0a0a0a');

// ---------------------------------------------------------------------------------------------------------------
// Token builder
// ---------------------------------------------------------------------------------------------------------------

export const THEME_TOKENS = [
  'bg', 'bg-subtle', 'surface', 'surface-raised', 'fg', 'fg-muted', 'fg-subtle', 'border', 'border-strong',
  'accent', 'accent-hover', 'accent-subtle', 'accent-fg', 'ember', 'ember-subtle',
  'success', 'success-subtle', 'warning', 'warning-subtle', 'danger', 'danger-subtle', 'info', 'info-subtle',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'ring', 'glow-1', 'glow-2', 'glow-3',
] as const;
export type ThemeTokens = Record<(typeof THEME_TOKENS)[number], string>;

const STATUS = {
  light: { success: '#15803d', warning: '#b45309', danger: '#dc2626', info: '#0369a1' },
  dark: { success: '#4ade80', warning: '#fbbf24', danger: '#f87171', info: '#38bdf8' },
};
const COLORBLIND = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9'];

export function buildTheme(a: Pick<Appearance, 'preset' | 'primary' | 'secondary' | 'accent' | 'contrast' | 'chartPalette'>, mode: 'light' | 'dark'): ThemeTokens {
  const seed = presetByKey(a.preset)[mode];
  const dark = mode === 'dark';
  const high = a.contrast === 'high';
  const { bg, surface } = seed.neutral;
  const fg = high ? (dark ? '#ffffff' : '#000000') : seed.neutral.fg;
  const toward = dark ? '#ffffff' : '#000000';

  const bgSubtle = mix(bg, fg, dark ? 0.045 : 0.035);
  const surfaceRaised = dark ? mix(surface, fg, 0.05) : surface;
  const border = mix(surface, fg, high ? 0.32 : dark ? 0.13 : 0.1);
  const borderStrong = mix(surface, fg, high ? 0.5 : dark ? 0.22 : 0.18);
  const fgMuted = ensureContrast(mix(fg, bg, high ? 0.12 : 0.3), bgSubtle, high ? 7 : 4.6, fg);
  // Subtle text is used at small sizes (table headings, timestamps, hints), so it needs the full 4.5:1 too.
  const fgSubtle = ensureContrast(mix(fg, bg, high ? 0.25 : 0.4), bgSubtle, high ? 7 : 4.6, fg);

  // Accent: used as text on surfaces and as a filled button. Keep it legible both ways.
  let accent = ensureContrast(a.primary ?? seed.primary, surface, high ? 6 : 4.5, toward);
  accent = ensureContrast(accent, bgSubtle, 3.2, toward);
  // Badges and the selected menu item put accent text on accent-subtle: a lighter tint first, then a stronger accent.
  let tint = dark ? 0.18 : 0.09;
  while (tint > 0.05 && contrast(accent, mix(surface, accent, tint)) < 4.6) tint -= 0.01;
  const accentSubtle = mix(surface, accent, tint);
  accent = ensureContrast(accent, accentSubtle, 4.6, toward);
  const accentFg = readableOn(accent);
  // Filled buttons put accent-fg on accent: push the accent away from its text colour until that reads at AA.
  accent = ensureContrast(accent, accentFg, 4.5, accentFg === '#ffffff' ? '#000000' : '#ffffff');
  const accentHover = mix(accent, dark ? '#ffffff' : '#000000', 0.14);
  const secondary = ensureContrast(ensureContrast(a.secondary ?? seed.secondary, surface, 4.5, toward), mix(surface, a.secondary ?? seed.secondary, dark ? 0.16 : 0.08), 4.6, toward);
  const tertiary = a.accent ?? seed.tertiary;

  const sub = (c: string) => mix(surface, c, dark ? 0.16 : 0.08);
  // Status badges put the colour on its own tint: keep each pair at 4.5:1 or more.
  const onTint = (c: string) => ensureContrast(c, sub(c), 4.6, toward);
  const status = Object.fromEntries(Object.entries(STATUS[mode]).map(([k, c]) => [k, onTint(c)])) as (typeof STATUS)['light'];
  const charts =
    a.chartPalette === 'colorblind'
      ? COLORBLIND
      : a.chartPalette === 'monochrome'
        ? [0.95, 0.75, 0.55, 0.38, 0.24].map((t) => mix(surface, accent, t))
        : [accent, a.secondary ?? seed.secondary, tertiary, dark ? '#fbbf24' : '#d97706', dark ? '#f472b6' : '#db2777'];

  return {
    bg, 'bg-subtle': bgSubtle, surface, 'surface-raised': surfaceRaised, fg, 'fg-muted': fgMuted, 'fg-subtle': fgSubtle, border, 'border-strong': borderStrong,
    accent, 'accent-hover': accentHover, 'accent-subtle': accentSubtle, 'accent-fg': accentFg,
    ember: secondary, 'ember-subtle': sub(secondary),
    success: status.success, 'success-subtle': sub(status.success), warning: status.warning, 'warning-subtle': sub(status.warning),
    danger: status.danger, 'danger-subtle': sub(status.danger), info: status.info, 'info-subtle': sub(status.info),
    'chart-1': charts[0]!, 'chart-2': charts[1]!, 'chart-3': charts[2]!, 'chart-4': charts[3]!, 'chart-5': charts[4]!,
    ring: mix(accent, toward, dark ? 0.2 : 0),
    'glow-1': a.primary ?? seed.primary, 'glow-2': a.secondary ?? seed.secondary, 'glow-3': tertiary,
  };
}

const declarations = (t: ThemeTokens) => THEME_TOKENS.map((k) => `--${k}:${t[k]};`).join('');

/**
 * Stylesheet for one member's appearance. `:root` selectors carry the light and dark palettes; "system" follows the
 * operating system through a media query and an explicit mode is pinned with data-theme. Non-colour preferences
 * (density, radius, font size, motion) are attributes on <html> styled by @crew/ui/styles.css.
 */
export function themeStylesheet(a: Appearance): string {
  // More specific than @crew/ui's built-in :root[data-theme] palette, which it replaces.
  const R = 'html:root[data-preset]';
  const light = declarations(buildTheme(a, 'light'));
  const dark = declarations(buildTheme(a, 'dark'));
  if (a.mode === 'light') return `${R}{color-scheme:light;${light}}`;
  if (a.mode === 'dark') return `${R}{color-scheme:dark;${dark}}`;
  return `${R}{color-scheme:light;${light}}@media (prefers-color-scheme: dark){${R}{color-scheme:dark;${dark}}}`;
}

/** Attributes for <html>, so the first paint already has the right density, motion and shape. */
export function appearanceAttributes(a: Appearance): Record<string, string> {
  return {
    'data-preset': a.preset,
    ...(a.mode === 'system' ? {} : { 'data-theme': a.mode }),
    'data-density': a.density,
    'data-motion': a.focusMode ? 'focus' : a.motion,
    'data-radius': a.radius,
    'data-font': a.fontSize,
    'data-contrast': a.contrast,
    'data-table': a.tableDensity,
    'data-sidebar-style': a.sidebarStyle,
    'data-style': a.style,
    'data-backdrop': a.backdrop,
    ...(a.focusMode ? { 'data-focus': 'on' } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Saved table views
// ---------------------------------------------------------------------------------------------------------------

export const VIEW_PAGES = ['employees', 'candidates'] as const;
export type ViewPage = (typeof VIEW_PAGES)[number];
export const MAX_VIEWS_PER_PAGE = 20;

/** What a saved view remembers: filters, sort, visible columns (in order) and row density. */
export const viewState = z.object({
  filters: z.record(z.string().max(40), z.string().max(200)).refine((f) => Object.keys(f).length <= 12, 'Too many filters').default({}),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  columns: z.array(z.string().max(40)).max(30).optional(),
  density: z.enum(['compact', 'comfortable']).optional(),
}).strict();
export type ViewState = z.infer<typeof viewState>;

export const savedViewInput = z.object({
  page: z.enum(VIEW_PAGES),
  name: z.string().trim().min(1).max(60),
  state: viewState,
  isDefault: z.boolean().default(false),
}).strict();
export const savedViewPatch = savedViewInput.omit({ page: true }).partial().strict();
export interface SavedView { id: string; page: ViewPage; name: string; state: ViewState; isDefault: boolean; updatedAt: string }

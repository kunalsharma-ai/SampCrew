import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPEARANCE, THEME_PRESETS, THEME_TOKENS, appearanceAttributes, appearancePatch, appPath, buildTheme, contrast, dashboardLayoutInput,
  normaliseAppearance, resolveLayout, themeStylesheet,
} from './experience';

describe('theme presets', () => {
  it('ships the twelve named presets', () => {
    expect(THEME_PRESETS.map((p) => p.name)).toEqual([
      'Midnight Intelligence', 'Aurora Glass', 'Executive Pearl', 'Graphite Elite', 'Oceanic Intelligence', 'Emerald Command',
      'Royal Amethyst', 'Sunset Fusion', 'Arctic Frost', 'Copper Executive', 'Rose Quartz', 'Monochrome Precision',
    ]);
  });

  for (const p of THEME_PRESETS) {
    for (const mode of ['light', 'dark'] as const) {
      for (const level of ['standard', 'high'] as const) {
        it(`${p.name} ${mode} (${level} contrast) meets WCAG AA for text and buttons`, () => {
          const t = buildTheme({ ...DEFAULT_APPEARANCE, preset: p.key, contrast: level }, mode);
          for (const k of THEME_TOKENS) expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/);
          const body = level === 'high' ? 7 : 4.5;
          expect(contrast(t.fg, t.bg)).toBeGreaterThanOrEqual(body);
          expect(contrast(t.fg, t.surface)).toBeGreaterThanOrEqual(body);
          expect(contrast(t['fg-muted'], t.surface)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t['fg-muted'], t['bg-subtle'])).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t['fg-subtle'], t['bg-subtle'])).toBeGreaterThanOrEqual(3);
          expect(contrast(t.accent, t.surface)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t['accent-fg'], t.accent)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t.ember, t.surface)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it('keeps a custom primary colour legible by adjusting it, not by refusing it', () => {
    for (const primary of ['#ffff00', '#00ff00', '#000080', '#777777']) {
      for (const mode of ['light', 'dark'] as const) {
        const t = buildTheme({ ...DEFAULT_APPEARANCE, primary }, mode);
        expect(contrast(t.accent, t.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t['accent-fg'], t.accent)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('offers a colour-blind safe chart palette', () => {
    const t = buildTheme({ ...DEFAULT_APPEARANCE, chartPalette: 'colorblind' }, 'light');
    expect(t['chart-1']).toBe('#0072b2');
    expect(t['chart-2']).toBe('#e69f00');
  });
});

describe('appearance preferences', () => {
  it('defaults to Midnight Intelligence, comfortable density and balanced motion', () => {
    expect(DEFAULT_APPEARANCE).toMatchObject({ preset: 'midnight', mode: 'system', density: 'comfortable', motion: 'balanced', focusMode: false });
  });

  it('normalises stored values field by field', () => {
    const a = normaliseAppearance({ preset: 'emerald', density: 'huge', primary: 'red', motion: 'focus', extra: 1 });
    expect(a.preset).toBe('emerald');
    expect(a.density).toBe('comfortable');
    expect(a.primary).toBeNull();
    expect(a.motion).toBe('focus');
    expect(a).not.toHaveProperty('extra');
    expect(normaliseAppearance('garbage')).toEqual(DEFAULT_APPEARANCE);
  });

  it('refuses unknown fields and bad colours in an update', () => {
    expect(appearancePatch.safeParse({ preset: 'nope' }).success).toBe(false);
    expect(appearancePatch.safeParse({ primary: 'blue' }).success).toBe(false);
    expect(appearancePatch.safeParse({ admin: true }).success).toBe(false);
    expect(appearancePatch.safeParse({ primary: '#12ab34', mode: 'dark' }).success).toBe(true);
  });

  it('writes system mode as a media query and pins explicit modes', () => {
    expect(themeStylesheet(DEFAULT_APPEARANCE)).toContain('@media (prefers-color-scheme: dark)');
    expect(themeStylesheet({ ...DEFAULT_APPEARANCE, mode: 'dark' })).not.toContain('@media');
    expect(appearanceAttributes({ ...DEFAULT_APPEARANCE, mode: 'dark', focusMode: true })).toMatchObject({ 'data-theme': 'dark', 'data-motion': 'focus', 'data-focus': 'on' });
    expect(appearanceAttributes(DEFAULT_APPEARANCE)).not.toHaveProperty('data-theme');
  });
});

describe('shortcuts and dashboard layout', () => {
  it('only accepts paths inside CREW', () => {
    expect(appPath.safeParse('/employees?status=active').success).toBe(true);
    for (const bad of ['https://evil.test', '//evil.test', 'javascript:alert(1)', '/a b', '/<script>']) expect(appPath.safeParse(bad).success, bad).toBe(false);
  });

  it('keeps saved widget order and appends widgets added later', () => {
    const l = resolveLayout({ order: ['notes', 'attention'], hidden: ['notes', 'bogus' as never] });
    expect(l.order.slice(0, 2)).toEqual(['notes', 'attention']);
    expect(l.order).toContain('headcount');
    expect(l.hidden).toEqual(['notes']);
    expect(dashboardLayoutInput.safeParse({ order: ['notes', 'notes'] }).success).toBe(false);
  });
});

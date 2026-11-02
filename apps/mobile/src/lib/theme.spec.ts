import { contrast, DEFAULT_APPEARANCE, THEME_PRESETS } from '@crew/contracts';
import { describe, expect, it } from 'vitest';
import { cachedAppearance, mobileTheme, resolveMode } from './theme';

describe('mobile theme', () => {
  it('follows the phone for "system" and pins an explicit mode', () => {
    expect(resolveMode({ mode: 'system' }, 'dark')).toBe('dark');
    expect(resolveMode({ mode: 'system' }, null)).toBe('light');
    expect(resolveMode({ mode: 'light' }, 'dark')).toBe('light');
    expect(resolveMode({ mode: 'dark' }, 'light')).toBe('dark');
  });

  it('gives each preset its own colours, the same as the Web Portal builds', () => {
    const accents = new Set(THEME_PRESETS.map((p) => mobileTheme({ ...DEFAULT_APPEARANCE, preset: p.key }, 'light').accent));
    expect(accents.size).toBeGreaterThan(8);
    const emerald = mobileTheme({ ...DEFAULT_APPEARANCE, preset: 'emerald', mode: 'dark' }, 'light');
    expect(emerald.mode).toBe('dark');
    expect(emerald.bg).toBe(THEME_PRESETS.find((p) => p.key === 'emerald')!.dark.neutral.bg);
  });

  it('keeps text readable in every preset, mode and contrast setting', () => {
    for (const p of THEME_PRESETS) {
      for (const mode of ['light', 'dark'] as const) {
        for (const level of ['standard', 'high'] as const) {
          const t = mobileTheme({ ...DEFAULT_APPEARANCE, preset: p.key, mode, contrast: level }, null);
          const where = `${p.key} ${mode} ${level}`;
          expect(contrast(t.fg, t.bg), `${where} text`).toBeGreaterThanOrEqual(level === 'high' ? 7 : 4.5);
          expect(contrast(t.fg, t.card), `${where} text on cards`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t.muted, t.card), `${where} muted text`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t.accentFg, t.accent), `${where} buttons`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t.accent, t.card), `${where} links`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t.accent, t.infoBg), `${where} selected chips`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('applies custom colours and falls back to the default for a bad cache', () => {
    const t = mobileTheme({ ...DEFAULT_APPEARANCE, mode: 'light', primary: '#0f766e' }, null);
    expect(t.accent).not.toBe(mobileTheme({ ...DEFAULT_APPEARANCE, mode: 'light' }, null).accent);
    expect(cachedAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(cachedAppearance('{not json')).toEqual(DEFAULT_APPEARANCE);
    expect(cachedAppearance(JSON.stringify({ preset: 'rose', mode: 'dark' }))).toMatchObject({ preset: 'rose', mode: 'dark' });
  });
});

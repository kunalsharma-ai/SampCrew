import { SIGN_IN_PALETTES, WELCOME_SCENES } from '@crew/contracts';
import { describe, expect, it } from 'vitest';
import { parseSignInTheme, signInWorld, WORLDS } from './signin-theme';

describe('phone sign-in look', () => {
  it('keeps each level its own world on Auto with the signature colours', () => {
    for (const s of WELCOME_SCENES) expect(signInWorld(s)).toBe(WORLDS[s]);
  });

  it('flips a world when Light or Dark is the other tone', () => {
    expect(signInWorld('hr', 'light').light).toBe(true);
    expect(signInWorld('hr', 'light').ink).toBe('#1e1b4b');
    expect(signInWorld('employee', 'dark').light).toBe(false);
    expect(signInWorld('employee', 'dark').ink).toBe('#ffffff');
    expect(signInWorld('super', 'dark')).toBe(WORLDS.super);
  });

  it('recolours with a palette in the chosen tone, with a solid colour for phones without gradients', () => {
    const ocean = SIGN_IN_PALETTES.find((p) => p.key === 'ocean')!;
    const w = signInWorld('console', 'light', 'ocean');
    expect(w.bg).toBe(ocean.light.base);
    expect(w.base).toMatch(/^#[0-9a-f]{6}$/i);
    expect(w.accent).toBe(ocean.tint);
    expect(w.light).toBe(true);
  });

  it('reads the kept choice and ignores anything it does not know', () => {
    expect(parseSignInTheme('{"mode":"dark","palette":"forest"}')).toEqual({ mode: 'dark', palette: 'forest' });
    expect(parseSignInTheme('{"mode":"neon","palette":"nope"}')).toEqual({ mode: 'auto', palette: 'signature' });
    expect(parseSignInTheme('not json')).toEqual({ mode: 'auto', palette: 'signature' });
    expect(parseSignInTheme(null)).toEqual({ mode: 'auto', palette: 'signature' });
  });
});

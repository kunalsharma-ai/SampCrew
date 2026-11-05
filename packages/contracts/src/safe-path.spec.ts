import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-path';

describe('safeNextPath', () => {
  it('keeps paths on this site', () => {
    expect(safeNextPath('/people')).toBe('/people');
    expect(safeNextPath('/people?tab=docs#top')).toBe('/people?tab=docs#top');
    expect(safeNextPath('/settings/single-sign-on')).toBe('/settings/single-sign-on');
  });
  it('refuses anything that could leave the site', () => {
    for (const bad of ['//evil.example', '/\\evil.example', '/\\/evil.example', 'https://evil.example', 'javascript:alert(1)', '/\tevil', ' /people', '/peo\nple', 'people', '']) {
      expect(safeNextPath(bad), bad).toBe('/');
    }
    expect(safeNextPath(undefined, '/home')).toBe('/home');
    expect(safeNextPath('/' + 'a'.repeat(2001))).toBe('/');
  });
});

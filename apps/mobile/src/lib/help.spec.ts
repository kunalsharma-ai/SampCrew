import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOBILE_HELP } from './help';

const APP = path.join(__dirname, '..', '..', 'app');
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const sources = walk(APP).filter((f) => f.endsWith('.tsx')).map((f) => fs.readFileSync(f, 'utf8'));

describe('mobile help content', () => {
  it('puts an "i" icon in the header of every screen that has a header', () => {
    const missing: string[] = [];
    let screens = 0;
    for (const file of ['_layout.tsx', path.join('(tabs)', '_layout.tsx')]) {
      const src = fs.readFileSync(path.join(APP, file), 'utf8');
      for (const m of src.matchAll(/<(?:Stack|Tabs)\.Screen name="([^"]+)" options=\{\{([^]*?)\}\} \/>/g)) {
        screens += 1;
        if (/headerShown: false/.test(m[2]!)) continue;
        if (!/screenHelp\('/.test(m[2]!)) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(screens).toBeGreaterThanOrEqual(16);
    expect(missing).toEqual([]);
  });

  it('uses every entry somewhere', () => {
    const all = sources.join('\n');
    const unused = Object.keys(MOBILE_HELP).filter((k) => !all.includes(`'${k}'`) && !all.includes(`"${k}"`));
    expect(unused).toEqual([]);
  });

  it('is short, complete and uses the SampCrew name', () => {
    for (const [key, e] of Object.entries(MOBILE_HELP) as [string, { title: string; what: string; how?: string; where?: string }][]) {
      expect(e.title.trim(), key).not.toBe('');
      expect(e.what.trim(), key).not.toBe('');
      for (const part of [e.what, e.how, e.where]) {
        if (!part) continue;
        expect(part.length, `${key}: ${part}`).toBeLessThanOrEqual(240);
        expect(part, key).not.toMatch(/\bCREW\b/);
      }
    }
  });
});

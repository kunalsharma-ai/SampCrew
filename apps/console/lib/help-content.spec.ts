import fs from 'node:fs';
import path from 'node:path';
import { allHelpEntries, resolveHelp } from '@crew/ui/help-resolve';
import { describe, expect, it } from 'vitest';
import { CONSOLE_HELP } from './help-content';

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'app', '(console)');
const NO_HELP = new Set(['/no-access']);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
function routeOf(file: string): string {
  const rel = path.relative(APP, path.dirname(file)).split(path.sep).filter((s) => s && !s.startsWith('('));
  return `/${rel.join('/')}`;
}
const pages = walk(APP).filter((f) => path.basename(f) === 'page.tsx').map(routeOf);

describe('Console help content', () => {
  it('explains every page, and only pages that exist', () => {
    expect(pages.filter((r) => !NO_HELP.has(r) && !Object.prototype.hasOwnProperty.call(CONSOLE_HELP.pages, r))).toEqual([]);
    expect(Object.keys(CONSOLE_HELP.pages).filter((p) => !pages.includes(p))).toEqual([]);
  });

  it('explains every section heading', () => {
    const files = [...walk(APP), ...walk(path.join(ROOT, 'components'))].filter((f) => f.endsWith('.tsx'));
    const missing: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/CardHeader\s+title="([^"]+)"/g)) {
        if (!resolveHelp(CONSOLE_HELP, 'section', '/', m[1]!)) missing.push(`${path.relative(ROOT, f)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('is short, complete and uses the SampCrew name', () => {
    for (const { where, entry } of allHelpEntries(CONSOLE_HELP)) {
      expect(entry.what.trim(), where).not.toBe('');
      for (const part of [entry.what, entry.how, entry.where]) {
        if (!part) continue;
        expect(part.length, `${where}: ${part}`).toBeLessThanOrEqual(240);
        expect(part, where).not.toMatch(/\bCREW\b/);
      }
    }
  });
});

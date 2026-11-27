import fs from 'node:fs';
import path from 'node:path';
import { allHelpEntries, matchRoute, resolveHelp } from '@crew/ui/help-resolve';
import { describe, expect, it } from 'vitest';
import { WEB_HELP } from './help-content';
import { NAV } from './nav';

const APP = path.join(__dirname, '..', 'app', '(app)');
/** Pages with no screen of their own (they redirect or only explain a missing permission). */
const NO_HELP = new Set(['/no-access', '/recruitment/offers/[id]']);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
/** The URL pattern of a file's folder: app/(app)/employees/[id]/tabs.tsx -> /employees/[id]. */
function routeOf(file: string): string {
  const rel = path.relative(APP, path.dirname(file)).split(path.sep).filter((s) => s && !s.startsWith('('));
  return `/${rel.join('/')}`;
}

const files = walk(APP).filter((f) => f.endsWith('.tsx'));

describe('Web Portal help content', () => {
  it('explains every page', () => {
    const missing = files
      .filter((f) => path.basename(f) === 'page.tsx')
      .map(routeOf)
      .filter((r) => !NO_HELP.has(r) && !Object.prototype.hasOwnProperty.call(WEB_HELP.pages, r));
    expect(missing).toEqual([]);
  });

  it('has no help for pages that do not exist', () => {
    const routes = new Set(files.filter((f) => path.basename(f) === 'page.tsx').map(routeOf));
    expect(Object.keys(WEB_HELP.pages).filter((p) => !routes.has(p))).toEqual([]);
    expect(Object.keys(WEB_HELP.routes ?? {}).filter((p) => !routes.has(p))).toEqual([]);
  });

  it('explains every sidebar group', () => {
    expect(NAV.map((g) => g.label).filter((l) => !resolveHelp(WEB_HELP, 'module', '/', l))).toEqual([]);
  });

  it('explains every section heading on its page', () => {
    const missing: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/CardHeader\s+title="([^"]+)"/g)) {
        const route = routeOf(f);
        // A component in a parent folder can be used by any page below it: resolve against its own folder's route.
        const pattern = matchRoute(Object.keys(WEB_HELP.pages), route) ?? route;
        if (!resolveHelp(WEB_HELP, 'section', pattern.replace(/\[[^\]]+\]/g, 'x'), m[1]!)) missing.push(`${route}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('is short, complete and uses the SampCrew name', () => {
    for (const { where, entry } of allHelpEntries(WEB_HELP)) {
      expect(entry.what.trim(), where).not.toBe('');
      for (const part of [entry.what, entry.how, entry.where]) {
        if (!part) continue;
        expect(part.length, `${where}: ${part}`).toBeLessThanOrEqual(240);
        expect(part, where).not.toMatch(/\bCREW\b/);
      }
    }
  });
});

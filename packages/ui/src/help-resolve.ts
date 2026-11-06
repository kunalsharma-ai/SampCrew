/**
 * In-app help ("i" icons): the content shape every app fills in, and the pure lookup that finds the right entry for a
 * page, a section heading, a form field or a navigation group. Kept free of React so it is easy to test.
 */

/** One help bubble: what the thing is for, how to use it, and where or when it is used. */
export interface HelpEntry {
  /** Heading inside the bubble. Defaults to the visible name of the thing it explains. */
  title?: string;
  /** What it is and what it is for. */
  what: string;
  /** How to use it. */
  how?: string;
  /** Where or when to use it, and who usually does. */
  where?: string;
}

export type HelpKind = 'page' | 'section' | 'field' | 'module';

export interface HelpContent {
  /** Whole pages, by route pattern: '/employees', '/employees/[id]'. A [segment] matches any one path segment. */
  pages: Record<string, HelpEntry & { title: string }>;
  /** Section (card) headings by their visible title. Used on every page unless a route override exists. */
  sections: Record<string, HelpEntry>;
  /** Form fields by their visible label. Used on every page unless a route override exists. */
  fields: Record<string, HelpEntry>;
  /** Navigation groups (modules) by their visible label. */
  modules?: Record<string, HelpEntry>;
  /** Sections and fields whose meaning differs on one page, by route pattern (same syntax as pages). */
  routes?: Record<string, { sections?: Record<string, HelpEntry>; fields?: Record<string, HelpEntry> }>;
}

/** Visible text as a lookup key: trimmed, single-spaced, without a trailing count like " (3)", old brand name updated. */
export function helpKey(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bCREW\b/g, 'SampCrew')
    .replace(/\s*\(\d+\)$/, '')
    .replace(/\s*\*$/, '')
    .trim();
}

function segments(path: string): string[] {
  return path.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean);
}

/**
 * How well a route pattern fits a pathname: -1 for no match, otherwise higher is more specific (fewer [segments]).
 */
export function routeScore(pattern: string, pathname: string): number {
  const p = segments(pattern);
  const s = segments(pathname);
  if (p.length !== s.length) return -1;
  let score = 1;
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg.startsWith('[') && seg.endsWith(']')) continue;
    if (seg !== decodeURIComponent(s[i]!)) return -1;
    score += 1;
  }
  return score;
}

/** The best matching pattern among `patterns` for `pathname`, or undefined. */
export function matchRoute(patterns: Iterable<string>, pathname: string): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const pattern of patterns) {
    const score = routeScore(pattern, pathname);
    if (score > bestScore) {
      best = pattern;
      bestScore = score;
    }
  }
  return best;
}

function lookup(map: Record<string, HelpEntry> | undefined, key: string): HelpEntry | undefined {
  if (!map) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  // Case-insensitive fallback, so "Leave types" and "Leave Types" share one entry.
  const lower = key.toLowerCase();
  for (const k of Object.keys(map)) if (k.toLowerCase() === lower) return map[k];
  return undefined;
}

/**
 * The help entry for one thing on screen, or undefined when there is none (then no icon is shown).
 * - page: by pathname alone (`text` is ignored).
 * - section / field: a route override for the current page first, then the shared entry by visible text.
 * - module: by the navigation group's label.
 */
export function resolveHelp(content: HelpContent, kind: HelpKind, pathname: string, text?: string): HelpEntry | undefined {
  if (kind === 'page') {
    const pattern = matchRoute(Object.keys(content.pages), pathname);
    return pattern ? content.pages[pattern] : undefined;
  }
  if (!text) return undefined;
  const key = helpKey(text);
  if (!key) return undefined;
  if (kind === 'module') return lookup(content.modules, key);
  const group = kind === 'section' ? 'sections' : 'fields';
  if (content.routes) {
    const pattern = matchRoute(Object.keys(content.routes), pathname);
    const scoped = pattern ? lookup(content.routes[pattern]?.[group], key) : undefined;
    if (scoped) return scoped;
  }
  return lookup(content[group], key);
}

/** Every entry, with where it came from: for content checks (no empty text, sensible length). */
export function allHelpEntries(content: HelpContent): { where: string; entry: HelpEntry }[] {
  const out: { where: string; entry: HelpEntry }[] = [];
  for (const [k, e] of Object.entries(content.pages)) out.push({ where: `page ${k}`, entry: e });
  for (const [k, e] of Object.entries(content.sections)) out.push({ where: `section ${k}`, entry: e });
  for (const [k, e] of Object.entries(content.fields)) out.push({ where: `field ${k}`, entry: e });
  for (const [k, e] of Object.entries(content.modules ?? {})) out.push({ where: `module ${k}`, entry: e });
  for (const [r, g] of Object.entries(content.routes ?? {})) {
    for (const [k, e] of Object.entries(g.sections ?? {})) out.push({ where: `${r} section ${k}`, entry: e });
    for (const [k, e] of Object.entries(g.fields ?? {})) out.push({ where: `${r} field ${k}`, entry: e });
  }
  return out;
}

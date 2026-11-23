import { headerSimilarity, MASTER_LIST_INFO, type MasterList } from '@crew/contracts';
import { type ListEntry, matchEntry } from '../../master-data/master-data.service';
import { type Checked, issue, type ListNeed, type Lookups, type MappedRow } from './types';

/** The closest values of a list to what was typed, for "did you mean". */
export function closest(entries: ListEntry[], text: string): string | undefined {
  let best: { label: string; score: number } | undefined;
  for (const e of entries) {
    if (e.disabled) continue;
    const score = headerSimilarity(text, e.label);
    if (score >= 0.6 && (!best || score > best.score)) best = { label: e.label, score };
  }
  return best?.label;
}

/**
 * A cell that takes a master data value: the value it means, or a problem. A value not in the list is added when
 * the person may add to that list and chose to (a warning says so); otherwise it is an error with the nearest
 * value as the suggestion. Disabled values are never used for new data.
 */
export function listValue(r: MappedRow, field: string, list: MasterList, lk: Lookups, c: Checked, needs: ListNeed[], text = r.values[field] ?? ''): ListEntry | 'new' | null {
  const v = text.replace(/\s+/g, ' ').trim();
  if (!v) return null;
  const entries = lk.lists.get(list) ?? [];
  const hit = matchEntry(entries, v);
  const name = MASTER_LIST_INFO[list].label.toLowerCase();
  if (hit && !hit.disabled) return hit;
  if (hit?.disabled) {
    c.issues.push(issue(r, field, 'error', `${hit.label} is disabled in ${MASTER_LIST_INFO[list].label}`, 'Enable it in Settings > Master data, or use another value'));
    return null;
  }
  if (lk.mayAdd.has(list)) {
    if (!needs.some((n) => n.list === list && n.label.toLowerCase() === v.toLowerCase())) needs.push({ list, label: v });
    c.issues.push(issue(r, field, 'warning', `${v} is new and will be added to ${name}`));
    return 'new';
  }
  const near = closest(entries, v);
  c.issues.push(issue(r, field, 'error', `${v} is not in ${name}`, near ? `Did you mean ${near}?` : `Add it in Settings > Master data first, or use a value from the list`));
  return null;
}

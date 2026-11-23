import { CRM_DEFAULT_COLUMNS, CRM_LIST_COLUMNS, CRM_SORTS, type ViewState } from '@crew/contracts';

/** Filters the All Candidates list keeps in the address bar (and in saved views). */
export const CRM_FILTERS = [
  'q', 'stage', 'source', 'recruiter', 'hrWorkspace', 'location', 'skills', 'referenceType', 'tag', 'minExp', 'maxExp', 'minExpected', 'maxExpected', 'maxNotice', 'followUp', 'archived',
] as const;
export type CrmFilter = (typeof CRM_FILTERS)[number];
export type CrmSearch = Partial<Record<CrmFilter | 'sort' | 'dir' | 'cols' | 'density' | 'view' | 'page', string>> & Record<string, string | undefined>;
export const PAGE_SIZE = 50;
const NUMERIC = new Set(['minExp', 'maxExp', 'minExpected', 'maxExpected', 'maxNotice']);
const COLUMN_KEYS = ['name', ...CRM_LIST_COLUMNS.map((c) => c[0])] as string[];

/** The list state from the address bar. Custom field filters travel as cf.<key>. */
export function crmState(sp: CrmSearch): ViewState {
  const filters: Record<string, string> = {};
  for (const k of CRM_FILTERS) {
    const v = sp[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (NUMERIC.has(k) && !/^\d{1,12}(\.\d{1,2})?$/.test(v.trim())) continue;
    if (k === 'followUp' && !['due', 'overdue', 'today', 'none', 'any'].includes(v)) continue;
    if (k === 'archived' && !['only', 'include'].includes(v)) continue;
    filters[k] = v.trim().slice(0, 200);
  }
  for (const [k, v] of Object.entries(sp)) if (k.startsWith('cf.') && /^cf\.[a-z][a-z0-9_]{1,40}$/.test(k) && v) filters[k] = v.slice(0, 200);
  const cols = (sp.cols ?? '').split(',').filter((c) => COLUMN_KEYS.includes(c));
  return {
    filters,
    sort: (CRM_SORTS as readonly string[]).includes(sp.sort ?? '') ? sp.sort : 'recent',
    dir: sp.dir === 'asc' ? 'asc' : sp.dir === 'desc' ? 'desc' : undefined,
    columns: cols.length ? (cols.includes('name') ? cols : ['name', ...cols]) : ['name', ...CRM_DEFAULT_COLUMNS],
    density: sp.density === 'compact' ? 'compact' : 'comfortable',
  };
}

export function crmViewUrl(s: ViewState, viewId?: string | null, page?: number) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(s.filters ?? {})) if (v) qs.set(k, v);
  if (s.sort && s.sort !== 'recent') qs.set('sort', s.sort);
  if (s.dir) qs.set('dir', s.dir);
  if (s.columns && s.columns.join(',') !== ['name', ...CRM_DEFAULT_COLUMNS].join(',')) qs.set('cols', s.columns.join(','));
  if (s.density === 'compact') qs.set('density', 'compact');
  if (page && page > 1) qs.set('page', String(page));
  qs.set('view', viewId ?? 'all');
  return `/recruitment/crm/candidates?${qs}`;
}

/** The API query for a list state. */
export function crmQuery(s: ViewState, page = 1) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(s.filters ?? {})) if (v) qs.set(k, v);
  qs.set('sort', s.sort ?? 'recent');
  if (s.dir) qs.set('dir', s.dir);
  qs.set('limit', String(PAGE_SIZE));
  qs.set('offset', String((page - 1) * PAGE_SIZE));
  return qs;
}

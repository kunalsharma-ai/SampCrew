import { CANDIDATE_SORTS, type ViewState } from '@crew/contracts';

export const CANDIDATE_COLUMNS = ['name', 'role', 'email', 'location', 'jobs', 'source', 'tags', 'added', 'activity'] as const;
export const DEFAULT_CANDIDATE_COLUMNS = ['name', 'jobs', 'source', 'activity'];
export const CANDIDATE_FILTERS = ['q', 'tag', 'requisitionId', 'source', 'status'] as const;
const STATUSES = ['active', 'rejected', 'withdrawn', 'hired', 'none'];
const SOURCES = ['career_site', 'referral', 'agency', 'sourced', 'manual'];

export type CandidateSearch = Partial<Record<(typeof CANDIDATE_FILTERS)[number] | 'sort' | 'dir' | 'cols' | 'density' | 'view', string>>;

/** The list state lives in the address bar, so a view can be bookmarked, shared and restored after a reload. */
export function candidateState(sp: CandidateSearch): ViewState {
  const filters: Record<string, string> = {};
  if (sp.q) filters.q = sp.q.slice(0, 120);
  if (sp.tag) filters.tag = sp.tag.slice(0, 30);
  if (sp.requisitionId && /^[0-9a-f-]{36}$/.test(sp.requisitionId)) filters.requisitionId = sp.requisitionId;
  if (sp.source && SOURCES.includes(sp.source)) filters.source = sp.source;
  if (sp.status && STATUSES.includes(sp.status)) filters.status = sp.status;
  const cols = (sp.cols ?? '').split(',').filter((c) => (CANDIDATE_COLUMNS as readonly string[]).includes(c));
  return {
    filters,
    sort: (CANDIDATE_SORTS as readonly string[]).includes(sp.sort ?? '') ? sp.sort : 'activity',
    dir: sp.dir === 'asc' ? 'asc' : 'desc',
    columns: cols.length ? (cols.includes('name') ? cols : ['name', ...cols]) : DEFAULT_CANDIDATE_COLUMNS,
    density: sp.density === 'compact' ? 'compact' : 'comfortable',
  };
}

/** The address for a list state (and the saved view it came from, if any). */
export function candidateViewUrl(s: ViewState, viewId?: string | null) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(s.filters ?? {})) if (v && (CANDIDATE_FILTERS as readonly string[]).includes(k)) qs.set(k, v);
  if (s.sort && s.sort !== 'activity') qs.set('sort', s.sort);
  if (s.dir === 'asc') qs.set('dir', 'asc');
  if (s.columns && s.columns.join(',') !== DEFAULT_CANDIDATE_COLUMNS.join(',')) qs.set('cols', s.columns.join(','));
  if (s.density === 'compact') qs.set('density', 'compact');
  qs.set('view', viewId ?? 'all');
  return `/recruitment/candidates?${qs}`;
}

/** The query the API takes for the same filters and order (used for the list and its exports). */
export function candidateQuery(s: ViewState) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(s.filters ?? {})) if (v) qs.set(k, v);
  qs.set('sort', s.sort ?? 'activity');
  qs.set('dir', s.dir ?? 'desc');
  return qs;
}

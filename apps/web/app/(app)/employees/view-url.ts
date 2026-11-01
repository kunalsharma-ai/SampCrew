import type { ViewState } from '@crew/contracts';

export const DEFAULT_COLUMNS = ['name', 'code', 'department', 'location', 'manager', 'joined', 'status'];

/** The address for a table state (and the saved view it came from, if any). */
export function viewUrl(s: ViewState, viewId?: string | null) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(s.filters ?? {})) if (v) qs.set(k, v);
  if (s.sort && s.sort !== 'name') qs.set('sort', s.sort);
  if (s.dir === 'desc') qs.set('dir', 'desc');
  if (s.columns && s.columns.join(',') !== DEFAULT_COLUMNS.join(',')) qs.set('cols', s.columns.join(','));
  if (s.density === 'compact') qs.set('density', 'compact');
  qs.set('view', viewId ?? 'all');
  return `/employees?${qs}`;
}

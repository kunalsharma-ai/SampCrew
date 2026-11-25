import type { Department, Location } from '@/lib/types';

/** The shared filter bar of the workforce pages (a plain GET form, so a filtered view can be shared as a link). */
export function WorkforceFilters({ path, values, departments, designations, locations, spaces, keep = {}, dateMode = 'day', extra }: {
  path: string;
  values: Record<string, string | undefined>;
  departments: Department[];
  designations: { id: string; name: string }[];
  locations: Location[];
  spaces: { id: string; name: string }[];
  keep?: Record<string, string | undefined>;
  dateMode?: 'day' | 'range';
  extra?: React.ReactNode;
}) {
  const sel = 'h-9 max-w-[12rem] rounded-md border border-border bg-surface px-2';
  return (
    <form action={path} className="mb-5 flex flex-wrap items-end gap-3 text-sm" data-testid="workforce-filters">
      {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
      {dateMode === 'day' ? (
        <label className="grid gap-1"><span className="text-xs text-fg-muted">Date</span><input className="h-9 rounded-md border border-border bg-surface px-2" type="date" name="date" defaultValue={values.date ?? ''} /></label>
      ) : (
        <>
          <label className="grid gap-1"><span className="text-xs text-fg-muted">From</span><input className="h-9 rounded-md border border-border bg-surface px-2" type="date" name="from" defaultValue={values.from ?? ''} /></label>
          <label className="grid gap-1"><span className="text-xs text-fg-muted">To</span><input className="h-9 rounded-md border border-border bg-surface px-2" type="date" name="to" defaultValue={values.to ?? ''} /></label>
        </>
      )}
      <label className="grid gap-1"><span className="text-xs text-fg-muted">Employee</span><input className="h-9 w-44 rounded-md border border-border bg-surface px-2" type="search" name="q" placeholder="Name or ID" defaultValue={values.q ?? ''} /></label>
      {departments.length > 0 && (
        <label className="grid gap-1"><span className="text-xs text-fg-muted">Department</span>
          <select className={sel} name="departmentId" defaultValue={values.departmentId ?? ''}><option value="">All</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      )}
      {designations.length > 0 && (
        <label className="grid gap-1"><span className="text-xs text-fg-muted">Designation</span>
          <select className={sel} name="designationId" defaultValue={values.designationId ?? ''}><option value="">All</option>{designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      )}
      {locations.length > 0 && (
        <label className="grid gap-1"><span className="text-xs text-fg-muted">Office</span>
          <select className={sel} name="locationId" defaultValue={values.locationId ?? ''}><option value="">All</option>{locations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      )}
      {spaces.length > 0 && (
        <label className="grid gap-1"><span className="text-xs text-fg-muted">HR Workspace</span>
          <select className={sel} name="hrWorkspaceId" defaultValue={values.hrWorkspaceId ?? ''}><option value="">All</option><option value="central">Central group</option>{spaces.filter((s) => s.id !== 'central').map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      )}
      <label className="grid gap-1"><span className="text-xs text-fg-muted">Workspace level</span>
        <select className={sel} name="level" defaultValue={values.level ?? ''}><option value="">All</option><option value="super">Super Workspace</option><option value="hr">HR Workspace</option><option value="employee">Employee Workspace</option></select></label>
      {extra}
      <button className="h-9 rounded-md bg-accent px-3 font-medium text-accent-fg hover:opacity-90" type="submit">Apply</button>
      <a className="h-9 content-center rounded-md px-2 font-medium text-fg-muted hover:text-fg" href={path}>Clear</a>
    </form>
  );
}

export const FILTER_KEYS = ['departmentId', 'designationId', 'locationId', 'hrWorkspaceId', 'level', 'q', 'employeeId'] as const;
export function pickFilters(sp: Record<string, string | undefined>) {
  const out: Record<string, string | undefined> = {};
  for (const k of FILTER_KEYS) {
    const v = sp[k]?.trim();
    if (!v) continue;
    if (k === 'level' && !['super', 'hr', 'employee'].includes(v)) continue;
    if (k !== 'q' && k !== 'level' && k !== 'hrWorkspaceId' && !/^[0-9a-f-]{36}$/i.test(v)) continue;
    out[k] = v.slice(0, 100);
  }
  return out;
}
export const toQs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

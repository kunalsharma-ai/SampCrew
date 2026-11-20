'use client';
import { ACCESS_AREAS, type MemberAccess, type SetAccessRequest } from '@crew/contracts';
import { Alert, Badge, Checkbox, Field, Select } from '@crew/ui';

/** The four access categories, with Console Admin kept apart: it runs SampCrew itself and is never given here. */
export const LEVEL_OPTIONS: { value: SetAccessRequest['level']; label: string; hint: string }[] = [
  { value: 'employee', label: 'Employee Workspace', hint: 'Their own profile, leave, attendance, payslips and requests. People who report to them show up for approvals.' },
  { value: 'hr', label: 'HR Workspace', hint: 'Runs HR for the whole company, or only for the HR Workspaces you choose, in the areas you choose.' },
  { value: 'super', label: 'Super Workspace', hint: 'Runs the whole company: settings, billing, every HR Workspace and every person.' },
];

export function accessFromMember(a: MemberAccess | undefined): SetAccessRequest {
  if (!a) return { level: 'employee' };
  return { level: a.level, hrWorkspaceIds: a.hrWorkspaces.map((w) => w.id), legalEntityIds: a.legalEntityIds, departmentIds: a.departmentIds, areas: a.areas, viewAreas: a.viewAreas, auditTrail: a.auditTrail };
}

/** Only the fields that apply to the level, so the request stays small and clear. */
export function accessBody(v: SetAccessRequest): SetAccessRequest {
  if (v.level === 'employee') return { level: 'employee' };
  const out: SetAccessRequest = { level: v.level };
  if (v.areas?.length) out.areas = v.areas;
  if (v.viewAreas?.length) out.viewAreas = v.viewAreas;
  if (v.auditTrail && (v.areas?.length || v.viewAreas?.length)) out.auditTrail = true;
  if (v.level === 'hr') {
    if (v.hrWorkspaceIds?.length) out.hrWorkspaceIds = v.hrWorkspaceIds;
    if (v.legalEntityIds?.length) out.legalEntityIds = v.legalEntityIds;
    if (v.departmentIds?.length) out.departmentIds = v.departmentIds;
  }
  return out;
}

export function AccessLabel({ access }: { access: MemberAccess | undefined }) {
  if (!access) return <span className="text-xs text-fg-subtle">Employee Workspace</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge tone={access.level === 'employee' ? 'neutral' : 'accent'}>{access.label}</Badge>
      {access.hrWorkspaces.map((w) => <span key={w.id} className="text-xs text-fg-subtle">{w.name}</span>)}
    </div>
  );
}

interface EditorProps {
  value: SetAccessRequest;
  onChange: (v: SetAccessRequest) => void;
  /** Only a Super Workspace person can give Super Workspace access. */
  canGiveSuper: boolean;
  hrWorkspaces: { id: string; name: string }[];
  entities: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  current?: MemberAccess;
  disabled?: boolean;
}

const toggle = (list: string[] | undefined, item: string, on: boolean) => (on ? [...new Set([...(list ?? []), item])] : (list ?? []).filter((x) => x !== item));

/** Choose a person's workspace access: the level, and for HR Workspace the HR Workspaces, records and areas it covers. */
export function AccessEditor({ value, onChange, canGiveSuper, hrWorkspaces, entities, departments, current, disabled }: EditorProps) {
  const set = (patch: Partial<SetAccessRequest>) => onChange({ ...value, ...patch });
  const levels = LEVEL_OPTIONS.filter((l) => l.value !== 'super' || canGiveSuper || value.level === 'super');
  const hint = LEVEL_OPTIONS.find((l) => l.value === value.level)?.hint;
  const kept = current?.keptAccess ?? [];
  const areasTouched = Boolean(value.areas?.length || value.viewAreas?.length);
  return (
    <div className="flex flex-col gap-4" data-testid="access-editor">
      <Field label="Workspace access" hint={hint}>
        {(p) => (
          <Select {...p} value={value.level} disabled={disabled} onChange={(e) => set({ level: e.target.value as SetAccessRequest['level'] })} data-testid="access-level">
            {levels.map((l) => <option key={l.value} value={l.value} disabled={l.value === 'super' && !canGiveSuper}>{l.label}</option>)}
          </Select>
        )}
      </Field>
      {current?.fromGroup && <Alert tone="info">This access comes from a provisioning group in your identity provider. Change it there.</Alert>}

      {value.level === 'hr' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="HR Workspaces" hint="Leave all unticked to cover the whole company." className="sm:col-span-2">
            {() => (
              <div className="grid gap-2 sm:grid-cols-2">
                {hrWorkspaces.length ? hrWorkspaces.map((w) => (
                  <Checkbox key={w.id} label={w.name} disabled={disabled} checked={Boolean(value.hrWorkspaceIds?.includes(w.id))} onChange={(e) => set({ hrWorkspaceIds: toggle(value.hrWorkspaceIds, w.id, e.target.checked) })} />
                )) : <p className="text-xs text-fg-subtle">No active HR Workspaces yet. This person covers the whole company.</p>}
              </div>
            )}
          </Field>
          <Field label="Only people in these legal entities" hint="Optional.">
            {() => (
              <div className="flex flex-col gap-2">
                {entities.map((e) => <Checkbox key={e.id} label={e.name} disabled={disabled} checked={Boolean(value.legalEntityIds?.includes(e.id))} onChange={(ev) => set({ legalEntityIds: toggle(value.legalEntityIds, e.id, ev.target.checked) })} />)}
                {!entities.length && <p className="text-xs text-fg-subtle">No legal entities yet.</p>}
              </div>
            )}
          </Field>
          <Field label="Only people in these departments" hint="Optional.">
            {() => (
              <div className="flex max-h-40 flex-col gap-2 overflow-y-auto">
                {departments.map((d) => <Checkbox key={d.id} label={d.name} disabled={disabled} checked={Boolean(value.departmentIds?.includes(d.id))} onChange={(ev) => set({ departmentIds: toggle(value.departmentIds, d.id, ev.target.checked) })} />)}
                {!departments.length && <p className="text-xs text-fg-subtle">No departments yet.</p>}
              </div>
            )}
          </Field>
        </div>
      )}

      {value.level !== 'employee' && (
        <div className="flex flex-col gap-2">
          <p className="text-[0.8125rem] font-medium">Areas <span className="font-normal text-fg-subtle">(leave all unticked for every area of this level)</span></p>
          {!areasTouched && kept.length > 0 && (
            <Alert tone="info">
              Kept from before: {kept.map((k) => `${k.area} (${k.actions.join(', ')})`).join('; ')}. Ticking areas below replaces it.
            </Alert>
          )}
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-[0.8125rem]">
              <thead className="bg-surface text-xs text-fg-subtle"><tr><th className="px-3 py-1.5 text-left font-medium">Area</th><th className="px-3 py-1.5 font-medium">Full</th><th className="px-3 py-1.5 font-medium">View only</th></tr></thead>
              <tbody>
                {ACCESS_AREAS.map((a) => {
                  const full = Boolean(value.areas?.includes(a));
                  const view = !full && Boolean(value.viewAreas?.includes(a));
                  return (
                    <tr key={a} className="border-t border-border">
                      <td className="px-3 py-1.5">{a}</td>
                      <td className="px-3 py-1.5 text-center"><input type="checkbox" aria-label={`${a} full`} disabled={disabled} checked={full} onChange={(e) => set({ areas: toggle(value.areas, a, e.target.checked), viewAreas: toggle(value.viewAreas, a, false) })} /></td>
                      <td className="px-3 py-1.5 text-center"><input type="checkbox" aria-label={`${a} view only`} disabled={disabled} checked={view} onChange={(e) => set({ viewAreas: toggle(value.viewAreas, a, e.target.checked), areas: toggle(value.areas, a, false) })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Checkbox label="Can read the audit trail" description="Only with chosen areas. Without areas, the level decides." disabled={disabled || !areasTouched} checked={Boolean(value.auditTrail)} onChange={(e) => set({ auditTrail: e.target.checked })} />
        </div>
      )}
    </div>
  );
}

'use client';
import { LEAVE_EMPLOYMENT_TYPE_LABELS, LEAVE_EMPLOYMENT_TYPES, type LeaveEmploymentType } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { LeaveAllocation, LeaveType } from '@/lib/types';
import { allocateAction, previewAllocationAction, revokeAllocationAction } from './actions';
import { ChipPicker, type LeaveOptions, PeoplePicker } from './pickers';
import { byLine, eligibilityText } from './policy-text';

interface Criteria { all: boolean; employmentTypes: LeaveEmploymentType[]; departmentIds: string[]; designationIds: string[]; locationIds: string[]; legalEntityIds: string[]; groupIds: string[]; employeeIds: string[] }
const NONE: Criteria = { all: false, employmentTypes: [], departmentIds: [], designationIds: [], locationIds: [], legalEntityIds: [], groupIds: [], employeeIds: [] };
const empty = (c: Criteria) => !c.all && !c.employmentTypes.length && !c.departmentIds.length && !c.designationIds.length && !c.locationIds.length && !c.legalEntityIds.length && !c.groupIds.length && !c.employeeIds.length;

/**
 * Allocation, separate from creating a type. The Super Workspace gives a type to employees (everyone eligible, or by
 * employment type, department, designation, location, group or name) or makes it available to an HR Workspace; an HR
 * Workspace gives the types made available to it to its own people, inside each type's eligibility.
 */
export function AllocationPanel({ types, allocations, options }: { types: LeaveType[]; allocations: LeaveAllocation[]; options: LeaveOptions }) {
  const router = useRouter();
  const isSuper = options.level === 'super';
  const active = types.filter((t) => t.active);
  // The HR Workspaces this person acts for: their own (or the company HR team).
  const acting = isSuper ? [{ id: '', name: 'Super Workspace (any eligible employee)' }] : [...(options.companyHr ? [{ id: '', name: 'Company HR team' }] : []), ...options.hrWorkspaces];
  const [target, setTarget] = useState<'employees' | 'hr_workspace'>('employees');
  const [typeId, setTypeId] = useState(active[0]?.id ?? '');
  const [hrWs, setHrWs] = useState(acting[0]?.id ?? '');
  const [toWs, setToWs] = useState<string>('');
  const [criteria, setCriteria] = useState<Criteria>({ ...NONE, all: true });
  const [entitlement, setEntitlement] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<{ count: number; people: { id: string; name: string; code: string }[] } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const type = active.find((t) => t.id === typeId);
  const available = (t: LeaveType) => isSuper || t.allocations.hrWorkspaces.some((w) => (w.id ?? '') === hrWs);
  const choosable = active.filter(available);
  const set = <K extends keyof Criteria>(k: K, v: Criteria[K]) => setCriteria((c) => ({ ...c, all: false, [k]: v }));
  const people = options.employees.filter((e) => isSuper || !hrWs || e.hrWorkspaceId === hrWs);
  const body = () => target === 'hr_workspace'
    ? { target, leaveTypeId: typeId, hrWorkspaceId: toWs || null, note }
    : { target, leaveTypeId: typeId, hrWorkspaceId: hrWs || null, criteria, entitlementDays: entitlement.trim() || null, note };

  useEffect(() => {
    if (!choosable.some((t) => t.id === typeId)) setTypeId(choosable[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hrWs]);
  const key = JSON.stringify([target, typeId, hrWs, criteria]);
  useEffect(() => {
    if (target !== 'employees' || !typeId || empty(criteria)) { setPreview(null); setPreviewError(null); return; }
    let live = true;
    const t = setTimeout(async () => {
      const r = await previewAllocationAction(body());
      if (!live) return;
      if (r.ok) { setPreview(r.data!); setPreviewError(null); } else { setPreview(null); setPreviewError(r.message); }
    }, 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const submit = () => start(async () => {
    const r = await allocateAction(body());
    if (r.ok) {
      const a = r.data!;
      setNotice({ tone: 'success', text: a.target === 'hr_workspace' ? `${a.leaveTypeName} is now available to ${a.hrWorkspaceName}.` : `${a.leaveTypeName} allocated to ${a.reach ?? 0} ${a.reach === 1 ? 'person' : 'people'}. They have been told.` });
      setNote(''); setEntitlement('');
      router.refresh();
    } else setNotice({ tone: 'danger', text: r.message });
  });

  return (
    <div className="grid gap-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Allocate leave" description={isSuper ? 'Give a leave type to people, or make it available to an HR Workspace so it can allocate it and review its people’s applications.' : 'Give the leave types the Super Workspace made available to you to your own people. You cannot go outside a type’s eligibility.'} />
        <CardBody className="grid gap-4" data-testid="allocation-form">
          {isSuper && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Allocate to">
              {(['employees', 'hr_workspace'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={target === k} onClick={() => setTarget(k)} data-testid={`allocate-to-${k}`}
                  className={`min-h-10 rounded-lg border px-3 py-2 text-sm ${target === k ? 'border-accent bg-accent-subtle font-medium' : 'border-border text-fg-muted'}`}>
                  {k === 'employees' ? 'To employees' : 'Make available to an HR Workspace'}
                </button>
              ))}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {!isSuper && acting.length > 1 && (
              <Field label="For HR Workspace">{(p) => <Select {...p} value={hrWs} onChange={(e) => setHrWs(e.target.value)}>{acting.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
            )}
            <Field label="Leave type" required>{(p) => (
              <Select {...p} name="leaveTypeId" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
                {!choosable.length && <option value="">No leave type available</option>}
                {choosable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.code})</option>)}
              </Select>
            )}</Field>
            {target === 'hr_workspace' ? (
              <Field label="HR Workspace" required>{(p) => (
                <Select {...p} value={toWs} onChange={(e) => setToWs(e.target.value)}>
                  <option value="">Company HR team</option>
                  {options.hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              )}</Field>
            ) : (
              <Field label="Days a year for these people" hint={type ? `Empty: the type’s ${type.policy.annualEntitlement} days` : undefined}>{(p) => <Input {...p} inputMode="decimal" value={entitlement} onChange={(e) => setEntitlement(e.target.value)} placeholder={type?.policy.annualEntitlement} />}</Field>
            )}
          </div>
          {type && <p className="text-xs text-fg-subtle">Eligibility set by the Super Workspace: {eligibilityText(type, options)}</p>}
          {target === 'employees' && (
            <div className="grid gap-4 rounded-lg border border-border p-3">
              <Checkbox label={isSuper ? 'Everyone eligible' : 'Everyone eligible in this HR Workspace'} checked={criteria.all} onChange={(e) => setCriteria(e.target.checked ? { ...NONE, all: true } : NONE)} />
              {!criteria.all && (
                <>
                  <fieldset className="grid gap-1.5">
                    <legend className="mb-1 text-xs font-medium">Employment types</legend>
                    <div className="flex flex-wrap gap-3">
                      {LEAVE_EMPLOYMENT_TYPES.map((k) => <Checkbox key={k} label={LEAVE_EMPLOYMENT_TYPE_LABELS[k]} checked={criteria.employmentTypes.includes(k)} onChange={(e) => set('employmentTypes', e.target.checked ? [...criteria.employmentTypes, k] : criteria.employmentTypes.filter((x) => x !== k))} />)}
                    </div>
                  </fieldset>
                  <ChipPicker label="Departments" all={options.departments} chosen={criteria.departmentIds} onChange={(v) => set('departmentIds', v)} testId="alloc-departments" />
                  <ChipPicker label="Designations" all={options.designations} chosen={criteria.designationIds} onChange={(v) => set('designationIds', v)} />
                  <ChipPicker label="Locations" all={options.locations} chosen={criteria.locationIds} onChange={(v) => set('locationIds', v)} />
                  {options.legalEntities.length > 1 && <ChipPicker label="Legal entities" all={options.legalEntities} chosen={criteria.legalEntityIds} onChange={(v) => set('legalEntityIds', v)} />}
                  <ChipPicker label="Employee groups" all={options.groups} chosen={criteria.groupIds} onChange={(v) => set('groupIds', v)} />
                  <PeoplePicker label="Selected employees" people={people} chosen={criteria.employeeIds} onChange={(v) => set('employeeIds', v)} testId="alloc-people" />
                  <p className="text-xs text-fg-subtle">Each list narrows who it reaches; selected employees are added to the rest.</p>
                </>
              )}
              <div aria-live="polite" data-testid="allocation-preview">
                {previewError ? <Alert tone="warning">{previewError}</Alert> : preview && (
                  <p className="text-sm"><strong>{preview.count}</strong> {preview.count === 1 ? 'person' : 'people'} would get it{preview.people.length ? `: ${preview.people.slice(0, 12).map((p) => p.name).join(', ')}${preview.count > 12 ? ` and ${preview.count - 12} more` : ''}` : ''}.</p>
                )}
              </div>
            </div>
          )}
          <Field label="Note">{(p) => <Input {...p} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why, or for whom (optional)" />}</Field>
          <div><Button onClick={submit} loading={pending} disabled={!typeId || !!previewError || (target === 'employees' && empty(criteria))} data-testid="allocate">{target === 'hr_workspace' ? 'Make available' : 'Allocate'}</Button></div>
        </CardBody>
      </Card>
      <AllocationsList allocations={allocations} canRevoke={(a) => isSuper || a.byLevel === 'hr'} />
    </div>
  );
}

function AllocationsList({ allocations, canRevoke }: { allocations: LeaveAllocation[]; canRevoke: (a: LeaveAllocation) => boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Current allocations" description="Who holds each leave type and who gave it. Withdrawing one keeps the leave already taken." />
      {error && <div className="px-5"><Alert tone="danger">{error}</Alert></div>}
      {allocations.length ? (
        <Table aria-label="Current allocations">
          <THead><tr><TH>Leave type</TH><TH>To</TH><TH>Days a year</TH><TH>Reaches</TH><TH>Allocated by</TH><TH /></tr></THead>
          <TBody>
            {allocations.map((a) => (
              <TR key={a.id}>
                <TD className="font-medium">{a.leaveTypeName} <Badge>{a.leaveTypeCode}</Badge></TD>
                <TD className="min-w-48 text-sm">{a.target === 'hr_workspace' ? <><Badge tone="accent">HR Workspace</Badge> {a.hrWorkspaceName}</> : <>{a.summary}{a.hrWorkspaceName ? <span className="block text-xs text-fg-subtle">For {a.hrWorkspaceName}</span> : null}</>}{a.note && <span className="block text-xs text-fg-subtle">{a.note}</span>}</TD>
                <TD className="tabular-nums">{a.entitlementDays ?? (a.target === 'employees' ? 'Type’s' : '—')}</TD>
                <TD className="tabular-nums">{a.reach ?? '—'}</TD>
                <TD className="min-w-40 text-xs text-fg-muted">{byLine({ name: a.byName, level: a.byLevel, at: a.createdAt })}</TD>
                <TD>{canRevoke(a) && <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                  const reason = prompt('Why is this allocation withdrawn?');
                  if (!reason || reason.trim().length < 3) return;
                  start(async () => { const r = await revokeAllocationAction(a.id, reason.trim()); if (r.ok) router.refresh(); else setError(r.message); });
                }}>Withdraw</Button>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="Nothing allocated yet" description="A leave type reaches nobody until it is allocated." />}
    </Card>
  );
}

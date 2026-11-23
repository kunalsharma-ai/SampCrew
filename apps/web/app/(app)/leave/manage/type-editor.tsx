'use client';
import {
  ACCRUAL_METHOD_LABELS, ACCRUAL_METHODS, LEAVE_AUTHORITIES, LEAVE_AUTHORITY_LABELS, LEAVE_CATEGORIES, LEAVE_CATEGORY_LABELS, LEAVE_EMPLOYMENT_TYPE_LABELS,
  LEAVE_EMPLOYMENT_TYPES, LEAVE_TYPE_KIND_LABELS, LEAVE_TYPE_KINDS, leaveApprovalRules, leaveEligibility, leaveTypePolicy,
  type LeaveApprovalRules, type LeaveEligibility, type LeaveTypePolicy,
} from '@crew/contracts';
import { Alert, Button, Checkbox, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import type { LeaveType } from '@/lib/types';
import { createLeaveTypeAction, updateLeaveTypeAction } from './actions';
import { ChipPicker, type LeaveOptions, PeoplePicker } from './pickers';

interface Form {
  code: string; name: string; description: string; category: string; paid: boolean; allowHalfDay: boolean; color: string; kind: string;
  eligibleGender: string; countsCalendarDays: boolean; effectiveFrom: string; active: boolean; hrAllocatable: boolean;
  eligibility: LeaveEligibility; policy: LeaveTypePolicy; approval: LeaveApprovalRules; note: string;
}

const blank = (): Form => ({
  code: '', name: '', description: '', category: 'general', paid: true, allowHalfDay: true, color: '#4f46e5', kind: 'standard', eligibleGender: 'any',
  countsCalendarDays: false, effectiveFrom: '', active: true, hrAllocatable: true,
  eligibility: leaveEligibility.parse({}), policy: leaveTypePolicy.parse({}), approval: leaveApprovalRules.parse({}), note: '',
});
const fromType = (t: LeaveType): Form => ({
  code: t.code, name: t.name, description: t.description ?? '', category: t.category, paid: t.paid, allowHalfDay: t.allowHalfDay, color: t.color, kind: t.kind,
  eligibleGender: t.eligibleGender, countsCalendarDays: t.countsCalendarDays, effectiveFrom: t.effectiveFrom ?? '', active: t.active, hrAllocatable: t.hrAllocatable,
  eligibility: t.eligibility, policy: t.policy, approval: t.approval, note: '',
});

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {description && <p className="-mt-2 text-xs text-fg-subtle sm:col-span-2">{description}</p>}
      {children}
    </fieldset>
  );
}

/** Optional number of days: empty means "no limit". */
function DaysInput({ value, onChange, ...p }: { value: string | null; onChange: (v: string | null) => void; id: string; placeholder?: string }) {
  return <Input {...p} inputMode="decimal" value={value ?? ''} placeholder={p.placeholder ?? 'No limit'} onChange={(e) => onChange(e.target.value.trim() === '' ? null : e.target.value.trim())} />;
}

/**
 * Creating or editing a leave type (Super Workspace): its basics, who it may ever be given to, its policy and who
 * approves applications. A change applies to applications made from then on; approved leave keeps its rules.
 */
export function LeaveTypeEditor({ open, onClose, type, options }: { open: boolean; onClose: () => void; type?: LeaveType; options: LeaveOptions }) {
  const router = useRouter();
  const [f, setF] = useState<Form>(type ? fromType(type) : blank());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const pol = <K extends keyof LeaveTypePolicy>(k: K, v: LeaveTypePolicy[K]) => setF((x) => ({ ...x, policy: { ...x.policy, [k]: v } }));
  const appr = <K extends keyof LeaveApprovalRules>(k: K, v: LeaveApprovalRules[K]) => setF((x) => ({ ...x, approval: { ...x.approval, [k]: v } }));
  const elig = <K extends keyof LeaveEligibility>(k: K, v: LeaveEligibility[K]) => setF((x) => ({ ...x, eligibility: { ...x.eligibility, [k]: v } }));
  const routes = f.approval.routes;
  const toggleRoute = (r: (typeof LEAVE_AUTHORITIES)[number]) => appr('routes', routes.includes(r) ? routes.filter((x) => x !== r) : [...routes, r]);

  const submit = () => {
    setError(null);
    if (!f.approval.routes.length) { setError('Choose at least one approval route.'); return; }
    const body: Record<string, unknown> = {
      code: f.code, name: f.name, description: f.description.trim() || (type ? null : undefined), category: f.category, paid: f.paid, allowHalfDay: f.allowHalfDay,
      color: f.color, kind: f.kind, eligibleGender: f.eligibleGender, countsCalendarDays: f.countsCalendarDays, effectiveFrom: f.effectiveFrom || null,
      hrAllocatable: f.hrAllocatable, eligibility: f.eligibility, policy: f.policy,
      approval: { ...f.approval, employeeChooses: f.approval.employeeChooses && f.approval.routes.length > 1 },
    };
    if (!type) body.active = f.active;
    else { body.version = type.version; if (f.note.trim()) body.note = f.note.trim(); }
    start(async () => {
      const r = type ? await updateLeaveTypeAction(type.id, body) : await createLeaveTypeAction(body);
      if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
    });
  };

  return (
    <Dialog open={open} onClose={onClose} size="lg" title={type ? `Edit ${type.name}` : 'New leave type'}
      description={type ? `Version ${type.version}. Changes apply to applications made from now on; approved leave keeps the rules it was approved under.` : 'Only name and code are needed; every other setting has a sensible default you can change later.'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={pending} data-testid="leave-type-save">{type ? 'Save changes' : 'Create leave type'}</Button></>}>
      <div className="grid gap-5" data-testid="leave-type-editor">
        {error && <Alert tone="danger">{error}</Alert>}
        <Section title="Basics">
          <Field label="Leave name" required>{(p) => <Input {...p} name="name" value={f.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />}</Field>
          <Field label="Leave code" required hint="Up to 12 capital letters or digits, like CL">{(p) => <Input {...p} name="code" value={f.code} maxLength={12} onChange={(e) => set('code', e.target.value.toUpperCase())} />}</Field>
          <Field label="Description" className="sm:col-span-2">{(p) => <Textarea {...p} name="description" value={f.description} maxLength={500} onChange={(e) => set('description', e.target.value)} />}</Field>
          <Field label="Leave category">{(p) => <Select {...p} value={f.category} onChange={(e) => set('category', e.target.value)}>{LEAVE_CATEGORIES.map((c) => <option key={c} value={c}>{LEAVE_CATEGORY_LABELS[c]}</option>)}</Select>}</Field>
          <Field label="Kind">{(p) => <Select {...p} value={f.kind} onChange={(e) => set('kind', e.target.value)}>{LEAVE_TYPE_KINDS.map((k) => <option key={k} value={k}>{LEAVE_TYPE_KIND_LABELS[k]}</option>)}</Select>}</Field>
          <Field label="Effective from" hint="Applications can start on or after this date. Empty: at once.">{(p) => <Input {...p} type="date" value={f.effectiveFrom} onChange={(e) => set('effectiveFrom', e.target.value)} />}</Field>
          <Field label="Colour">{(p) => <Input {...p} type="color" value={f.color} onChange={(e) => set('color', e.target.value)} className="h-10 w-20 p-1" />}</Field>
          <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
            <Checkbox label="Paid leave" checked={f.paid} onChange={(e) => set('paid', e.target.checked)} />
            <Checkbox label="Half days allowed" checked={f.allowHalfDay} onChange={(e) => set('allowHalfDay', e.target.checked)} />
            <Checkbox label="Count calendar days" description="Weekly offs and holidays count too (usual for maternity leave)" checked={f.countsCalendarDays} onChange={(e) => set('countsCalendarDays', e.target.checked)} />
            <Checkbox label="HR Workspaces may allocate it" description="Off: only the Super Workspace gives it to people" checked={f.hrAllocatable} onChange={(e) => set('hrAllocatable', e.target.checked)} />
            {!type && <Checkbox label="Active" checked={f.active} onChange={(e) => set('active', e.target.checked)} />}
          </div>
        </Section>

        <Section title="Eligibility" description="Who this leave may ever be given to. Each list narrows it; leave a list empty for no limit. People named at the bottom are eligible whatever the lists say. HR Workspaces can never allocate outside this.">
          <fieldset className="grid gap-1.5 sm:col-span-2">
            <legend className="mb-1 text-xs font-medium">Employment types</legend>
            <div className="flex flex-wrap gap-3">
              {LEAVE_EMPLOYMENT_TYPES.map((k) => (
                <Checkbox key={k} label={LEAVE_EMPLOYMENT_TYPE_LABELS[k]} checked={f.eligibility.employmentTypes.includes(k)}
                  onChange={(e) => elig('employmentTypes', e.target.checked ? [...f.eligibility.employmentTypes, k] : f.eligibility.employmentTypes.filter((x) => x !== k))} />
              ))}
            </div>
          </fieldset>
          <Field label="Gender">{(p) => <Select {...p} value={f.eligibleGender} onChange={(e) => set('eligibleGender', e.target.value)}><option value="any">Everyone</option><option value="female">Women</option><option value="male">Men</option></Select>}</Field>
          <div className="sm:col-span-2 grid gap-4">
            <ChipPicker label="Departments" all={options.departments} chosen={f.eligibility.departmentIds} onChange={(v) => elig('departmentIds', v)} testId="elig-departments" />
            <ChipPicker label="Designations" all={options.designations} chosen={f.eligibility.designationIds} onChange={(v) => elig('designationIds', v)} />
            <ChipPicker label="Locations" all={options.locations} chosen={f.eligibility.locationIds} onChange={(v) => elig('locationIds', v)} />
            {options.legalEntities.length > 1 && <ChipPicker label="Legal entities" all={options.legalEntities} chosen={f.eligibility.legalEntityIds} onChange={(v) => elig('legalEntityIds', v)} />}
            <ChipPicker label="Employee groups" all={options.groups} chosen={f.eligibility.groupIds} onChange={(v) => elig('groupIds', v)} />
            <PeoplePicker label="Named employees" people={options.employees} chosen={f.eligibility.employeeIds} onChange={(v) => elig('employeeIds', v)} />
          </div>
        </Section>

        <Section title="Entitlement and rules">
          <Field label="Accrual">{(p) => <Select {...p} value={f.policy.accrualMethod} onChange={(e) => pol('accrualMethod', e.target.value as LeaveTypePolicy['accrualMethod'])}>{ACCRUAL_METHODS.map((m) => <option key={m} value={m}>{ACCRUAL_METHOD_LABELS[m]}</option>)}</Select>}</Field>
          <Field label="Days a year" hint="Allocations can give some people a different number">{(p) => <Input {...p} name="annualEntitlement" inputMode="decimal" value={f.policy.annualEntitlement} onChange={(e) => pol('annualEntitlement', e.target.value)} />}</Field>
          <Field label="Fewest days in one application">{(p) => <DaysInput {...p} value={f.policy.minDaysPerRequest} onChange={(v) => pol('minDaysPerRequest', v)} />}</Field>
          <Field label="Most days in one application">{(p) => <DaysInput {...p} value={f.policy.maxDaysPerRequest} onChange={(v) => pol('maxDaysPerRequest', v)} />}</Field>
          <Field label="Most consecutive days" hint="Calendar days from first to last, weekends included">{(p) => <DaysInput {...p} value={f.policy.maxConsecutiveDays} onChange={(v) => pol('maxConsecutiveDays', v)} />}</Field>
          <Field label="Days of notice">{(p) => <Input {...p} type="number" min={0} max={365} value={f.policy.minNoticeDays} onChange={(e) => pol('minNoticeDays', Number(e.target.value) || 0)} />}</Field>
          <Field label="Carry forward up to" hint="Unused days moved to next year; the rest lapse. 0: none.">{(p) => <Input {...p} inputMode="decimal" value={f.policy.carryForwardMax} onChange={(e) => pol('carryForwardMax', e.target.value)} />}</Field>
          <Field label="Carried days expire after (months)" hint="Empty: they do not expire">{(p) => <Input {...p} type="number" min={1} max={12} value={f.policy.carriedExpiryMonths ?? ''} onChange={(e) => pol('carriedExpiryMonths', e.target.value ? Number(e.target.value) : null)} />}</Field>
          <Field label="Rounding of accruals">{(p) => <Select {...p} value={f.policy.rounding} onChange={(e) => pol('rounding', e.target.value as LeaveTypePolicy['rounding'])}><option value="half_day">To half days</option><option value="none">Exact (two decimals)</option></Select>}</Field>
          <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
            <Checkbox label="Several days in one application" checked={f.policy.allowMultiDay} onChange={(e) => pol('allowMultiDay', e.target.checked)} />
            <Checkbox label="Custom durations" description="Several days that start or end with a half day" checked={f.policy.allowCustomDuration} onChange={(e) => pol('allowCustomDuration', e.target.checked)} />
            <Checkbox label="Available during probation" checked={f.policy.availableDuringProbation} onChange={(e) => pol('availableDuringProbation', e.target.checked)} />
            <Checkbox label="Allow a negative balance" description="Recovered from later credits" checked={f.policy.allowNegativeBalance} onChange={(e) => pol('allowNegativeBalance', e.target.checked)} />
          </div>
          <Field label="Supporting documents">{(p) => (
            <Select {...p} value={f.policy.documents.mode} onChange={(e) => pol('documents', { ...f.policy.documents, mode: e.target.value as 'none' | 'optional' | 'required' })}>
              <option value="none">Not needed</option><option value="optional">Optional</option><option value="required">Required</option>
            </Select>
          )}</Field>
          {f.policy.documents.mode === 'required' && (
            <Field label="Required only above (days)" hint="Empty: for every application">{(p) => <DaysInput {...p} placeholder="Always" value={f.policy.documents.requiredOverDays} onChange={(v) => pol('documents', { ...f.policy.documents, requiredOverDays: v })} />}</Field>
          )}
          {f.policy.documents.mode !== 'none' && (
            <Field label="What to attach" className="sm:col-span-2">{(p) => <Input {...p} maxLength={300} value={f.policy.documents.note} placeholder="For example: a doctor’s note" onChange={(e) => pol('documents', { ...f.policy.documents, note: e.target.value })} />}</Field>
          )}
        </Section>

        <Section title="Approval" description="Who reviews applications of this type. An application is approved only when every authority it went to approved it.">
          <fieldset className="grid gap-2 sm:col-span-2" data-testid="approval-routes">
            <legend className="mb-1 text-xs font-medium">Approval routes allowed</legend>
            {LEAVE_AUTHORITIES.map((r) => <Checkbox key={r} label={LEAVE_AUTHORITY_LABELS[r]} checked={routes.includes(r)} onChange={() => toggleRoute(r)} />)}
          </fieldset>
          <Checkbox className="sm:col-span-2" label="The employee chooses the route" description={routes.length > 1 ? 'From the routes above, when applying' : 'Allow two or more routes first'} disabled={routes.length < 2}
            checked={f.approval.employeeChooses && routes.length > 1} onChange={(e) => appr('employeeChooses', e.target.checked)} />
          {!f.approval.employeeChooses && routes.length > 1 && <p className="-mt-2 text-xs text-fg-subtle sm:col-span-2">Applications go to {LEAVE_AUTHORITY_LABELS[routes[0]!]} (the first route chosen).</p>}
          <Field label="With both authorities">{(p) => <Select {...p} value={f.approval.order} onChange={(e) => appr('order', e.target.value as 'simultaneous' | 'sequential')}><option value="simultaneous">Both at the same time</option><option value="sequential">HR Workspace first, then Super Workspace</option></Select>}</Field>
          <Field label="Super Workspace must approve above (days)" hint="Longer applications always include the Super Workspace">{(p) => <DaysInput {...p} placeholder="No such rule" value={f.approval.superRequiredOverDays} onChange={(v) => appr('superRequiredOverDays', v)} />}</Field>
          <Field label="Reviewing HR Workspace">{(p) => (
            <Select {...p} value={f.approval.hrWorkspaceId ?? ''} onChange={(e) => appr('hrWorkspaceId', e.target.value || null)}>
              <option value="">The employee’s own HR Workspace (or the company HR team)</option>
              {options.hrWorkspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </Select>
          )}</Field>
          <Field label="Reviewing Super Workspace administrator">{(p) => (
            <Select {...p} value={f.approval.superApproverMembershipId ?? ''} onChange={(e) => appr('superApproverMembershipId', e.target.value || null)}>
              <option value="">Any Super Workspace administrator</option>
              {options.superAdmins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          )}</Field>
          <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
            <Checkbox label="Reporting manager reviews first" checked={f.approval.managerFirst} onChange={(e) => appr('managerFirst', e.target.checked)} />
            <Checkbox label="Escalate a review left waiting" checked={f.approval.escalation.enabled} onChange={(e) => appr('escalation', { ...f.approval.escalation, enabled: e.target.checked })} />
          </div>
          {f.approval.escalation.enabled && (
            <Field label="Escalate after (days)" hint="The Super Workspace is told and may decide it">{(p) => <Input {...p} type="number" min={1} max={60} value={f.approval.escalation.afterDays} onChange={(e) => appr('escalation', { ...f.approval.escalation, afterDays: Number(e.target.value) || 1 })} />}</Field>
          )}
        </Section>
        {type && <Field label="Note for the history">{(p) => <Input {...p} maxLength={300} value={f.note} placeholder="Why this changed (optional)" onChange={(e) => set('note', e.target.value)} />}</Field>}
      </div>
    </Dialog>
  );
}

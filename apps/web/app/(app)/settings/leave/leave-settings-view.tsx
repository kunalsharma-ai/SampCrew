'use client';
import { ACCESS_LEVEL_LABEL, LEAVE_TYPE_KIND_LABELS, type LeaveTypeKind, levelRoleKeyFor } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { ListPlus, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type FieldDef, ResourceDialog } from '@/components/resource-form';
import type { ActionResult } from '@/lib/api';
import type { Department, Designation, HolidayCalendar, LeavePolicy, LeaveType, LegalEntity, Location, Role, StandardLeaveType } from '@/lib/types';
import {

  addHolidayAction, addStandardTypesAction, archiveLeaveTypeAction, closeYearAction, deleteCalendarAction, removeHolidayAction, removePolicyAction, runAccrualsAction,
  saveApprovalChainAction, saveCalendarAction, saveLeaveTypeAction, savePolicyAction,
} from './actions';

const APPROVER_LEVELS = ['hr_workspace', 'super_workspace'] as const;
const levelName = (key: string | undefined) => ACCESS_LEVEL_LABEL[levelRoleKeyFor(key ?? '') as keyof typeof ACCESS_LEVEL_LABEL] ?? 'HR Workspace';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ACCRUAL: Record<string, string> = {
  annual_upfront: 'Up front each year (prorated for joiners)', monthly: 'Monthly (1/12 each month)', granted: 'Credited by HR (e.g. comp-off)', none: 'No balance (e.g. unpaid leave)',
};
const GENDER: Record<string, string> = { any: 'Everyone', female: 'Women', male: 'Men' };
/** Who a policy is for, in words: "Everyone", or "Engineering · Senior engineer". */
const policyScope = (p: LeavePolicy) => [p.legalEntityName, p.departmentName, p.designationName, p.locationName].filter(Boolean).join(' · ') || 'Everyone';
const yesNo = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

interface Props {
  types: LeaveType[];
  policies: LeavePolicy[];
  calendars: HolidayCalendar[];
  entities: LegalEntity[];
  locations: Location[];
  chain: { steps: { type: string; role?: string }[]; fallbackRole: string } | null;
  roles: Role[];
  departments: Department[];
  designations: Designation[];
  standard: StandardLeaveType[];
}

export function LeaveSettingsView(props: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, ok?: (data: unknown) => string) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: ok ? ok(r.data) : r.message ?? 'Saved' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
  });
  const lastYear = new Date().getFullYear() - 1;
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <TypesCard {...props} run={run} />
      <PoliciesCard {...props} run={run} />
      <CalendarsCard {...props} run={run} />
      <ChainCard {...props} run={run} />
      <Card>
        <CardHeader title="Balances maintenance" description="Accruals post automatically every hour and never credit the same period twice. Closing a year carries balances forward up to each policy's cap and lapses the rest." />
        <CardBody className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={pending} onClick={() => run(runAccrualsAction, (d) => `Posted ${(d as { posted: number }).posted} accrual line(s).`)}>Post accruals now</Button>
          <Button variant="secondary" loading={pending} onClick={() => {
            if (!confirm(`Close leave year ${lastYear}? This carries forward and lapses balances. Running it again does nothing more.`)) return;
            run(() => closeYearAction(lastYear), (d) => { const x = d as { carried: number; lapsed: number }; return `Closed ${lastYear}: ${x.carried} balance(s) carried, ${x.lapsed} lapsed.`; });
          }}>Close leave year {lastYear}</Button>
        </CardBody>
      </Card>
    </div>
  );
}

type Run = (fn: () => Promise<ActionResult<unknown>>, ok?: (data: unknown) => string) => void;

function TypesCard({ types, standard, run }: Props & { run: Run }) {
  const [editing, setEditing] = useState<LeaveType | null | 'new'>(null);
  const fields: FieldDef[] = [
    { name: 'code', label: 'Code', required: true, half: true, hint: 'e.g. CL, SL, AL' },
    { name: 'name', label: 'Name', required: true, half: true },
    { name: 'paid', label: 'Paid', type: 'select', options: yesNo, required: true, half: true },
    { name: 'allowHalfDay', label: 'Half days allowed', type: 'select', options: yesNo, required: true, half: true },
    { name: 'kind', label: 'What it is for', type: 'select', required: true, options: Object.entries(LEAVE_TYPE_KIND_LABELS).map(([value, label]) => ({ value, label })) },
    { name: 'eligibleGender', label: 'Who can take it', type: 'select', required: true, options: Object.entries(GENDER).map(([value, label]) => ({ value, label })), half: true, hint: 'Read from the gender on the employee record; nobody without one is blocked' },
    { name: 'countsCalendarDays', label: 'Count every calendar day', type: 'select', required: true, options: yesNo, half: true, hint: 'Weekly offs and holidays count too, as maternity leave usually does' },
    { name: 'color', label: 'Colour', half: true, placeholder: '#4f46e5' },
    { name: 'description', label: 'Description', type: 'textarea' },
  ];
  const current = editing && editing !== 'new' ? editing : null;
  const [picking, setPicking] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Leave types"
        description="Half days are a setting on each type (for example half-day casual leave), not a type of their own."
        action={<div className="flex gap-2">
          {standard.some((x) => !x.added) && <Button size="sm" variant="secondary" onClick={() => setPicking(true)}><ListPlus className="size-3.5" /> Add standard types</Button>}
          <Button size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" /> Add type</Button>
        </div>}
      />
      {types.length ? (
        <Table>
          <THead><tr><TH>Type</TH><TH>Code</TH><TH>For</TH><TH>Paid</TH><TH>Half days</TH><TH /></tr></THead>
          <TBody>
            {types.map((t) => (
              <TR key={t.id} data-testid="leave-type-row">
                <TD>
                  <span className="flex items-center gap-2"><span className="size-2.5 rounded-full" style={{ background: t.color }} />{t.name}</span>
                  <span className="text-xs text-fg-muted">{[t.kind !== 'standard' ? LEAVE_TYPE_KIND_LABELS[t.kind as LeaveTypeKind] : null, t.countsCalendarDays ? 'counts calendar days' : null].filter(Boolean).join(' · ')}</span>
                </TD>
                <TD className="font-mono text-xs">{t.code}</TD>
                <TD className="text-fg-muted">{GENDER[t.eligibleGender] ?? 'Everyone'}</TD>
                <TD>{t.paid ? 'Paid' : 'Unpaid'}</TD>
                <TD>{t.allowHalfDay ? 'Yes' : 'No'}</TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Archive ${t.name}? Its policies stop applying; history is kept.`) && run(() => archiveLeaveTypeAction(t.id))}>Archive</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="No leave types yet" description="Add the types your organization offers, then give each a policy." />}
      <ResourceDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={current ? `Edit ${current.name}` : 'Add leave type'}
        fields={fields}
        initial={current
          ? { ...current, paid: String(current.paid), allowHalfDay: String(current.allowHalfDay), countsCalendarDays: String(current.countsCalendarDays) }
          : { paid: 'true', allowHalfDay: 'true', color: '#4f46e5', kind: 'standard', eligibleGender: 'any', countsCalendarDays: 'false' }}
        submitLabel="Save"
        onSubmit={(v) => saveLeaveTypeAction(current?.id ?? null, { ...v, paid: v.paid === 'true', allowHalfDay: v.allowHalfDay === 'true', countsCalendarDays: v.countsCalendarDays === 'true' })}
      />
      <StandardTypesDialog open={picking} onClose={() => setPicking(false)} standard={standard} run={run} />
    </Card>
  );
}

/** Pick types from the standard catalogue; each comes with a starting policy for everyone that HR then changes. */
function StandardTypesDialog({ open, onClose, standard, run }: { open: boolean; onClose: () => void; standard: StandardLeaveType[]; run: Run }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const left = standard.filter((x) => !x.added);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add standard leave types"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!chosen.length} onClick={() => {
          run(() => addStandardTypesAction(chosen), (d) => `Added ${(d as { added: string[] }).added.length} leave type(s) with starting policies.`);
          setChosen([]);
          onClose();
        }}>Add {chosen.length || ''} type{chosen.length === 1 ? '' : 's'}</Button>
      </>}
    >
      <p className="mb-3 text-[0.8125rem] text-fg-muted">Each type comes with a starting policy for everyone. The numbers are common starting points, not any country&apos;s statutory minimum: change them under Policies.</p>
      <div className="grid gap-2">
        {left.map((x) => (
          <Checkbox
            key={x.code}
            label={`${x.name} (${x.code})`}
            description={[
              x.accrualMethod === 'none' ? 'No balance' : x.accrualMethod === 'granted' ? 'Credited by HR' : `${Number(x.annualEntitlement)} days a year`,
              x.kind !== 'standard' ? LEAVE_TYPE_KIND_LABELS[x.kind as LeaveTypeKind] : null,
              x.eligibleGender !== 'any' ? `for ${(GENDER[x.eligibleGender] ?? '').toLowerCase()}` : null,
              x.countsCalendarDays ? 'counts calendar days' : null,
              x.paid ? null : 'unpaid',
              x.allowHalfDay ? 'half days allowed' : null,
            ].filter(Boolean).join(' · ')}
            checked={chosen.includes(x.code)}
            onChange={(e) => setChosen((c) => (e.target.checked ? [...c, x.code] : c.filter((y) => y !== x.code)))}
          />
        ))}
      </div>
    </Dialog>
  );
}

function PoliciesCard({ types, policies, entities, departments, designations, locations, run }: Props & { run: Run }) {
  const [editing, setEditing] = useState<Partial<LeavePolicy> | null>(null);
  const fields: FieldDef[] = [
    { name: 'leaveTypeId', label: 'Leave type', type: 'select', required: true, options: types.map((t) => ({ value: t.id, label: t.name })), half: true },
    { name: 'legalEntityId', label: 'Legal entity', type: 'select', options: entities.map((e) => ({ value: e.id, label: e.name })), half: true, hint: 'Empty means every entity' },
    { name: 'departmentId', label: 'Department', type: 'select', options: departments.map((d) => ({ value: d.id, label: d.name })), half: true, hint: 'Empty means every department' },
    { name: 'designationId', label: 'Designation', type: 'select', options: designations.map((d) => ({ value: d.id, label: d.name })), half: true, hint: 'Empty means every designation' },
    { name: 'locationId', label: 'Location', type: 'select', options: locations.map((l) => ({ value: l.id, label: l.name })), half: true, hint: 'Empty means every location' },
    { name: 'accrualMethod', label: 'How it accrues', type: 'select', required: true, options: Object.entries(ACCRUAL).map(([value, label]) => ({ value, label })) },
    { name: 'annualEntitlement', label: 'Days per year', type: 'number', step: '0.5', required: true, half: true },
    { name: 'carryForwardMax', label: 'Carry forward up to', type: 'number', step: '0.5', half: true },
    { name: 'minNoticeDays', label: 'Notice needed (days)', type: 'number', half: true },
    { name: 'maxConsecutiveDays', label: 'Most days per request', type: 'number', step: '0.5', half: true },
    { name: 'allowNegativeBalance', label: 'Allow going below zero', type: 'select', required: true, options: yesNo, half: true },
    { name: 'availableDuringProbation', label: 'Available on probation', type: 'select', required: true, options: yesNo, half: true },
    { name: 'rounding', label: 'Round credits', type: 'select', required: true, options: [{ value: 'half_day', label: 'To the nearest half day' }, { value: 'none', label: 'No rounding (2 decimals)' }] },
  ];
  return (
    <Card>
      <CardHeader
        title="Policies"
        description="A policy is for everyone or narrowed by legal entity, department, designation or location. When several fit a person the most specific one wins (location, then designation, then department, then entity). Saving a policy for the same type and scope replaces the active one; the previous version is kept for history."
        action={types.length > 0 && <Button size="sm" onClick={() => setEditing({})}><Plus className="size-3.5" /> Add policy</Button>}
      />
      {policies.length ? (
        <Table>
          <THead><tr><TH>Type</TH><TH>Applies to</TH><TH>Accrual</TH><TH>Days / year</TH><TH>Carry forward</TH><TH>Rules</TH><TH /></tr></THead>
          <TBody>
            {policies.map((p) => (
              <TR key={p.id}>
                <TD className="font-medium">{p.leaveTypeName}</TD>
                <TD className="text-fg-muted" data-testid="policy-scope">{policyScope(p)}</TD>
                <TD className="text-fg-muted">{ACCRUAL[p.accrualMethod]?.split(' (')[0]}</TD>
                <TD className="tabular-nums">{p.accrualMethod === 'none' || p.accrualMethod === 'granted' ? '—' : p.annualEntitlement}</TD>
                <TD className="tabular-nums">{p.carryForwardMax}</TD>
                <TD className="text-xs text-fg-muted">
                  {[p.minNoticeDays ? `${p.minNoticeDays}d notice` : null, p.maxConsecutiveDays ? `max ${p.maxConsecutiveDays} per request` : null, !p.availableDuringProbation ? 'not on probation' : null, p.allowNegativeBalance ? 'can go negative' : null].filter(Boolean).join(' · ') || '—'}
                </TD>
                <TD className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm('Remove this policy? Nobody can request this type under it afterwards.') && run(() => removePolicyAction(p.id))}>Remove</Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="No policies yet" description={types.length ? 'A leave type can only be requested once a policy says who gets how much.' : 'Add a leave type first.'} />}
      <ResourceDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Leave policy"
        fields={fields}
        initial={editing ? {
          rounding: 'half_day', carryForwardMax: '0', minNoticeDays: 0, ...editing,
          allowNegativeBalance: String(editing.allowNegativeBalance ?? false), availableDuringProbation: String(editing.availableDuringProbation ?? true),
        } : undefined}
        submitLabel="Save policy"
        onSubmit={(v) => savePolicyAction({
          ...v,
          legalEntityId: v.legalEntityId ?? null,
          departmentId: v.departmentId ?? null,
          designationId: v.designationId ?? null,
          locationId: v.locationId ?? null,
          annualEntitlement: String(v.annualEntitlement ?? '0'),
          carryForwardMax: String(v.carryForwardMax ?? '0'),
          maxConsecutiveDays: v.maxConsecutiveDays === undefined || v.maxConsecutiveDays === null ? null : String(v.maxConsecutiveDays),
          minNoticeDays: Number(v.minNoticeDays ?? 0),
          allowNegativeBalance: v.allowNegativeBalance === 'true',
          availableDuringProbation: v.availableDuringProbation === 'true',
        })}
      />
    </Card>
  );
}

function CalendarsCard({ calendars, entities, locations, run }: Props & { run: Run }) {
  const [editing, setEditing] = useState<HolidayCalendar | null | 'new'>(null);
  const current = editing && editing !== 'new' ? editing : null;
  const fields: FieldDef[] = [
    { name: 'name', label: 'Name', required: true },
    { name: 'legalEntityId', label: 'Legal entity', type: 'select', options: entities.map((e) => ({ value: e.id, label: e.name })), half: true },
    { name: 'locationId', label: 'Location', type: 'select', options: locations.map((l) => ({ value: l.id, label: l.name })), half: true, hint: 'A location calendar wins over an entity calendar' },
    { name: 'isDefault', label: 'Workspace default', type: 'select', required: true, options: yesNo, half: true },
    { name: 'weeklyOffs', label: 'Weekly offs', half: true, hint: 'Day numbers, 0 = Sunday. e.g. 0,6', placeholder: '0,6' },
  ];
  return (
    <Card>
      <CardHeader
        title="Holiday calendars"
        description="Leave days skip each calendar's weekly offs and holidays. Holidays are entered by you: SampCrew does not claim an official list for any country."
        action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-3.5" /> Add calendar</Button>}
      />
      <CardBody className="grid gap-4">
        {calendars.map((c) => <CalendarBlock key={c.id} c={c} run={run} onEdit={() => setEditing(c)} />)}
      </CardBody>
      <ResourceDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={current ? `Edit ${current.name}` : 'Add calendar'}
        fields={fields}
        initial={current ? { ...current, isDefault: String(current.isDefault), weeklyOffs: current.weeklyOffs.join(',') } : { isDefault: 'false', weeklyOffs: '0,6' }}
        submitLabel="Save"
        onSubmit={(v) => saveCalendarAction(current?.id ?? null, {
          name: v.name, legalEntityId: v.legalEntityId ?? null, locationId: v.locationId ?? null, isDefault: v.isDefault === 'true',
          weeklyOffs: String(v.weeklyOffs ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(Number),
        })}
      />
    </Card>
  );
}

function CalendarBlock({ c, run, onEdit }: { c: HolidayCalendar; run: Run; onEdit: () => void }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [optional, setOptional] = useState('false');
  const year = new Date().getFullYear();
  const shown = c.holidays.filter((h) => Number(h.date.slice(0, 4)) >= year);
  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">{c.name}</span>
        {c.isDefault && <Badge tone="accent">Default</Badge>}
        <span className="text-xs text-fg-subtle">{c.locationName ?? c.legalEntityName ?? 'Workspace'} · off: {c.weeklyOffs.map((d) => DAYS[d]).join(', ') || 'none'}</span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit}>Edit</Button>
          {!c.isDefault && <Button size="sm" variant="ghost" onClick={() => confirm(`Delete ${c.name} and its holidays?`) && run(() => deleteCalendarAction(c.id))}>Delete</Button>}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {shown.map((h) => (
          <li key={h.id} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="w-28 tabular-nums text-fg-muted">{h.date}</span>
            <span className="flex-1">{h.name}{h.isOptional && <Badge className="ml-2">Optional</Badge>}</span>
            <button className="text-fg-subtle hover:text-danger" aria-label={`Remove ${h.name}`} onClick={() => run(() => removeHolidayAction(c.id, h.id))}><Trash2 className="size-4" /></button>
          </li>
        ))}
        {!shown.length && <li className="px-4 py-3 text-sm text-fg-subtle">No upcoming holidays.</li>}
      </ul>
      <form
        className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => addHolidayAction(c.id, { date, name, isOptional: optional === 'true' }));
          setName('');
        }}
      >
        <Input type="date" aria-label="Holiday date" value={date} onChange={(e) => setDate(e.target.value)} required className="sm:w-44" />
        <Input aria-label="Holiday name" placeholder="Holiday name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        <Select aria-label="Optional holiday" value={optional} onChange={(e) => setOptional(e.target.value)} className="sm:w-36"><option value="false">Closed</option><option value="true">Optional</option></Select>
        <Button type="submit" variant="secondary">Add</Button>
      </form>
    </div>
  );
}

function ChainCard({ chain, run }: Props & { run: Run }) {
  const [steps, setSteps] = useState(chain?.steps ?? [{ type: 'manager' }]);
  if (!chain) return null;
  const label = (s: { type: string; role?: string }) => s.type === 'manager' ? 'Their manager' : s.type === 'skip_level_manager' ? "Their manager's manager" : `Everyone with ${levelName(s.role)} access who covers them`;
  return (
    <Card>
      <CardHeader
        title="Leave approval chain"
        description={`Steps run in order. Nobody approves their own request; if no one can, it goes to everyone with ${levelName(chain.fallbackRole)} access, then to Super Workspace.`}
      />
      <CardBody className="grid gap-3">
        <ol className="grid gap-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-sm">
              <span className="flex size-6 items-center justify-center rounded-full bg-accent-subtle text-xs font-semibold text-accent">{i + 1}</span>
              <Select aria-label={`Step ${i + 1}`} value={s.type === 'role' ? `role:${levelRoleKeyFor(s.role ?? '')}` : s.type} className="max-w-md" onChange={(e) => {
                const v = e.target.value;
                const next = [...steps];
                next[i] = v.startsWith('role:') ? { type: 'role', role: v.slice(5) } : { type: v };
                setSteps(next);
              }}>
                <option value="manager">Their manager</option>
                <option value="skip_level_manager">Their manager&apos;s manager</option>
                {APPROVER_LEVELS.map((k) => <option key={k} value={`role:${k}`}>Everyone with {ACCESS_LEVEL_LABEL[k]} access</option>)}
              </Select>
              {steps.length > 1 && <button className="text-fg-subtle hover:text-danger" aria-label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}
            </li>
          ))}
        </ol>
        <p className="text-xs text-fg-subtle">{steps.map(label).join(', then ')}.</p>
        <div className="flex gap-2">
          {steps.length < 5 && <Button size="sm" variant="secondary" onClick={() => setSteps([...steps, { type: 'role', role: 'hr_workspace' }])}><Plus className="size-3.5" /> Add step</Button>}
          <Button size="sm" onClick={() => run(() => saveApprovalChainAction(steps))}>Save chain</Button>
        </div>
      </CardBody>
    </Card>
  );
}

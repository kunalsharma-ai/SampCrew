'use client';
import type { CustomFieldDefinition, EmployeeBulkInput, EmployeeBulkResult } from '@crew/contracts';
import { Alert, Button, DatePicker, Dialog, Field, Input, Select } from '@crew/ui';
import { Layers } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Department, Designation, Employee, Location } from '@/lib/types';
import { bulkChangeEmployeesAction } from './actions';

type Action = EmployeeBulkInput['action'];
const ACTIONS: { key: Action; label: string }[] = [
  { key: 'department', label: 'Move to a department' },
  { key: 'job_title', label: 'Change the job title' },
  { key: 'location', label: 'Change the work location' },
  { key: 'manager', label: 'Change the reporting manager' },
  { key: 'custom_field', label: 'Set a custom field' },
];
const today = () => new Date().toISOString().slice(0, 10);

/**
 * The bar shown when employees are picked in the list: one change for all of them. Each person is changed on their
 * own, with the same checks as one at a time, and the result lists anyone who could not be changed and why.
 */
export function BulkChange({ ids, onDone, departments, designations, locations, managers, fields, canMove, canFields }: {
  ids: string[]; onDone: () => void; departments: Department[]; designations: Designation[]; locations: Location[]; managers: Employee[];
  fields: CustomFieldDefinition[]; canMove: boolean; canFields: boolean;
}) {
  const router = useRouter();
  const actions = ACTIONS.filter((a) => (a.key === 'custom_field' ? canFields && fields.length > 0 : canMove));
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<Action>(actions[0]?.key ?? 'department');
  const [target, setTarget] = useState('');
  const [field, setField] = useState(fields[0]?.key ?? '');
  const [value, setValue] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EmployeeBulkResult | null>(null);
  const [pending, start] = useTransition();
  if (!actions.length) return null;
  const def = fields.find((f) => f.key === field);

  const apply = () => start(async () => {
    setError(null);
    const dated = { employeeIds: ids, effectiveFrom, ...(note.trim() ? { note: note.trim() } : {}) };
    const t = target || null;
    let body: EmployeeBulkInput;
    if (action === 'department') body = { action, ...dated, departmentId: t };
    else if (action === 'location') body = { action, ...dated, locationId: t };
    else if (action === 'manager') body = { action, ...dated, managerEmployeeId: t };
    else if (action === 'job_title') {
      if (!t) { setError('Choose a job title'); return; }
      body = { action, ...dated, designationId: t };
    } else {
      const v = !def ? value : def.type === 'number' || def.type === 'decimal' || def.type === 'currency' ? (value === '' ? null : Number(value)) : def.type === 'yes_no' ? (value === '' ? null : value === 'yes') : value || null;
      body = { action: 'custom_field', employeeIds: ids, key: field, value: v };
    }
    const r = await bulkChangeEmployeesAction(body);
    if (r.ok && r.data) { setResult(r.data); router.refresh(); } else if (!r.ok) setError(r.fieldErrors ? Object.values(r.fieldErrors).join(' ') : r.message);
  });
  const close = () => { setOpen(false); setResult(null); setError(null); if (result) onDone(); };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-accent-subtle/40 px-5 py-2.5 text-[0.8125rem]" data-testid="bulk-bar">
        <span className="font-medium">{ids.length} chosen</span>
        <Button size="sm" onClick={() => setOpen(true)}><Layers className="size-3.5" aria-hidden /> Change them together</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Clear</Button>
      </div>
      <Dialog open={open} onClose={close} title={`Change ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`}
        description="Each person is changed on their own, with the same checks as one at a time. Job changes are dated and kept in each person’s history."
        footer={result ? <Button onClick={close}>Done</Button> : <><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={apply} loading={pending} data-testid="bulk-apply">Apply to {ids.length}</Button></>}>
        {result ? (
          <div className="grid gap-3" data-testid="bulk-result">
            <Alert tone={result.failed ? 'warning' : 'success'}>{result.done} changed{result.failed ? `, ${result.failed} not changed` : ''}.</Alert>
            {result.failed > 0 && (
              <ul className="grid gap-1 text-[0.8125rem]">
                {result.results.filter((r) => !r.ok).map((r) => <li key={r.employeeId}><span className="font-medium">{r.name ?? 'Someone you cannot see'}</span>: {r.message}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className="grid gap-3">
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="What to change">{(p) => (
              <Select {...p} value={action} data-testid="bulk-action" onChange={(e) => { setAction(e.target.value as Action); setTarget(''); }}>
                {actions.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
              </Select>
            )}</Field>
            {action === 'department' && <Field label="Department">{(p) => <Select {...p} value={target} data-testid="bulk-target" onChange={(e) => setTarget(e.target.value)}><option value="">No department</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>}
            {action === 'job_title' && <Field label="Job title" required>{(p) => <Select {...p} value={target} data-testid="bulk-target" onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>}
            {action === 'location' && <Field label="Work location">{(p) => <Select {...p} value={target} data-testid="bulk-target" onChange={(e) => setTarget(e.target.value)}><option value="">No location</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>}</Field>}
            {action === 'manager' && <Field label="Reporting manager">{(p) => <Select {...p} value={target} data-testid="bulk-target" onChange={(e) => setTarget(e.target.value)}><option value="">No manager</option>{managers.filter((m) => !ids.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName ?? ''} ({m.employeeCode})</option>)}</Select>}</Field>}
            {action !== 'custom_field' && (
              <>
                <Field label="Takes effect on">{(p) => <DatePicker {...p} value={effectiveFrom} onChange={(v) => setEffectiveFrom(v || today())} />}</Field>
                <Field label="Note" hint="Kept with each person’s job history">{(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Bulk change" />}</Field>
              </>
            )}
            {action === 'custom_field' && (
              <>
                <Field label="Field">{(p) => <Select {...p} value={field} onChange={(e) => { setField(e.target.value); setValue(''); }}>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>}</Field>
                <Field label="Value" hint="Left empty, the field is cleared">{(p) => def && (def.type === 'dropdown' || def.type === 'radio') ? (
                  <Select {...p} value={value} onChange={(e) => setValue(e.target.value)}><option value="">(empty)</option>{def.options.filter((o) => !o.archived).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
                ) : def?.type === 'yes_no' ? (
                  <Select {...p} value={value} onChange={(e) => setValue(e.target.value)}><option value="">(empty)</option><option value="yes">Yes</option><option value="no">No</option></Select>
                ) : (
                  <Input {...p} type={def?.type === 'date' ? 'date' : def?.type === 'number' || def?.type === 'decimal' || def?.type === 'currency' ? 'number' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} />
                )}</Field>
              </>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}


'use client';
import { ONBOARDING_REQUIREMENT_LABEL } from '@crew/contracts';
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { assignChecklistAction, assignOptionsAction } from './actions';
import type { AssignOptions } from './types';

export interface PickedDocuments { templateId: string | null; itemIds: string[] }

/** Picks a template and the documents to ask for. A template's mandatory documents cannot be left out. */
export function pickFromTemplate(o: AssignOptions, templateId: string | null): PickedDocuments {
  const t = o.templates.find((x) => x.id === templateId);
  return { templateId: t?.id ?? null, itemIds: t ? t.items.map((x) => x.itemId) : [] };
}

export function DocumentPicker({ options, value, onChange, already = [] }: { options: AssignOptions; value: PickedDocuments; onChange: (v: PickedDocuments) => void; already?: string[] }) {
  const t = options.templates.find((x) => x.id === value.templateId);
  const required = new Set((t?.items ?? []).filter((x) => x.required).map((x) => x.itemId));
  const inTemplate = new Set((t?.items ?? []).map((x) => x.itemId));
  const have = new Set(already);
  const chosen = new Set(value.itemIds);
  const toggle = (id: string) => onChange({ ...value, itemIds: chosen.has(id) ? value.itemIds.filter((x) => x !== id) : [...value.itemIds, id] });
  return (
    <div className="grid gap-4" data-testid="onboarding-picker">
      <Field label="Onboarding template" hint={t?.description ?? 'Choose a template, or pick documents one by one from the library.'}>
        {(p) => (
          <Select {...p} value={value.templateId ?? ''} onChange={(e) => onChange(pickFromTemplate(options, e.target.value || null))} data-testid="onboarding-template">
            <option value="">No template: pick documents</option>
            {options.templates.map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === options.suggestedTemplateId ? ' (suggested)' : ''}</option>)}
          </Select>
        )}
      </Field>
      <p className="text-sm text-fg-muted" aria-live="polite">{value.itemIds.length} document{value.itemIds.length === 1 ? '' : 's'} selected{required.size ? `, ${[...required].filter((x) => chosen.has(x)).length} mandatory` : ''}.</p>
      <div className="grid max-h-[26rem] gap-4 overflow-y-auto rounded-xl border border-border p-3">
        {options.categories.map((c) => {
          const items = options.items.filter((i) => i.categoryId === c.id);
          if (!items.length) return null;
          return (
            <fieldset key={c.id} className="grid gap-1.5">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">{c.name}</legend>
              {items.map((i) => {
                const locked = required.has(i.id);
                const done = have.has(i.id);
                return (
                  <label key={i.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm ${done ? 'opacity-60' : 'hover:bg-bg-subtle'}`}>
                    <input type="checkbox" className="mt-0.5" checked={done || chosen.has(i.id)} disabled={locked || done} onChange={() => toggle(i.id)} data-testid={`onboarding-pick-${i.key}`} />
                    <span className="min-w-0">
                      <span className="font-medium">{i.name}</span>
                      <span className="block text-xs text-fg-subtle">
                        {done ? 'Already asked for' : locked ? 'Mandatory in this template' : inTemplate.has(i.id) ? 'Optional in this template' : ONBOARDING_REQUIREMENT_LABEL[i.requirement]}
                        {i.multiple ? ` · up to ${i.maxFiles} files` : ''}{i.sensitive ? ' · sensitive' : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

/** Assigns onboarding documents to someone already in the company, or adds documents to their checklist. */
export function AssignDialog({ employeeId, employmentType, departmentId, already = [], label = 'Assign onboarding documents' }: { employeeId: string; employmentType?: string; departmentId?: string | null; already?: string[]; label?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<AssignOptions | null>(null);
  const [value, setValue] = useState<PickedDocuments>({ templateId: null, itemIds: [] });
  const [dueOn, setDueOn] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (!open || options) return;
    void assignOptionsAction(employmentType, departmentId ?? undefined).then((r) => {
      if (!r.ok || !r.data) return setError(r.ok ? 'Could not load the library.' : r.message);
      setOptions(r.data);
      // Adding to an existing checklist starts from nothing; a first checklist starts from the suggested template.
      setValue(already.length ? { templateId: null, itemIds: [] } : pickFromTemplate(r.data, r.data.suggestedTemplateId));
    });
  }, [open, options, employmentType, departmentId, already.length]);
  const itemIds = value.itemIds.filter((x) => !already.includes(x));
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} data-testid="onboarding-assign">{label}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="lg" title={label} description="Each document becomes a task for the employee. Uploads come back to HR to approve or reject; nothing is complete until HR approves it."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!itemIds.length} onClick={() => start(async () => {
          setError(null);
          const r = await assignChecklistAction(employeeId, { templateId: value.templateId, itemIds, dueOn: dueOn || null, ...(note.trim() ? { note: note.trim() } : {}) });
          if (!r.ok) return setError(r.message);
          setOpen(false);
          router.refresh();
        })} data-testid="onboarding-assign-save">Assign {itemIds.length || ''}</Button></>}>
        <div className="grid gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {!options && !error && <p className="text-sm text-fg-muted">Loading the library…</p>}
          {options && <DocumentPicker options={options} value={value} onChange={setValue} already={already} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Due date (optional)">{(p) => <Input {...p} type="date" value={dueOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDueOn(e.target.value)} />}</Field>
            <Field label="Note for the employee (optional)">{(p) => <Textarea {...p} rows={2} maxLength={600} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** The template that fits an employment type and department best (as the API suggests it), else the default. */
export function suggestTemplate(o: AssignOptions, employmentType?: string, departmentId?: string): string | null {
  const score = (t: AssignOptions['templates'][number]) => (departmentId && t.departmentIds.includes(departmentId) ? 2 : 0) + (employmentType && t.employmentTypes.includes(employmentType) ? 1 : 0);
  const best = [...o.templates].sort((a, b) => score(b) - score(a))[0];
  return (best && score(best) > 0 ? best : o.templates.find((t) => t.isDefault) ?? o.templates[0])?.id ?? null;
}

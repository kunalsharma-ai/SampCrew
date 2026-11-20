'use client';
import { checkFieldValue, CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_ENTITY_LABEL, CUSTOM_FIELD_TYPE_LABEL, CUSTOM_FIELD_TYPES, type CustomFieldType, OPTION_TYPES } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea, cn } from '@crew/ui';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { archiveFieldAction, deleteFieldAction, reorderFieldsAction, saveFieldAction } from './actions';
import type { FieldHistory, FieldRow } from './page';

type RoleOpt = { key: string; name: string };

/** Where each kind of record shows its custom fields, so HR knows where a new field will appear. */
export const FIELD_PLACES: Record<string, string> = {
  employee: 'Each employee’s profile (Employees > open a person > Additional details), and the person’s own My profile page, where they can fill in fields marked for employees.',
  asset: 'Each asset’s page (Assets > open an asset > Additional details).',
  bgv_case: 'Each background verification case (Verification > open a case > Additional details).',
  candidate: 'Each candidate’s page (Recruitment > Candidates > open a candidate > Additional details).',
  leave_request: 'Each leave request on the Leave page (My requests > Details), for the employee and for HR.',
};
const ACTION_LABEL: Record<string, string> = {
  'custom_field.created': 'Field added', 'custom_field.updated': 'Field changed', 'custom_field.archived': 'Field archived', 'custom_field.restored': 'Field restored',
  'custom_field.deleted': 'Field deleted', 'custom_field.reordered': 'Order changed',
};

export function FieldsView({ fields, roles, history, entity }: { fields: FieldRow[]; roles: RoleOpt[]; history: FieldHistory[]; entity: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState<FieldRow | 'new' | null>(null);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pending, start] = useTransition();
  const mine = fields.filter((f) => f.entity === entity);
  const active = mine.filter((f) => !f.archivedAt);
  const archived = mine.filter((f) => f.archivedAt);
  const say = (r: { ok: boolean; message?: string }) => setFlash({ tone: r.ok ? 'success' : 'danger', text: r.message ?? '' });
  const move = (i: number, d: -1 | 1) => {
    const ids = active.map((f) => f.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    start(async () => say(await reorderFieldsAction(entity, ids)));
  };
  const name = (id: string | null) => fields.find((f) => f.id === id)?.label;
  const names = (keys: string[]) => keys.map((k) => roles.find((r) => r.key === k)?.name ?? k).join(', ');

  return (
    <div className="grid gap-6">
      <div role="tablist" aria-label="Kind of record" className="flex flex-wrap gap-1 border-b border-border">
        {CUSTOM_FIELD_ENTITIES.map((e) => (
          <button key={e} role="tab" type="button" aria-selected={entity === e} onClick={() => router.push(`/settings/custom-fields?entity=${e}`)}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', entity === e ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-muted hover:text-fg')}>
            {CUSTOM_FIELD_ENTITY_LABEL[e]} <span className="text-xs text-fg-subtle">{fields.filter((f) => f.entity === e && !f.archivedAt).length}</span>
          </button>
        ))}
      </div>
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      <Alert tone="info" title="What custom fields are for" data-testid="field-places">
        Record details SampCrew does not ask for out of the box, such as Blood group, Driving licence number or T-shirt size, without changing the product. Fields on this tab appear on: {FIELD_PLACES[entity]} Choose who can see and change each field by workspace access.
      </Alert>
      <Card>
        <CardHeader title="Fields" description={`Shown in this order on ${CUSTOM_FIELD_ENTITY_LABEL[entity as keyof typeof CUSTOM_FIELD_ENTITY_LABEL].toLowerCase()} forms.`} action={<Button size="sm" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden /> Add field</Button>} />
        {active.length ? (
          <Table aria-label="Custom fields">
            <THead><tr><TH>Field</TH><TH>Type</TH><TH>Rules</TH><TH>Who</TH><TH>In use</TH><TH /></tr></THead>
            <TBody>
              {active.map((f, i) => (
                <TR key={f.id}>
                  <TD className="font-medium">{f.label}<div className="font-mono text-[0.6875rem] font-normal text-fg-subtle">{f.key}{f.section ? ` · ${f.section}` : ''}</div></TD>
                  <TD>{CUSTOM_FIELD_TYPE_LABEL[f.type]}{f.options.length ? <div className="text-xs text-fg-muted">{f.options.filter((o) => !o.archived).map((o) => o.label).join(', ')}</div> : null}</TD>
                  <TD className="text-xs">{[f.required ? 'Required' : 'Optional', f.enabled ? null : 'Switched off', f.defaultValue !== null && f.defaultValue !== undefined && f.defaultValue !== '' ? `Default: ${String(f.defaultValue)}` : null].filter(Boolean).join(' · ')}</TD>
                  <TD className="text-xs text-fg-muted">{f.viewRoles.length ? `Seen by ${names(f.viewRoles)}` : 'Everyone with the record'}{f.editRoles.length ? ` · changed by ${names(f.editRoles)}` : ''}{f.employeeEditable ? ' · employee can fill in' : ''}</TD>
                  <TD>{f.valueCount ?? 0}</TD>
                  <TD className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" aria-label={`Move ${f.label} up`} disabled={i === 0 || pending} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" aria-hidden /></Button>
                    <Button size="sm" variant="ghost" aria-label={`Move ${f.label} down`} disabled={i === active.length - 1 || pending} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" aria-hidden /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(f)}>Edit</Button>
                    <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => say(await archiveFieldAction(f.id, true)))}>Archive</Button>
                    {!f.valueCount && <Button size="sm" variant="ghost" aria-label={`Delete ${f.label}`} onClick={() => start(async () => say(await deleteFieldAction(f.id)))}><Trash2 className="size-3.5" aria-hidden /></Button>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <CardBody><EmptyState title="No custom fields yet" description="Add fields such as Blood group, T-shirt size or Laptop preference." /></CardBody>}
      </Card>

      {archived.length > 0 && (
        <Card>
          <CardHeader title="Archived fields" description="Hidden from forms. Their values are kept and shown on records that have one." />
          <Table aria-label="Archived fields">
            <TBody>
              {archived.map((f) => (
                <TR key={f.id}>
                  <TD className="font-medium">{f.label} <span className="font-mono text-[0.6875rem] text-fg-subtle">{f.key}</span></TD>
                  <TD>{CUSTOM_FIELD_TYPE_LABEL[f.type]}</TD>
                  <TD>{f.valueCount ?? 0} values kept</TD>
                  <TD className="text-right"><Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => say(await archiveFieldAction(f.id, false)))}>Restore</Button></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Card>
        <CardHeader title="Field change log" description="Every change to a field definition, with who made it." />
        <CardBody>
          {history.length ? (
            <ol className="grid gap-2">
              {history.slice(0, 50).map((h) => (
                <li key={h.id} className="text-[0.8125rem]"><span className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</span>{name(h.fieldId) ? `: ${name(h.fieldId)}` : ''} <span className="text-xs text-fg-subtle">· {h.by ?? 'SampCrew'} · {new Date(h.at).toLocaleString('en-GB')}</span></li>
              ))}
            </ol>
          ) : <p className="text-[0.8125rem] text-fg-muted">No changes yet.</p>}
        </CardBody>
      </Card>
      {editing && <FieldDialog field={editing === 'new' ? null : editing} entity={entity} roles={roles} onClose={() => setEditing(null)} onSaved={(m) => { setEditing(null); setFlash({ tone: 'success', text: m }); }} />}
    </div>
  );
}

function FieldDialog({ field, entity, roles, onClose, onSaved }: { field: FieldRow | null; entity: string; roles: RoleOpt[]; onClose: () => void; onSaved: (m: string) => void }) {
  const [type, setTypeRaw] = useState<CustomFieldType>(field?.type ?? 'short_text');
  const [options, setOptions] = useState(field?.options ?? [{ value: '', label: '' }]);
  const [viewRoles, setViewRoles] = useState<string[]>(field?.viewRoles ?? []);
  const [editRoles, setEditRoles] = useState<string[]>(field?.editRoles ?? []);
  const [required, setRequired] = useState(field?.required ?? false);
  const [enabled, setEnabled] = useState(field?.enabled ?? true);
  const [employeeEditable, setEmployeeEditable] = useState(field?.employeeEditable ?? false);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const hasOptions = OPTION_TYPES.includes(type);
  const numeric = type === 'number' || type === 'currency';
  // A new type starts with no old messages (an error from the previous type would otherwise stay on screen).
  const setType = (t: CustomFieldType) => { setTypeRaw(t); setFe({}); setError(null); };
  const toggle = (list: string[], set: (v: string[]) => void, k: string) => set(list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  return (
    <Dialog open onClose={onClose} size="lg" title={field ? `Edit ${field.label}` : `Add a field to ${CUSTOM_FIELD_ENTITY_LABEL[entity as keyof typeof CUSTOM_FIELD_ENTITY_LABEL].toLowerCase()}`}
      description={field && field.valueCount ? `${field.valueCount} records have a value. Renaming or changing the type keeps every value.` : undefined}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="field-form" loading={pending}>Save field</Button></>}>
      <form id="field-form" className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const v = (k: string) => String(f.get(k) ?? '').trim();
        const num = (k: string) => (v(k) === '' ? undefined : Number(v(k)));
        const config = Object.fromEntries(Object.entries({ min: numeric ? num('min') : undefined, max: numeric ? num('max') : undefined, maxLength: type === 'short_text' || type === 'long_text' ? num('maxLength') : undefined, currency: type === 'currency' && v('currency') ? v('currency').toUpperCase() : undefined }).filter(([, x]) => x !== undefined));
        const rawDefault = v('defaultValue');
        const body: Record<string, unknown> = {
          label: v('label'), type, helpText: v('helpText') || null, required, enabled, section: v('section') || null, viewRoles, editRoles, employeeEditable: entity === 'employee' && employeeEditable, config,
          options: hasOptions ? options.filter((o) => o.label.trim()).map((o) => ({ ...o, value: o.value || o.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') })) : [],
          ...(rawDefault ? { defaultValue: numeric ? Number(rawDefault) : type === 'checkbox' ? rawDefault === 'true' : rawDefault } : { defaultValue: null }),
          ...(field ? {} : { entity, ...(v('key') ? { key: v('key') } : {}) }),
        };
        setError(null);
        setFe({});
        // The same checks the API makes, so mistakes show at once and next to the right box.
        const local: Record<string, string> = {};
        if (!v('label')) local.label = 'Enter a label';
        const cfg = config as { min?: number; max?: number; maxLength?: number };
        if (cfg.min !== undefined && cfg.max !== undefined && cfg.min > cfg.max) local.max = 'Must be at least the smallest value';
        if (hasOptions && !options.some((o) => o.label.trim())) local.options = 'Add at least one option';
        if (rawDefault && type !== 'file') {
          const opts = hasOptions ? (body.options as { value: string; label: string }[]) : [];
          const c = checkFieldValue({ type, required: false, options: opts, config: cfg, label: v('label') || 'Default value' }, (body as { defaultValue: unknown }).defaultValue);
          if (!c.ok) local.defaultValue = c.error;
        }
        if (Object.keys(local).length) { setFe(local); setError('Some fields need attention'); return; }
        start(async () => {
          const r = await saveFieldAction(field?.id ?? null, body);
          if (r.ok) {
            const mismatched = (r.data as { valuesNotMatchingType?: number } | undefined)?.valuesNotMatchingType;
            onSaved(mismatched ? `${r.message} ${mismatched} existing value${mismatched === 1 ? ' does' : 's do'} not fit the new type: they are kept and shown for correction.` : r.message ?? 'Saved.');
          } else { setError(r.message); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <div className="sm:col-span-2"><Alert tone="danger">{error}</Alert></div>}
        <Field label="Label" required error={fe.label}>{(p) => <Input {...p} name="label" required maxLength={120} defaultValue={field?.label} placeholder="Blood group" />}</Field>
        <Field label="Field type" error={fe.type}>{(p) => <Select {...p} value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>{CUSTOM_FIELD_TYPES.map((t) => <option key={t} value={t}>{CUSTOM_FIELD_TYPE_LABEL[t]}</option>)}</Select>}</Field>
        {!field && <Field label="Key" hint="Made from the label when empty. It never changes, so exports keep working." error={fe.key}>{(p) => <Input {...p} name="key" pattern="[a-z][a-z0-9_]{1,40}" placeholder="blood_group" />}</Field>}
        <Field label="Section" hint="Groups fields on the form" error={fe.section}>{(p) => <Input {...p} name="section" maxLength={80} defaultValue={field?.section ?? ''} />}</Field>
        <Field label="Help text" className="sm:col-span-2" error={fe.helpText}>{(p) => <Input {...p} name="helpText" maxLength={300} defaultValue={field?.helpText ?? ''} />}</Field>
        {hasOptions && (
          <fieldset className="grid gap-2 sm:col-span-2">
            <legend className="mb-1 text-[0.8125rem] font-medium">Options</legend>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={`Option ${i + 1}`} value={o.label} disabled={o.archived} onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                {o.value && field ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => setOptions(options.map((x, j) => (j === i ? { ...x, archived: !x.archived } : x)))}>{o.archived ? 'Restore' : 'Archive'}</Button>
                ) : <Button type="button" size="sm" variant="ghost" aria-label="Remove option" onClick={() => setOptions(options.filter((_, j) => j !== i))}><Trash2 className="size-3.5" aria-hidden /></Button>}
              </div>
            ))}
            <div><Button type="button" size="sm" variant="secondary" onClick={() => setOptions([...options, { value: '', label: '' }])}>Add option</Button></div>
            {fe.options && <p className="text-xs text-danger">{fe.options}</p>}
            {field && <p className="text-xs text-fg-muted">An option in use is archived instead of removed, so records that hold it keep it.</p>}
          </fieldset>
        )}
        {numeric && <><Field label="Smallest value" error={fe.min}>{(p) => <Input {...p} name="min" type="number" defaultValue={field?.config.min ?? ''} />}</Field><Field label="Largest value" error={fe.max}>{(p) => <Input {...p} name="max" type="number" defaultValue={field?.config.max ?? ''} />}</Field></>}
        {type === 'currency' && <Field label="Currency" hint="Three letters, such as INR">{(p) => <Input {...p} name="currency" maxLength={3} defaultValue={field?.config.currency ?? ''} className="uppercase" />}</Field>}
        {(type === 'short_text' || type === 'long_text') && <Field label="Maximum length" hint="Characters. Empty: 200 for short text, 5,000 for long text." error={fe['config.maxLength']}>{(p) => <Input {...p} name="maxLength" type="number" min={1} max={10000} defaultValue={field?.config.maxLength ?? ''} />}</Field>}
        {type !== 'file' && <Field label="Default value" hint={type === 'checkbox' ? 'true or false' : hasOptions ? 'The option label as a key, such as o_positive' : numeric ? 'Optional. A number within the smallest and largest value.' : 'Optional.'} error={fe.defaultValue}>{(p) => <Input {...p} name="defaultValue" defaultValue={field?.defaultValue === null || field?.defaultValue === undefined ? '' : String(field.defaultValue)} />}</Field>}
        <div className="grid gap-2 sm:col-span-2">
          <Checkbox label="Required" description="The record cannot be saved without it (the default fills it in when there is one)." checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <Checkbox label="Switched on" description="A switched-off field is hidden from forms; its values are kept." checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {entity === 'employee' && <Checkbox label="Employees fill it in themselves" description="They can change it on their own profile." checked={employeeEditable} onChange={(e) => setEmployeeEditable(e.target.checked)} />}
        </div>
        <RolePicker label="Who can see it" hint="Workspace access. None ticked: everyone who can see the record." roles={roles.filter((r) => r.key !== 'super_workspace')} picked={viewRoles} onToggle={(k) => toggle(viewRoles, setViewRoles, k)} />
        <RolePicker label="Who can change it" hint="Workspace access. None ticked: everyone who can change the record." roles={roles.filter((r) => r.key !== 'super_workspace')} picked={editRoles} onToggle={(k) => toggle(editRoles, setEditRoles, k)} />
      </form>
    </Dialog>
  );
}

function RolePicker({ label, hint, roles, picked, onToggle }: { label: string; hint: string; roles: RoleOpt[]; picked: string[]; onToggle: (k: string) => void }) {
  return (
    <fieldset className="grid content-start gap-1.5">
      <legend className="text-[0.8125rem] font-medium">{label}</legend>
      <p className="text-xs text-fg-muted">{hint}</p>
      <div className="grid max-h-40 gap-1 overflow-auto rounded-md border border-border p-2">
        {roles.map((r) => <Checkbox key={r.key} label={r.name} checked={picked.includes(r.key)} onChange={() => onToggle(r.key)} />)}
        {!roles.length && <Badge>Access levels are not visible to you</Badge>}
      </div>
    </fieldset>
  );
}

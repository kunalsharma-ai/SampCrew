'use client';
import type { CustomFieldDefinition } from '@crew/contracts';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useState, useTransition } from 'react';
import { loadFieldValuesAction, saveFieldValuesAction, uploadFieldFileAction } from '@/app/(app)/custom-field-actions';

export interface FieldValue { field: CustomFieldDefinition; value: unknown; text: string; editable: boolean; fits: boolean }

/**
 * The workspace's own fields on a record (employee, asset, verification case ...), as HR Workspace Admin defines them.
 * Shows what the member may see; fields they may change are editable, with the same rules the API enforces.
 */
export function CustomFieldsCard({ entity, recordId, initial, title = 'Additional details', path }: { entity: string; recordId: string; initial: FieldValue[]; title?: string; path?: string }) {
  const [rows, setRows] = useState(initial);
  const [vals, setVals] = useState<Record<string, unknown>>(Object.fromEntries(initial.map((r) => [r.field.key, r.value ?? r.field.defaultValue ?? null])));
  const [editing, setEditing] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  if (!rows.length) return null;
  const canEdit = rows.some((r) => r.editable);
  const sections = [...new Set(rows.map((r) => r.field.section ?? ''))];
  const set = (k: string, v: unknown) => setVals((x) => ({ ...x, [k]: v }));

  const save = () => start(async () => {
    const out = Object.fromEntries(rows.filter((r) => r.editable).map((r) => [r.field.key, vals[r.field.key] === '' ? null : vals[r.field.key]]));
    const r = await saveFieldValuesAction(entity, recordId, out, path);
    if (r.ok && r.data) { setRows(r.data); setEditing(false); setFe({}); setFlash({ tone: 'success', text: 'Saved.' }); }
    else if (!r.ok) { setFlash({ tone: 'danger', text: r.message }); setFe(Object.fromEntries(Object.entries(r.fieldErrors ?? {}).map(([k, v]) => [k.replace(/^customFields\./, ''), v]))); }
  });

  return (
    <Card>
      <CardHeader title={title} description="Fields your workspace added." action={canEdit && !editing ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Button> : undefined} />
      <CardBody className="grid gap-5">
        {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
        {sections.map((s) => (
          <div key={s} className="grid gap-3">
            {s && <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{s}</h3>}
            <div className="grid gap-4 sm:grid-cols-2">
              {rows.filter((r) => (r.field.section ?? '') === s).map((r) => editing && r.editable
                ? <FieldInput key={r.field.id} r={r} value={vals[r.field.key]} onChange={(v) => set(r.field.key, v)} error={fe[r.field.key]} entity={entity} recordId={recordId} />
                : (
                  <div key={r.field.id} className="grid gap-0.5 text-[0.8125rem]">
                    <span className="text-xs text-fg-subtle">{r.field.label}{r.field.archivedAt ? ' (archived)' : ''}</span>
                    {r.field.type === 'file' && r.value ? <a className="text-accent hover:underline" href={`/field-files/${(r.value as { fileId: string }).fileId}`}>{r.text}</a> : <span className={r.fits ? '' : 'text-warning'}>{r.text || '—'}{!r.fits ? ' (no longer fits this field: correct it)' : ''}</span>}
                  </div>
                ))}
            </div>
          </div>
        ))}
        {editing && <div className="flex gap-2"><Button loading={pending} onClick={save}>Save</Button><Button variant="secondary" onClick={() => { setEditing(false); setFe({}); }}>Cancel</Button></div>}
      </CardBody>
    </Card>
  );
}

/** A button that opens a record's custom fields (for rows in a list, such as leave requests). */
export function RecordFieldsButton({ entity, recordId, title = 'Details' }: { entity: string; recordId: string; title?: string }) {
  const [rows, setRows] = useState<FieldValue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => {
        const r = await loadFieldValuesAction(entity, recordId);
        if (r.ok) setRows(r.data ?? []);
        else setError(r.message);
      })}>{title}</Button>
      {(rows || error) && (
        <Dialog open onClose={() => { setRows(null); setError(null); }} title={title} size="lg">
          {error ? <Alert tone="danger">{error}</Alert> : rows && rows.length ? <CustomFieldsCard entity={entity} recordId={recordId} initial={rows} /> : <p className="text-[0.8125rem] text-fg-muted">No additional details for this record.</p>}
        </Dialog>
      )}
    </>
  );
}

export function FieldInput({ r, value, onChange, error, entity, recordId }: { r: FieldValue; value: unknown; onChange: (v: unknown) => void; error?: string; entity: string; recordId: string }) {
  const f = r.field;
  const opts = f.options.filter((o) => !o.archived || o.value === value || (Array.isArray(value) && value.includes(o.value)));
  const text = value === null || value === undefined ? '' : String(value);
  const [uploading, start] = useTransition();
  const [upErr, setUpErr] = useState<string | null>(null);
  return (
    <Field label={f.label} required={f.required} hint={f.helpText ?? undefined} error={error ?? upErr ?? undefined} help={false} className={f.type === 'long_text' ? 'sm:col-span-2' : ''}>
      {(p) => {
        switch (f.type) {
          case 'long_text': return <Textarea {...p} rows={3} value={text} maxLength={f.config.maxLength ?? 5000} onChange={(e) => onChange(e.target.value)} />;
          case 'number': case 'decimal': case 'currency': return <Input {...p} inputMode="decimal" value={text} placeholder={f.config.placeholder} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
          case 'yes_no': return <Select {...p} value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')}><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></Select>;
          case 'searchable_dropdown': {
            const listId = `cf-${f.key}-options`;
            const shown = opts.find((o) => o.value === value)?.label ?? text;
            return <><Input {...p} list={listId} defaultValue={shown} placeholder={f.config.placeholder ?? 'Type to search'} onChange={(e) => { const o = opts.find((x) => x.label === e.target.value || x.value === e.target.value); onChange(o ? o.value : e.target.value || null); }} /><datalist id={listId}>{opts.map((o) => <option key={o.value} value={o.label} />)}</datalist></>;
          }
          case 'date': return <Input {...p} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
          case 'datetime': return <Input {...p} type="datetime-local" value={text.slice(0, 16)} onChange={(e) => onChange(e.target.value)} />;
          case 'email': return <Input {...p} type="email" value={text} onChange={(e) => onChange(e.target.value)} />;
          case 'phone': return <Input {...p} type="tel" value={text} onChange={(e) => onChange(e.target.value)} />;
          case 'url': return <Input {...p} type="url" value={text} placeholder="https://" onChange={(e) => onChange(e.target.value)} />;
          case 'checkbox': return <div {...p}><Checkbox label="Yes" checked={value === true} onChange={(e) => onChange(e.target.checked)} /></div>;
          case 'dropdown': return <Select {...p} value={text} onChange={(e) => onChange(e.target.value || null)}><option value="">Choose…</option>{opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>;
          case 'radio': return <div {...p} role="radiogroup" className="flex flex-wrap gap-3">{opts.map((o) => <label key={o.value} className="flex items-center gap-1.5 text-[0.8125rem]"><input type="radio" name={f.key} checked={value === o.value} onChange={() => onChange(o.value)} />{o.label}</label>)}</div>;
          case 'multi_select': {
            const arr = Array.isArray(value) ? (value as string[]) : [];
            return <div {...p} className="flex flex-wrap gap-3">{opts.map((o) => <Checkbox key={o.value} label={o.label} checked={arr.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value))} />)}</div>;
          }
          case 'file': return (
            <div className="grid gap-1">
              {value ? <span className="text-[0.8125rem]">{(value as { fileName: string }).fileName}</span> : null}
              <Input {...p} type="file" disabled={uploading} onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const form = new FormData();
                form.set('key', f.key);
                form.set('file', file);
                start(async () => { const res = await uploadFieldFileAction(entity, recordId, form); if (res.ok && res.data) { setUpErr(null); onChange(res.data); } else if (!res.ok) setUpErr(res.message); });
              }} />
            </div>
          );
          default: return <Input {...p} value={text} placeholder={f.config.placeholder} maxLength={f.config.maxLength ?? 500} onChange={(e) => onChange(e.target.value)} />;
        }
      }}
    </Field>
  );
}

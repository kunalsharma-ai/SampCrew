'use client';
import { CRM_FIELD_FLAG_LABEL, CRM_FIELD_FLAGS, CRM_FIELD_TYPES, type CrmFieldFlag, isOptionField } from '@crew/contracts';
import { Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { ArrowDown, ArrowUp, Plus, TextCursorInput } from 'lucide-react';
import { useState } from 'react';
import { useRunner } from '../../use-runner';
import { archiveFieldAction, orderFieldsAction, saveFieldAction } from '../crm-actions';
import type { CrmField } from '../crm-types';
import { NoticeBar } from '../crm-ui';

export const FIELD_TYPE_LABEL: Record<string, string> = {
  short_text: 'Short text', long_text: 'Long text', number: 'Number', decimal: 'Decimal', currency: 'Currency', date: 'Date', datetime: 'Date and time', email: 'Email',
  phone: 'Phone number', url: 'URL', dropdown: 'Dropdown', searchable_dropdown: 'Searchable dropdown', multi_select: 'Multi-select', checkbox: 'Checkbox', yes_no: 'Yes / No',
  radio: 'Radio buttons', file: 'File upload',
};

type Draft = {
  id: string | null; label: string; name: string; type: string; description: string; placeholder: string; required: boolean; options: string; group: string;
  min: string; max: string; maxLength: string; currency: string; flags: CrmFieldFlag[]; active: boolean; hrWorkspaceId: string;
};
const blankDraft = (owner: string | null): Draft => ({
  id: null, label: '', name: '', type: 'short_text', description: '', placeholder: '', required: false, options: '', group: '', min: '', max: '', maxLength: '', currency: 'INR',
  flags: [...CRM_FIELD_FLAGS], active: true, hrWorkspaceId: owner ?? '',
});
const draftOf = (f: CrmField): Draft => ({
  id: f.id, label: f.label, name: f.name, type: f.type, description: f.description ?? '', placeholder: f.placeholder ?? '', required: f.required,
  options: f.options.filter((o) => !o.archived).map((o) => (o.value === o.label ? o.label : `${o.value} | ${o.label}`)).join('\n'), group: f.section ?? '',
  min: f.config.min?.toString() ?? '', max: f.config.max?.toString() ?? '', maxLength: f.config.maxLength?.toString() ?? '', currency: f.config.currency ?? 'INR',
  flags: f.flags, active: f.enabled, hrWorkspaceId: f.hrWorkspaceId ?? '',
});
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);

export function FieldsManager({ fields, canCreate, owners }: { fields: CrmField[]; canCreate: boolean; owners: { id: string | null; name: string }[] }) {
  const { pending, notice, run } = useRunner();
  const [d, setD] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const live = fields.filter((f) => !f.archivedAt);
  const archived = fields.filter((f) => f.archivedAt);
  const up = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => (x ? { ...x, [k]: v } : x));
  const move = (i: number, by: number) => {
    const ids = live.filter((f) => f.canEdit).map((f) => f.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    run(() => orderFieldsAction(ids));
  };
  const save = () => {
    if (!d) return;
    const options = d.options.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [a, b] = l.split('|').map((x) => x.trim());
      return b ? { value: a!.slice(0, 80), label: b } : { value: slug(a!) || a!.slice(0, 80), label: a! };
    });
    const validation: Record<string, unknown> = {};
    if (d.min) validation.min = Number(d.min);
    if (d.max) validation.max = Number(d.max);
    if (d.maxLength) validation.maxLength = Number(d.maxLength);
    if (d.type === 'currency') validation.currency = d.currency || 'INR';
    const body: Record<string, unknown> = {
      label: d.label, type: d.type, description: d.description || null, placeholder: d.placeholder || null, required: d.required, options: isOptionField(d.type) ? options : [],
      validation, group: d.group || null, flags: d.flags, active: d.active,
    };
    if (!d.id) { body.name = d.name || slug(d.label); body.hrWorkspaceId = d.hrWorkspaceId || null; }
    run(async () => {
      const r = await saveFieldAction(d.id, body);
      if (!r.ok) setErrors(r.fieldErrors ?? {});
      return r;
    }, () => { setD(null); setErrors({}); });
  };
  const editable = live.filter((f) => f.canEdit);

  return (
    <div className="grid gap-6">
      <NoticeBar notice={notice} />
      <Card>
        <CardHeader title="Candidate fields" description="Company-wide fields apply to every HR Workspace; an HR Workspace can also have its own." action={canCreate && <Button size="sm" onClick={() => { setErrors({}); setD(blankDraft(owners[0]?.id ?? null)); }}><Plus className="size-3.5" /> New field</Button>} />
        {live.length === 0 ? (
          <EmptyState icon={<TextCursorInput className="size-5" />} title="No custom fields yet" description="Add questions such as “Shift preference” or “Two-wheeler licence” to the candidate form." />
        ) : (
          <Table aria-label="Custom fields">
            <THead><TR><TH>Field</TH><TH>Type</TH><TH>Applies to</TH><TH>Shown in</TH><TH>Answers</TH><TH /></TR></THead>
            <TBody>
              {live.map((f) => {
                const i = editable.findIndex((x) => x.id === f.id);
                return (
                  <TR key={f.id}>
                    <TD><span className="font-medium">{f.label}</span>{f.required && <Badge tone="warning" className="ml-2">Required</Badge>}{!f.enabled && <Badge tone="neutral" className="ml-2">Inactive</Badge>}<span className="block font-mono text-xs text-fg-muted">{f.name}</span></TD>
                    <TD>{FIELD_TYPE_LABEL[f.type] ?? f.type}{f.options.length > 0 && <span className="block text-xs text-fg-muted">{f.options.filter((o) => !o.archived).length} options</span>}</TD>
                    <TD>{f.hrWorkspaceName ?? 'Every HR Workspace'}</TD>
                    <TD className="text-xs text-fg-muted">{f.flags.map((x) => CRM_FIELD_FLAG_LABEL[x].replace(/^(Visible in|Available in) /, '')).join(', ') || 'Nowhere'}</TD>
                    <TD>{f.valueCount ?? 0}</TD>
                    <TD className="whitespace-nowrap text-right">
                      {f.canEdit && <>
                        <Button size="sm" variant="ghost" aria-label={`Move ${f.label} up`} disabled={i <= 0 || pending} onClick={() => move(i, -1)}><ArrowUp className="size-3.5" /></Button>
                        <Button size="sm" variant="ghost" aria-label={`Move ${f.label} down`} disabled={i === editable.length - 1 || pending} onClick={() => move(i, 1)}><ArrowDown className="size-3.5" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => { setErrors({}); setD(draftOf(f)); }}>Edit</Button>
                        <Button data-delete-area="recruitment" data-delete={`candidate field ${f.label}`} size="sm" variant="ghost" onClick={() => run(() => archiveFieldAction(f.id, true))}>Archive</Button>
                      </>}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>
      {archived.length > 0 && (
        <Card>
          <CardHeader title="Archived fields" description="Hidden from forms and lists. Their answers are kept and come back when restored." />
          <ul className="divide-y divide-border">
            {archived.map((f) => (
              <li key={f.id} className="flex items-center justify-between px-5 py-2.5 text-[0.8125rem]">
                <span>{f.label} <span className="text-xs text-fg-muted">· {FIELD_TYPE_LABEL[f.type]} · {f.valueCount ?? 0} answers</span></span>
                {f.canEdit && <Button size="sm" variant="ghost" onClick={() => run(() => archiveFieldAction(f.id, false))}>Restore</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Dialog open={!!d} onClose={() => setD(null)} title={d?.id ? `Edit ${d.label}` : 'New field'} size="lg"
        footer={<><Button variant="ghost" onClick={() => setD(null)}>Cancel</Button><Button loading={pending} disabled={!d?.label.trim()} onClick={save}>{d?.id ? 'Save field' : 'Create field'}</Button></>}>
        {d && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Field label" required error={errors.label}>{(p) => <Input {...p} value={d.label} onChange={(e) => up('label', e.target.value)} />}</Field>
            <Field label="Field name" hint={d.id ? 'Cannot change after creating' : 'Used in imports and exports'} error={errors.name}>{(p) => <Input {...p} disabled={!!d.id} value={d.id ? d.name : d.name || slug(d.label)} onChange={(e) => up('name', slug(e.target.value))} />}</Field>
            <Field label="Field type" error={errors.type}>{(p) => <Select {...p} disabled={!!d.id} value={d.type} onChange={(e) => up('type', e.target.value)}>{CRM_FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABEL[t]}</option>)}</Select>}</Field>
            {!d.id && owners.length > 1 && <Field label="Applies to">{(p) => <Select {...p} value={d.hrWorkspaceId} onChange={(e) => up('hrWorkspaceId', e.target.value)}>{owners.map((o) => <option key={o.id ?? ''} value={o.id ?? ''}>{o.name}</option>)}</Select>}</Field>}
            <Field label="Field group" hint="Shown as a heading on the form">{(p) => <Input {...p} value={d.group} onChange={(e) => up('group', e.target.value)} />}</Field>
            <Field label="Placeholder">{(p) => <Input {...p} value={d.placeholder} onChange={(e) => up('placeholder', e.target.value)} />}</Field>
            <Field label="Description" className="sm:col-span-2">{(p) => <Input {...p} value={d.description} onChange={(e) => up('description', e.target.value)} />}</Field>
            {isOptionField(d.type) && (
              <Field label="Options" required hint="One per line. Use “value | Label” to set the stored value." error={errors.options} className="sm:col-span-2">{(p) => <Textarea {...p} rows={4} value={d.options} onChange={(e) => up('options', e.target.value)} />}</Field>
            )}
            {['number', 'decimal', 'currency'].includes(d.type) && <>
              <Field label="Minimum value">{(p) => <Input {...p} inputMode="decimal" value={d.min} onChange={(e) => up('min', e.target.value)} />}</Field>
              <Field label="Maximum value">{(p) => <Input {...p} inputMode="decimal" value={d.max} onChange={(e) => up('max', e.target.value)} />}</Field>
            </>}
            {d.type === 'currency' && <Field label="Currency">{(p) => <Input {...p} value={d.currency} onChange={(e) => up('currency', e.target.value.toUpperCase())} />}</Field>}
            {['short_text', 'long_text'].includes(d.type) && <Field label="Maximum length">{(p) => <Input {...p} inputMode="numeric" value={d.maxLength} onChange={(e) => up('maxLength', e.target.value)} />}</Field>}
            <div className="grid gap-2 sm:col-span-2">
              <Checkbox label="Required field" checked={d.required} onChange={(e) => up('required', e.target.checked)} />
              <Checkbox label="Active" description="Inactive fields keep their answers but leave the form" checked={d.active} onChange={(e) => up('active', e.target.checked)} />
              {CRM_FIELD_FLAGS.map((fl) => (
                <Checkbox key={fl} label={CRM_FIELD_FLAG_LABEL[fl]} checked={d.flags.includes(fl)} onChange={(e) => up('flags', e.target.checked ? [...d.flags, fl] : d.flags.filter((x) => x !== fl))} />
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

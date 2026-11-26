'use client';
import type { EmployeeFormSettings, FormFieldRule } from '@crew/contracts';
import { Alert, Button, Card, CardHeader, Checkbox, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveEmployeeFormAction } from './actions';

export function EmployeeFormEditor({ settings }: { settings: EmployeeFormSettings }) {
  const router = useRouter();
  const [domains, setDomains] = useState(settings.workEmailDomains.join(', '));
  const [enforce, setEnforce] = useState(settings.enforceWorkEmailDomain);
  const [fields, setFields] = useState<Record<string, FormFieldRule>>(() => Object.fromEntries(settings.resolved.map((f) => [f.key, { visible: f.visible, required: f.required, label: f.label === f.builtInLabel ? null : f.label, hint: f.hint }])));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const edit = settings.canChange;
  const setRule = (k: string, patch: Partial<FormFieldRule>) => setFields((f) => ({ ...f, [k]: { ...f[k]!, ...patch } }));
  const save = () => start(async () => {
    const list = domains.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
    const body = {
      workEmailDomains: list, enforceWorkEmailDomain: enforce,
      fields: Object.fromEntries(settings.resolved.filter((f) => !f.locked).map((f) => [f.key, { ...fields[f.key]!, label: fields[f.key]!.label?.trim() || null, hint: fields[f.key]!.hint?.trim() || null }])),
    };
    const r = await saveEmployeeFormAction(body);
    setMsg({ ok: r.ok, text: r.ok ? r.message ?? 'Saved.' : r.message });
    if (r.ok) router.refresh();
  });
  return (
    <div className="grid gap-5" data-testid="employee-form-settings">
      {!edit && <Alert tone="info">Only the Super Workspace changes this form. You see how it is set up.</Alert>}
      {msg && <Alert tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Alert>}
      <Card>
        <CardHeader title="Work email domain" description="The first domain is shown as the example on Add Employee (name@yourdomain). Turn on the check to refuse work emails outside these domains." />
        <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2">
          <Field label="Company domains" hint="Separate several with commas, such as acme.com, acme.in">{(p) => <Input {...p} disabled={!edit} placeholder="yourcompany.com" value={domains} onChange={(e) => setDomains(e.target.value)} data-testid="employee-form-domains" />}</Field>
          <Checkbox label="Only allow these domains" description="Add Employee and imports refuse a work email on any other domain." checked={enforce} disabled={!edit} onChange={(e) => setEnforce(e.target.checked)} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Fields" description="Locked fields are needed to create an employee and are always shown and required." />
        <Table aria-label="Add Employee fields">
          <THead><TR><TH>Field</TH><TH>Step</TH><TH>Shown</TH><TH>Required</TH><TH>Label</TH><TH>Help line</TH></TR></THead>
          <TBody>
            {settings.resolved.map((f) => {
              const r = fields[f.key]!;
              const fixed = f.locked || !edit;
              return (
                <TR key={f.key} data-testid={`employee-form-field-${f.key}`}>
                  <TD className="font-medium">{f.builtInLabel}{f.locked && <span className="block text-xs text-fg-subtle">Locked</span>}</TD>
                  <TD className="text-xs text-fg-muted">{f.step}</TD>
                  <TD><input type="checkbox" aria-label={`Show ${f.builtInLabel}`} checked={r.visible} disabled={fixed || f.noHide} onChange={(e) => setRule(f.key, { visible: e.target.checked, required: e.target.checked ? r.required : false })} /></TD>
                  <TD><input type="checkbox" aria-label={`Require ${f.builtInLabel}`} checked={r.required} disabled={fixed || !r.visible} onChange={(e) => setRule(f.key, { required: e.target.checked })} /></TD>
                  <TD><Input aria-label={`Label for ${f.builtInLabel}`} className="h-8 w-40" maxLength={60} disabled={!edit} placeholder={f.builtInLabel} value={r.label ?? ''} onChange={(e) => setRule(f.key, { label: e.target.value })} /></TD>
                  <TD><Input aria-label={`Help line for ${f.builtInLabel}`} className="h-8 w-56" maxLength={200} disabled={!edit} value={r.hint ?? ''} onChange={(e) => setRule(f.key, { hint: e.target.value })} /></TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      </Card>
      {edit && <div className="flex items-center gap-3"><Button loading={pending} onClick={save} data-testid="employee-form-save">Save form</Button>{settings.updatedAt && <span className="text-xs text-fg-subtle">Last changed {new Date(settings.updatedAt).toLocaleString()}{settings.updatedBy ? ` by ${settings.updatedBy}` : ''}</span>}</div>}
    </div>
  );
}

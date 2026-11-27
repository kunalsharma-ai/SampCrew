'use client';
import type { FormFieldRule, FormKey, FormSummary, FormView } from '@crew/contracts';
import { Alert, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, Table, TBody, TD, TH, THead, TR, cn } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { saveFormAction } from './actions';

/** The list of forms: choosing one opens it on the right, so it is always clear which form is being set up. */
export function FormPicker({ forms, current }: { forms: FormSummary[]; current: FormKey }) {
  return (
    <nav aria-label="Forms" className="grid content-start gap-2" data-testid="form-picker">
      {forms.map((f) => (
        <Link
          key={f.key}
          href={`/settings/forms?form=${f.key}`}
          aria-current={f.key === current ? 'page' : undefined}
          data-testid={`form-pick-${f.key}`}
          className={cn('rounded-xl border px-4 py-3 text-left transition-colors', f.key === current ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50 hover:bg-bg-subtle')}
        >
          <div className="text-sm font-medium text-fg">{f.label}</div>
          <div className="mt-0.5 text-xs text-fg-muted">
            {f.builtInFields ? `${f.builtInFields} built-in` : 'No built-in fields'} · {f.customFields} custom{f.hiddenFields ? ` · ${f.hiddenFields} hidden` : ''}{f.requiredFields ? ` · ${f.requiredFields} required` : ''}
          </div>
        </Link>
      ))}
    </nav>
  );
}

type Rule = FormFieldRule;

/** The built-in fields of one form: shown, required, label, placeholder and help line, saved together. */
export function FormRulesEditor({ view }: { view: FormView }) {
  const router = useRouter();
  const edit = view.canChange;
  const isAddEmployee = view.form.key === 'add_employee';
  const [domains, setDomains] = useState((view.workEmailDomains ?? []).join(', '));
  const [enforce, setEnforce] = useState(view.enforceWorkEmailDomain ?? false);
  const [rules, setRules] = useState<Record<string, Rule>>(() => Object.fromEntries(view.resolved.map((f) => [f.key, {
    visible: f.visible, required: f.required, label: f.label === f.builtInLabel ? null : f.label, hint: f.hint, placeholder: f.placeholder,
  }])));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const setRule = (k: string, patch: Partial<Rule>) => setRules((r) => ({ ...r, [k]: { ...r[k]!, ...patch } }));
  const save = () => start(async () => {
    const fields = Object.fromEntries(view.resolved.filter((f) => !f.locked).map((f) => {
      const r = rules[f.key]!;
      return [f.key, { visible: r.visible, required: r.visible && r.required, label: r.label?.trim() || null, hint: r.hint?.trim() || null, placeholder: r.placeholder?.trim() || null }];
    }));
    const body: Record<string, unknown> = isAddEmployee
      ? { workEmailDomains: domains.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean), enforceWorkEmailDomain: enforce, fields }
      : { fields };
    const r = await saveFormAction(view.form.key, body);
    setMsg({ ok: r.ok, text: r.ok ? r.message ?? 'Saved.' : r.message });
    if (r.ok) router.refresh();
  });
  const allShown = view.resolved.every((f) => rules[f.key]!.visible);
  return (
    <div className="grid gap-5" data-testid="form-rules">
      {msg && <Alert tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Alert>}
      {isAddEmployee && (
        <Card>
          <CardHeader title="Work email domain" description="The first domain is shown as the example on Add Employee (name@yourdomain). Turn on the check to refuse work emails outside these domains." />
          <div className="grid gap-3 px-5 pb-5 sm:grid-cols-2">
            <Field label="Company domains" hint="Separate several with commas, such as acme.com, acme.in">{(p) => <Input {...p} disabled={!edit} placeholder="yourcompany.com" value={domains} onChange={(e) => setDomains(e.target.value)} data-testid="employee-form-domains" />}</Field>
            <Checkbox label="Only allow these domains" description="Add Employee and imports refuse a work email on any other domain." checked={enforce} disabled={!edit} onChange={(e) => setEnforce(e.target.checked)} />
          </div>
        </Card>
      )}
      <Card>
        <CardHeader
          title="Built-in fields"
          description={view.resolved.length
            ? 'No field is required unless you make it so. Untick Shown to take a field off the form; a hidden field keeps any value already saved.'
            : 'This form has no built-in fields besides the record itself. Add the fields it should ask for under Custom fields.'}
          action={edit && view.resolved.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setRules((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, { ...x, visible: allShown ? !!view.resolved.find((f) => f.key === k)?.locked : true, required: allShown ? x.required && !!view.resolved.find((f) => f.key === k)?.locked : x.required }])))}>
              {allShown ? 'Hide all optional' : 'Show all'}
            </Button>
          ) : undefined}
        />
        {view.resolved.length ? (
          <Table aria-label={`${view.form.label} fields`}>
            <THead><TR><TH>Field</TH><TH>Section</TH><TH>Shown</TH><TH>Required</TH><TH>Label</TH><TH>Placeholder</TH><TH>Help line</TH></TR></THead>
            <TBody>
              {view.resolved.map((f) => {
                const r = rules[f.key]!;
                const fixed = f.locked || !edit;
                return (
                  <TR key={f.key} data-testid={`employee-form-field-${f.key}`}>
                    <TD className="font-medium">
                      {f.builtInLabel}
                      {f.locked && <span className="block text-xs font-normal text-fg-subtle">Always on: a record needs it</span>}
                      {!f.locked && f.fallback && <span className="block text-xs font-normal text-fg-subtle">Hidden or empty: {f.fallback.toLowerCase()}</span>}
                    </TD>
                    <TD className="text-xs text-fg-muted">{f.section}</TD>
                    <TD><input type="checkbox" aria-label={`Show ${f.builtInLabel}`} checked={r.visible} disabled={fixed} onChange={(e) => setRule(f.key, { visible: e.target.checked, required: e.target.checked ? r.required : false })} /></TD>
                    <TD><input type="checkbox" aria-label={`Require ${f.builtInLabel}`} checked={r.required} disabled={fixed || !r.visible} onChange={(e) => setRule(f.key, { required: e.target.checked })} /></TD>
                    <TD><Input aria-label={`Label for ${f.builtInLabel}`} className="h-8 w-40" maxLength={60} disabled={!edit} placeholder={f.builtInLabel} value={r.label ?? ''} onChange={(e) => setRule(f.key, { label: e.target.value })} /></TD>
                    <TD><Input aria-label={`Placeholder for ${f.builtInLabel}`} className="h-8 w-40" maxLength={80} disabled={!edit} value={r.placeholder ?? ''} onChange={(e) => setRule(f.key, { placeholder: e.target.value })} /></TD>
                    <TD><Input aria-label={`Help line for ${f.builtInLabel}`} className="h-8 w-56" maxLength={200} disabled={!edit} value={r.hint ?? ''} onChange={(e) => setRule(f.key, { hint: e.target.value })} /></TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        ) : <div className="px-5 pb-5"><EmptyState title="No built-in fields" description="Leave type and dates are always part of a leave request; asset, verification, candidate and client records take their extra details from custom fields." /></div>}
      </Card>
      {edit && (view.resolved.length > 0 || isAddEmployee) && (
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={pending} onClick={save} data-testid="employee-form-save">Save {view.form.label} form</Button>
          {view.updatedAt && <span className="text-xs text-fg-subtle" suppressHydrationWarning>Last changed {new Date(view.updatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}{view.updatedBy ? ` by ${view.updatedBy}` : ''}</span>}
        </div>
      )}
    </div>
  );
}

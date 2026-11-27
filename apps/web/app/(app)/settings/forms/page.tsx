import { FORM_KEYS, type FormKey, type FormSummary, type FormView } from '@crew/contracts';
import { Alert, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Role } from '@/lib/types';
import { FieldsView } from './fields-view';
import type { FieldHistory } from './types';
import { FormPicker, FormRulesEditor } from './form-rules';

export const metadata: Metadata = { title: 'Form management' };

/**
 * Form management (issue #91): one page in the Super Workspace for every form in SampCrew. Pick a form, then set each
 * built-in field (shown, required, label, placeholder, help line) and add, change, hide or remove its custom fields.
 * HR Workspaces and Employee Workspaces see the forms exactly as set here; other members see this page read-only.
 */
export default async function FormsPage({ searchParams }: { searchParams: Promise<{ form?: string }> }) {
  const { form } = await searchParams;
  const key: FormKey = (FORM_KEYS as readonly string[]).includes(form ?? '') ? (form as FormKey) : 'add_employee';
  const [forms, view, roles] = await Promise.all([
    load<FormSummary[]>('/forms'),
    load<FormView>(`/forms/${key}`),
    loadOptional<Role[]>('/roles'),
  ]);
  const history = view.canChange ? ((await loadOptional<FieldHistory[]>('/custom-fields/history')) ?? []) : [];
  const shared = view.form.entity === 'employee';
  return (
    <>
      <PageHeader
        title="Form management"
        description="Every form in SampCrew in one place. Choose a form, then decide which fields it shows, which are required, what they are called and which extra fields it asks for. HR Workspaces and Employee Workspaces get the forms exactly as set here."
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <FormPicker forms={forms} current={key} />
        <div className="grid min-w-0 content-start gap-6" data-testid="form-manager" data-form={key}>
          <div className="rounded-xl border border-accent/40 bg-accent/5 px-5 py-4" data-testid="form-current">
            <div className="text-xs font-medium uppercase tracking-wide text-fg-muted">You are customising</div>
            <h2 className="mt-1 text-lg font-semibold text-fg">{view.form.label} form</h2>
            <p className="mt-1 text-[0.8125rem] text-fg-muted">{view.form.where} Filled in by {view.form.usedBy}.</p>
          </div>
          {!view.canChange && <Alert tone="info">Only the Super Workspace sets up forms. You see how this form is set up.</Alert>}
          <FormRulesEditor key={`${key}:${view.updatedAt ?? ''}`} view={view} />
          {shared && (
            <Alert tone="info" title="Custom employee fields">
              These fields belong to the employee record: they show on the Add Employee form, the employee&apos;s profile and My profile alike, so they are set up once for both forms.
            </Alert>
          )}
          <FieldsView fields={view.customFields} roles={(roles ?? []).map((r) => ({ key: r.key, name: r.name }))} history={history} entity={view.form.entity} readOnly={!view.canChange} />
        </div>
      </div>
    </>
  );
}

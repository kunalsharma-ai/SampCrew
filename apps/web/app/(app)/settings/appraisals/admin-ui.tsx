'use client';
import { Alert, Button, Checkbox, DatePicker, Dialog, Field, Input, Select } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';
import type { AppraisalCycle, AppraisalForm } from '@/lib/types';
import { addTemplateAction, archiveFormAction, cycleCommandAction, duplicateFormAction, saveCycleAction, saveFormAction } from '../../appraisal/actions';

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const run = (fn: () => Promise<ActionResult<unknown>>, after?: (r: ActionResult<unknown>) => void) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message });
    if (r.ok) router.refresh();
    after?.(r);
  });
  return { pending, notice, run, router, setNotice };
}

/** A blank form to start from: one rated section, the usual 1–5 scale and the default bands. */
const BLANK = {
  title: 'Employee performance evaluation',
  intro: '',
  scale: { min: 1, max: 5, levels: [] },
  sections: [{ id: 'core', title: 'Core competencies', description: '', kind: 'rated', audience: 'all', active: true, questions: [{ id: 'q1', text: 'Delivers work to the agreed quality and time', kind: 'score', weight: 1, required: true, active: true }] }],
  scoring: { method: 'manager', hrScores: false, weights: { employee: 0, manager: 100, hr: 0 } },
  bands: [{ min: 0, label: 'Needs improvement' }, { min: 50, label: 'Meets expectations' }, { min: 70, label: 'Good' }, { min: 85, label: 'Very good' }, { min: 95, label: 'Outstanding' }],
  declaration: '',
};

export function FormsToolbar({ templates }: { templates: { key: string; name: string; added: boolean }[] }) {
  const { pending, notice, run, router } = useRun();
  return (
    <div className="grid gap-3">
      {templates.length > 0 && <p className="text-[0.8125rem] text-fg-muted">Ready-made: {templates.map((t) => t.name).join(', ')}.</p>}
      <div className="flex flex-wrap gap-2">
        {templates.map((t) => (
          <Button key={t.key} variant={t.added ? 'secondary' : 'primary'} loading={pending} title={t.name} onClick={() => run(() => addTemplateAction(t.key), (r) => { if (r.ok && r.data) router.push(`/settings/appraisals/forms/${(r.data as AppraisalForm).id}`); })}>
            {t.added ? `Add another copy${templates.length > 1 ? ` of ${t.name}` : ''}` : `Add ${templates.length > 1 ? t.name : 'the ready-made form'}`}
          </Button>
        ))}
        <Button variant="secondary" loading={pending} onClick={() => run(() => saveFormAction(null, { name: 'New appraisal form', definition: BLANK }), (r) => { if (r.ok && r.data) router.push(`/settings/appraisals/forms/${(r.data as AppraisalForm).id}`); })}>New blank form</Button>
      </div>
      {notice?.tone === 'danger' && <Alert tone="danger">{notice.text}</Alert>}
    </div>
  );
}

export function FormRowActions({ form }: { form: AppraisalForm }) {
  const { pending, notice, run } = useRun();
  const [ask, setAsk] = useState(false);
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => duplicateFormAction(form.id))}>Copy</Button>
      <Button data-delete-area="performance" size="sm" variant="ghost" onClick={() => setAsk(true)}>Remove</Button>
      {notice?.tone === 'danger' && <span role="alert" className="basis-full text-right text-xs text-danger">{notice.text}</span>}
      <Dialog open={ask} onClose={() => setAsk(false)} title={`Remove ${form.name}?`} footer={<><Button variant="secondary" onClick={() => setAsk(false)}>Back</Button><Button data-delete-area="performance" data-delete={`appraisal form ${form.name}`} variant="danger" loading={pending} onClick={() => run(() => archiveFormAction(form.id), () => setAsk(false))}>Remove form</Button></>}>
        <p className="text-sm text-fg-muted">Appraisals already started keep their own copy of the form. A form that a draft or active cycle uses cannot be removed.</p>
      </Dialog>
    </div>
  );
}

type Option = { id: string; name: string };

export function CycleDialog({ cycle, forms, departments, label = 'New cycle' }: { cycle?: AppraisalCycle; forms: Option[]; departments: Option[]; label?: string }) {
  const { pending, notice, run, router, setNotice } = useRun();
  const [open, setOpen] = useState(false);
  const year = new Date().getUTCFullYear();
  const [v, setV] = useState({
    name: cycle?.name ?? `Annual appraisal ${year}`,
    formId: cycle?.formId ?? '',
    periodStart: cycle?.periodStart ?? `${year}-01-01`,
    periodEnd: cycle?.periodEnd ?? `${year}-12-31`,
    selfDue: cycle?.selfDue ?? '',
    managerDue: cycle?.managerDue ?? '',
    hrDue: cycle?.hrDue ?? '',
    departmentIds: cycle?.departmentIds ?? [],
  });
  const set = (patch: Partial<typeof v>) => setV((p) => ({ ...p, ...patch }));
  const save = () => run(
    () => saveCycleAction(cycle?.id ?? null, { ...v, formId: v.formId || null, hrDue: v.hrDue || null }),
    (r) => {
      if (!r.ok) return;
      setOpen(false);
      if (!cycle && r.data) router.push(`/settings/appraisals/cycles/${(r.data as AppraisalCycle).id}`);
    },
  );
  return (
    <>
      <Button variant={cycle ? 'secondary' : 'primary'} onClick={() => { setNotice(null); setOpen(true); }}>{label}</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={cycle ? 'Edit cycle' : 'New appraisal cycle'}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!v.name.trim() || !v.selfDue || !v.managerDue} onClick={save}>Save cycle</Button></>}
      >
        <div className="grid gap-4">
          {notice?.tone === 'danger' && <Alert tone="danger">{notice.text}</Alert>}
          <Field label="Name" required>{(p) => <Input {...p} value={v.name} maxLength={160} onChange={(e) => set({ name: e.target.value })} />}</Field>
          <Field label="Form" hint="One form for everyone, or let each person get the form whose department, designation and manager rules fit them.">
            {(p) => (
              <Select {...p} value={v.formId} onChange={(e) => set({ formId: e.target.value })}>
                <option value="">Pick by each form&apos;s rules</option>
                {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </Select>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Period from" required>{(p) => <DatePicker {...p} value={v.periodStart} onChange={(x) => set({ periodStart: x })} calendarLabel="Choose the period start" />}</Field>
            <Field label="Period to" required>{(p) => <DatePicker {...p} value={v.periodEnd} min={v.periodStart} onChange={(x) => set({ periodEnd: x })} calendarLabel="Choose the period end" />}</Field>
            <Field label="Self-appraisal due" required>{(p) => <DatePicker {...p} value={v.selfDue} onChange={(x) => set({ selfDue: x })} calendarLabel="Choose the self-appraisal deadline" />}</Field>
            <Field label="Manager evaluation due" required>{(p) => <DatePicker {...p} value={v.managerDue} min={v.selfDue || undefined} onChange={(x) => set({ managerDue: x })} calendarLabel="Choose the manager deadline" />}</Field>
            <Field label="HR review due">{(p) => <DatePicker {...p} value={v.hrDue} min={v.managerDue || undefined} onChange={(x) => set({ hrDue: x })} calendarLabel="Choose the HR deadline" />}</Field>
          </div>
          {departments.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Departments <span className="font-normal text-fg-subtle">(none ticked means everyone)</span></legend>
              <div className="grid max-h-48 gap-2 overflow-auto sm:grid-cols-2">
                {departments.map((d) => (
                  <Checkbox key={d.id} label={d.name} checked={v.departmentIds.includes(d.id)} onChange={(e) => set({ departmentIds: e.target.checked ? [...v.departmentIds, d.id] : v.departmentIds.filter((x) => x !== d.id) })} />
                ))}
              </div>
            </fieldset>
          )}
        </div>
      </Dialog>
    </>
  );
}

export function CycleCommands({ cycle }: { cycle: AppraisalCycle }) {
  const { pending, notice, run } = useRun();
  const [ask, setAsk] = useState<null | 'launch' | 'publish' | 'close'>(null);
  const finalised = cycle.byStage.finalized ?? 0;
  const text = {
    launch: 'Everyone in the cycle gets an appraisal on its form and an email. The form is copied into each appraisal, so later form edits do not change them.',
    publish: `Shares the result of the ${finalised} finalised ${finalised === 1 ? 'appraisal' : 'appraisals'} with the employees, who are notified.`,
    close: 'Closes the cycle. Appraisals stay readable, and nothing new can start in it.',
  };
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {cycle.status === 'draft' && <Button onClick={() => setAsk('launch')}>Launch cycle</Button>}
        {cycle.status === 'active' && <Button disabled={!finalised} onClick={() => setAsk('publish')}>Share finalised results</Button>}
        {cycle.status === 'active' && <Button variant="secondary" onClick={() => setAsk('close')}>Close cycle</Button>}
      </div>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Dialog
        open={!!ask}
        onClose={() => setAsk(null)}
        title={ask === 'launch' ? 'Launch this cycle?' : ask === 'publish' ? 'Share finalised results?' : 'Close this cycle?'}
        footer={<><Button variant="secondary" onClick={() => setAsk(null)}>Back</Button><Button loading={pending} onClick={() => ask && run(() => cycleCommandAction(cycle.id, ask), () => setAsk(null))}>{ask === 'launch' ? 'Launch' : ask === 'publish' ? 'Share results' : 'Close cycle'}</Button></>}
      >
        <p className="text-sm text-fg-muted">{ask ? text[ask] : ''}</p>
      </Dialog>
    </div>
  );
}

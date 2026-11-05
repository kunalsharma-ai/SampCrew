'use client';
import { automation, type TriggerEvent, type WorkflowDefinition, type WorkflowStep } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Select, Textarea } from '@crew/ui';
import { ArrowDown, ArrowUp, Sparkles, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { createWorkflowAction, draftWorkflowAction, saveWorkflowAction } from './actions';
import type { Catalogue, WorkflowDetail } from './types';

type Draft = Record<string, unknown> & { id: string; type: WorkflowStep['type'] };

function blank(type: WorkflowStep['type'], cat: Catalogue, trigger: TriggerEvent, id: string): Draft {
  switch (type) {
    case 'condition': return { id, type, field: automation.fieldsFor(trigger)[0]!.key, op: 'eq', value: '' };
    case 'notify': return { id, type, to: 'manager', title: '', body: '', email: false };
    case 'delay': return { id, type, amount: 1, unit: 'days' };
    case 'approval': return { id, type, approver: 'manager', summary: '' };
    case 'assign_course': return { id, type, courseId: cat.courses[0]?.id ?? '', dueInDays: 30 };
    case 'slack': return { id, type, connectionId: cat.slackConnections.find((c) => c.status === 'active')?.id ?? '', text: '' };
    case 'webhook': return { id, type, endpointId: cat.webhookEndpoints.find((w) => w.status === 'active')?.id ?? '', message: '' };
  }
}

const nextId = (type: string, steps: Draft[]) => {
  for (let n = 1; ; n++) if (!steps.some((s) => s.id === `${type}_${n}`)) return `${type}_${n}`;
};

/** Turns the editor's loose values into a definition (numbers and lists where the step needs them). */
function toDefinition(trigger: TriggerEvent, steps: Draft[]): unknown {
  const fields = automation.fieldsFor(trigger);
  return {
    trigger: { event: trigger },
    steps: steps.map((s) => {
      if (s.type === 'condition') {
        const raw = String(s.value ?? '');
        const ft = fields.find((f) => f.key === s.field)?.type;
        const value = s.op === 'in' ? raw.split(',').map((v) => v.trim()).filter(Boolean) : ft === 'number' && raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
        return { ...s, value };
      }
      if (s.type === 'notify') {
        const { role, membershipId, ...rest } = s;
        return { ...rest, ...(s.to === 'role' ? { role } : {}), ...(s.to === 'member' ? { membershipId } : {}) };
      }
      if (s.type === 'approval') {
        const { role, ...rest } = s;
        return { ...rest, ...(s.approver === 'role' ? { role } : {}) };
      }
      if (s.type === 'delay') return { ...s, amount: Number(s.amount) };
      if (s.type === 'assign_course') return { ...s, dueInDays: s.dueInDays === '' || s.dueInDays === null ? null : Number(s.dueInDays) };
      return s;
    }),
  };
}

function fromDefinition(def: WorkflowDefinition): Draft[] {
  return def.steps.map((s) => (s.type === 'condition' ? { ...s, value: Array.isArray(s.value) ? s.value.join(', ') : String(s.value) } : { ...s })) as Draft[];
}

export function WorkflowEditor({ catalogue, workflow, aiDraft }: { catalogue: Catalogue; workflow?: WorkflowDetail; aiDraft: { available: boolean; reason: string | null } | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [trigger, setTrigger] = useState<TriggerEvent>(workflow?.trigger ?? catalogue.triggers[0]!.key);
  const [steps, setSteps] = useState<Draft[]>(workflow ? fromDefinition(workflow.latest.definition) : []);
  const [aiInteractionId, setAiInteractionId] = useState<string | undefined>();
  const [serverIssues, setServerIssues] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger' | 'warning'; text: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [drafting, startDraft] = useTransition();
  const [touched, setTouched] = useState(false);

  const fields = automation.fieldsFor(trigger);
  const roleKeys = useMemo(() => catalogue.roles.map((r) => r.key), [catalogue.roles]);
  const check = useMemo(() => automation.validateDefinition(toDefinition(trigger, steps), roleKeys), [trigger, steps, roleKeys]);
  const issues: Record<string, string> = { ...serverIssues };
  if (!check.ok) for (const i of check.issues) issues[i.path] ??= i.message;
  const nameError = name.trim().length < 3 ? 'At least 3 characters' : undefined;
  const err = (i: number, key: string) => (touched ? issues[`steps.${i}.${key}`] : undefined);

  const update = (i: number, patch: Record<string, unknown>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setSteps(next);
  };

  const save = () => {
    setTouched(true);
    setServerIssues({});
    if (nameError || !check.ok) {
      setNotice({ tone: 'danger', text: 'Fix the highlighted fields first.' });
      return;
    }
    start(async () => {
      const body = { name: name.trim(), description: description.trim(), definition: check.definition, ...(aiInteractionId ? { aiInteractionId } : {}) };
      const r = workflow ? await saveWorkflowAction(workflow.id, body) : await createWorkflowAction(body);
      if (!r.ok) {
        setNotice({ tone: 'danger', text: r.message });
        if (r.fieldErrors) setServerIssues(Object.fromEntries(Object.entries(r.fieldErrors).map(([k, v]) => [k.replace(/^definition\./, ''), v])));
        return;
      }
      setNotice({ tone: 'success', text: r.message ?? 'Saved.' });
      setAiInteractionId(undefined);
      if (!workflow && r.data) router.push(`/automation/${r.data.id}`);
      else router.refresh();
    });
  };

  const draft = () =>
    startDraft(async () => {
      const r = await draftWorkflowAction(prompt.trim());
      if (!r.ok || !r.data) { setNotice({ tone: 'danger', text: r.ok ? 'No draft came back.' : r.message }); return; }
      const d = r.data;
      if (!d.definition) { setNotice({ tone: 'warning', text: d.issues[0]?.message ?? 'The AI did not return a workflow.' }); return; }
      setTrigger(d.definition.trigger.event);
      setSteps(fromDefinition(d.definition));
      setAiInteractionId(d.interactionId);
      if (!name.trim()) setName(prompt.trim().slice(0, 80));
      setTouched(true);
      setNotice({
        tone: 'warning',
        text: d.issues.length
          ? `AI draft loaded with ${d.issues.length} problem${d.issues.length === 1 ? '' : 's'} to fix, marked below. Check every step, save, then test it.`
          : 'AI draft loaded. Check every step, then save and test it. Nothing runs until you activate a tested version.',
      });
    });

  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {aiDraft && (
        <Card>
          <CardHeader title={<span className="inline-flex items-center gap-2"><Sparkles className="size-4 text-ember" />Draft with AI</span>} description="Describe what should happen in plain English. The AI suggests steps; you check them, save and test before anything runs." />
          <CardBody>
            {aiDraft.available ? (
              <div className="grid gap-3">
                <Textarea rows={3} maxLength={1500} placeholder="When someone in Assembly Line asks for more than 3 days of sick leave, ask their manager to approve and then notify the HR admin role." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                <div><Button variant="secondary" loading={drafting} disabled={prompt.trim().length < 10} onClick={draft}>Draft steps</Button></div>
              </div>
            ) : <p className="text-[0.8125rem] text-fg-muted">{aiDraft.reason}</p>}
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader title="Basics" />
        <CardBody className="grid gap-4">
          <Field label="Name" required error={touched ? nameError : undefined}>{(p) => <Input {...p} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Description" hint="Optional. What this workflow is for.">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
          <Field label="Starts when" hint={workflow?.status === 'active' ? 'Pause the workflow to change what starts it.' : undefined}>
            {(p) => (
              <Select {...p} value={trigger} disabled={workflow?.status === 'active'} onChange={(e) => setTrigger(e.target.value as TriggerEvent)}>
                {catalogue.triggers.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </Select>
            )}
          </Field>
          <p className="text-xs text-fg-muted">Values you can use in conditions and in messages as {'{{field}}'}: {fields.map((f) => f.key).join(', ')}.</p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Steps" description="Run from top to bottom. A condition that is not met, or a rejected approval, stops the run." />
        <CardBody className="grid gap-4">
          {steps.length === 0 && <p className="text-[0.8125rem] text-fg-muted">Add the first step below.</p>}
          {touched && issues.steps && <Alert tone="danger">{issues.steps}</Alert>}
          {steps.map((s, i) => (
            <div key={i} className="rounded-lg border border-border p-4">
              <div className="mb-3 flex items-center gap-2">
                <Badge tone="info">{i + 1}</Badge>
                <span className="font-medium">{automation.STEP_LABEL[s.type]}</span>
                <span className="text-xs text-fg-subtle">{s.id}</span>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Move down" disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Remove step" onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
                </div>
              </div>
              <StepFields step={s} index={i} catalogue={catalogue} fields={fields} update={(p) => update(i, p)} err={(k) => err(i, k)} />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {catalogue.steps.map((t) => (
              <Button key={t.key} size="sm" variant="secondary" disabled={steps.length >= 20 || (t.key === 'assign_course' && !catalogue.courses.length) || (t.key === 'slack' && !catalogue.slackConnections.length) || (t.key === 'webhook' && !catalogue.webhookEndpoints.length)} onClick={() => setSteps([...steps, blank(t.key, catalogue, trigger, nextId(t.key, steps))])}>+ {t.label}</Button>
            ))}
          </div>
        </CardBody>
      </Card>
      <div className="flex items-center gap-3">
        <Button loading={pending} onClick={save}>{workflow ? 'Save as new version' : 'Save workflow'}</Button>
        {aiInteractionId && <Badge tone="ember">Started from an AI draft</Badge>}
        <span className="text-xs text-fg-muted">Saving never changes what is live. Test the saved version, then activate it.</span>
      </div>
    </div>
  );
}

function StepFields({ step: s, catalogue, fields, update, err }: {
  step: Draft; index: number; catalogue: Catalogue; fields: ReturnType<typeof automation.fieldsFor>;
  update: (p: Record<string, unknown>) => void; err: (key: string) => string | undefined;
}) {
  const str = (k: string) => String(s[k] ?? '');
  switch (s.type) {
    case 'condition':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Field" error={err('field')}>{(p) => <Select {...p} value={str('field')} onChange={(e) => update({ field: e.target.value })}>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>}</Field>
          <Field label="Test" error={err('op')}>{(p) => <Select {...p} value={str('op')} onChange={(e) => update({ op: e.target.value })}>{catalogue.ops.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select>}</Field>
          <Field label="Value" hint={s.op === 'in' ? 'Separate values with commas' : undefined} error={err('value')}>{(p) => <Input {...p} value={str('value')} onChange={(e) => update({ value: e.target.value })} />}</Field>
        </div>
      );
    case 'notify':
      return (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Who" error={err('to')}>
              {(p) => (
                <Select {...p} value={str('to')} onChange={(e) => update({ to: e.target.value })}>
                  <option value="employee">The employee</option>
                  <option value="manager">Their manager</option>
                  <option value="role">Everyone with a role</option>
                  {s.to === 'member' && <option value="member">A chosen person</option>}
                </Select>
              )}
            </Field>
            {s.to === 'role' && <RoleField value={str('role')} catalogue={catalogue} error={err('role')} onChange={(role) => update({ role })} />}
          </div>
          <Field label="Title" hint="You can use {{employee.name}} and the other values listed above." error={err('title')}>{(p) => <Input {...p} maxLength={200} value={str('title')} onChange={(e) => update({ title: e.target.value })} />}</Field>
          <Field label="Message" error={err('body')}>{(p) => <Textarea {...p} rows={2} maxLength={2000} value={str('body')} onChange={(e) => update({ body: e.target.value })} />}</Field>
          <Checkbox label="Email it too" checked={Boolean(s.email)} onChange={(e) => update({ email: e.target.checked })} />
        </div>
      );
    case 'delay':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Wait for" error={err('amount')}>{(p) => <Input {...p} type="number" min={1} max={365} value={str('amount')} onChange={(e) => update({ amount: e.target.value })} />}</Field>
          <Field label="Unit" error={err('unit')}>{(p) => <Select {...p} value={str('unit')} onChange={(e) => update({ unit: e.target.value })}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></Select>}</Field>
        </div>
      );
    case 'approval':
      return (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Approver" error={err('approver')}>{(p) => <Select {...p} value={str('approver')} onChange={(e) => update({ approver: e.target.value })}><option value="manager">The employee&apos;s manager</option><option value="role">Someone with a role</option></Select>}</Field>
            {s.approver === 'role' && <RoleField value={str('role')} catalogue={catalogue} error={err('role')} onChange={(role) => update({ role })} />}
          </div>
          <Field label="What they approve" hint="Shown in their Approvals inbox. You can use {{values}}." error={err('summary')}>{(p) => <Input {...p} maxLength={300} value={str('summary')} onChange={(e) => update({ summary: e.target.value })} />}</Field>
        </div>
      );
    case 'assign_course':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Course" error={err('courseId')}>{(p) => <Select {...p} value={str('courseId')} onChange={(e) => update({ courseId: e.target.value })}>{catalogue.courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</Select>}</Field>
          <Field label="Due in (days)" hint="Leave empty for no due date" error={err('dueInDays')}>{(p) => <Input {...p} type="number" min={1} max={365} value={s.dueInDays === null ? '' : str('dueInDays')} onChange={(e) => update({ dueInDays: e.target.value })} />}</Field>
        </div>
      );
    case 'slack':
      return (
        <div className="grid gap-3">
          <Field label="Slack channel" hint={catalogue.slackConnections.length ? undefined : 'Connect a channel under Settings, Integrations, Slack first (Business plan and above).'} error={err('connectionId')}>
            {(p) => (
              <Select {...p} value={str('connectionId')} onChange={(e) => update({ connectionId: e.target.value })}>
                <option value="">Choose a channel</option>
                {catalogue.slackConnections.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status !== 'active' ? ' (not working)' : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Message" hint="Posted as plain text. You can use {{employee.name}} and the other values listed above. Avoid pay and personal details: everyone in the channel sees it." error={err('text')}>
            {(p) => <Textarea {...p} rows={2} maxLength={2000} value={str('text')} onChange={(e) => update({ text: e.target.value })} />}
          </Field>
        </div>
      );
    case 'webhook':
      return (
        <div className="grid gap-3">
          <Field label="Webhook endpoint" hint={catalogue.webhookEndpoints.length ? 'Sent as a workflow.webhook event with the run\'s values, signed like every webhook.' : 'Add an endpoint under Settings, Integrations, Webhooks first (Business plan and above).'} error={err('endpointId')}>
            {(p) => (
              <Select {...p} value={str('endpointId')} onChange={(e) => update({ endpointId: e.target.value })}>
                <option value="">Choose an endpoint</option>
                {catalogue.webhookEndpoints.map((w) => <option key={w.id} value={w.id}>{w.name}{w.status !== 'active' ? ` (${w.status})` : ''}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Message" hint="A short note included with the values. You can use placeholders." error={err('message')}>
            {(p) => <Input {...p} maxLength={500} value={str('message')} onChange={(e) => update({ message: e.target.value })} />}
          </Field>
        </div>
      );
  }
}

function RoleField({ value, catalogue, error, onChange }: { value: string; catalogue: Catalogue; error?: string; onChange: (v: string) => void }) {
  return (
    <Field label="Role" error={error}>
      {(p) => (
        <Select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a role</option>
          {catalogue.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
        </Select>
      )}
    </Field>
  );
}

'use client';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, Field, Input, Select } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { OnboardingTemplate } from '@/lib/types';
import { archiveTemplateAction, saveTemplateAction } from './actions';

type Task = OnboardingTemplate['tasks'][number];
const OWNERS = [['hr', 'HR'], ['manager', 'Manager'], ['employee', 'New joiner'], ['it', 'IT']] as const;

export function TemplatesView({ templates }: { templates: OnboardingTemplate[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<OnboardingTemplate | 'new' | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div><Button onClick={() => setEditing('new')}><Plus className="size-4" /> New checklist</Button></div>
      {templates.map((t) => (
        <Card key={t.id}>
          <CardHeader
            title={<span className="flex items-center gap-2">{t.name}{t.isDefault && <Badge tone="accent">Default</Badge>}</span>}
            description={t.description ?? `${t.tasks.length} tasks`}
            action={<span className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => setEditing(t)}>Edit</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm(`Archive ${t.name}?`) && start(async () => { const r = await archiveTemplateAction(t.id); if (r.ok) router.refresh(); else setError(r.message); })}>Archive</Button>
            </span>}
          />
          <ol className="divide-y divide-border">
            {t.tasks.map((task, i) => (
              <li key={i} className="flex gap-3 px-5 py-2 text-sm">
                <span className="w-24 shrink-0 text-xs text-fg-subtle">{task.dueOffsetDays === 0 ? 'Joining day' : task.dueOffsetDays < 0 ? `${-task.dueOffsetDays}d before` : `${task.dueOffsetDays}d after`}</span>
                <span className="flex-1">{task.title}</span>
                <Badge>{OWNERS.find(([k]) => k === task.owner)?.[1]}</Badge>
              </li>
            ))}
          </ol>
        </Card>
      ))}
      {editing && <Editor template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Editor({ template, onClose }: { template: OnboardingTemplate | null; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [isDefault, setIsDefault] = useState(template?.isDefault ?? false);
  const [tasks, setTasks] = useState<Task[]>(template?.tasks ?? [{ title: '', owner: 'hr', dueOffsetDays: 0 }]);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<Task>) => setTasks(tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={template ? `Edit ${template.name}` : 'New checklist'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={() => start(async () => {
        const r = await saveTemplateAction(template?.id ?? null, { name, description: description || undefined, isDefault, tasks: tasks.filter((t) => t.title.trim()) });
        if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
      })}>Save</Button></>}
    >
      <div className="grid gap-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Description">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Checkbox label="Use for new joiners by default" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <div className="grid gap-2">
          <div className="text-[13px] font-medium">Tasks</div>
          {tasks.map((t, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
              <Input aria-label={`Task ${i + 1}`} placeholder="Task" value={t.title} onChange={(e) => set(i, { title: e.target.value })} maxLength={200} />
              <Select aria-label="Owner" value={t.owner} onChange={(e) => set(i, { owner: e.target.value })} className="w-32">{OWNERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
              <Input aria-label="Due, days from joining" type="number" min={-60} max={180} value={t.dueOffsetDays} onChange={(e) => set(i, { dueOffsetDays: Number(e.target.value) })} className="w-20" title="Days from joining (negative = before)" />
              <button className="text-fg-subtle hover:text-danger" aria-label={`Remove task ${i + 1}`} onClick={() => setTasks(tasks.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
            </div>
          ))}
          <p className="text-xs text-fg-subtle">The number is days from the joining date; negative means before it.</p>
          <div><Button size="sm" variant="secondary" onClick={() => setTasks([...tasks, { title: '', owner: 'hr', dueOffsetDays: 0 }])}><Plus className="size-3.5" /> Add task</Button></div>
        </div>
      </div>
    </Dialog>
  );
}

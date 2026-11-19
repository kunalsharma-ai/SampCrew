'use client';
import type { AppraisalDefinition, AppraisalSection } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Field, Input, Select, Textarea } from '@crew/ui';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { AppraisalForm } from '@/lib/types';
import { saveFormAction } from '../../../../appraisal/actions';

type Option = { id: string; name: string };
const SECTION_KIND: Record<AppraisalSection['kind'], string> = { rated: 'Scored (employee + manager)', self: 'Employee writes', manager: 'Manager writes', hr: 'HR writes' };
const slug = (s: string, taken: Set<string>) => {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'item';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
};
const move = <T,>(list: T[], i: number, d: -1 | 1) => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

export function FormBuilder({ form, departments, designations }: { form: AppraisalForm; departments: Option[]; designations: Option[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [meta, setMeta] = useState({ name: form.name, description: form.description ?? '', active: form.active, isDefault: form.isDefault, audience: form.audience, departmentIds: form.departmentIds, designationIds: form.designationIds });
  const [def, setDef] = useState<AppraisalDefinition>(form.definition);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string; fields?: Record<string, string> } | null>(null);
  const [dirty, setDirty] = useState(false);

  const edit = (fn: (d: AppraisalDefinition) => AppraisalDefinition) => { setDirty(true); setDef(fn); };
  const editSection = (i: number, patch: Partial<AppraisalSection>) => edit((d) => ({ ...d, sections: d.sections.map((s, k) => (k === i ? { ...s, ...patch } : s)) }));
  const allIds = () => new Set(def.sections.flatMap((s) => [s.id, ...s.questions.map((q) => q.id)]));

  const save = () => start(async () => {
    const r = await saveFormAction(form.id, { ...meta, description: meta.description || null, definition: def });
    setNotice(r.ok ? { tone: 'success', text: 'Form saved. New appraisals use this version; ones already started keep theirs.' } : { tone: 'danger', text: r.message, fields: r.fieldErrors });
    if (r.ok) { setDirty(false); router.refresh(); }
  });

  const totalWeight = def.sections.filter((s) => s.active && s.kind === 'rated').flatMap((s) => s.questions.filter((q) => q.active)).reduce((n, q) => n + q.weight, 0);

  return (
    <div className="grid gap-6">
      {notice && (
        <Alert tone={notice.tone}>
          {notice.text}
          {notice.fields && <ul className="mt-1 list-disc pl-5 text-xs">{Object.entries(notice.fields).slice(0, 8).map(([k, v]) => <li key={k}>{k.replace(/^definition\./, '')}: {v}</li>)}</ul>}
        </Alert>
      )}
      <Card>
        <CardHeader title="Form settings" description="The form's name and who it is for when a cycle picks forms by rule." />
        <div className="grid gap-4 px-5 pb-5 md:grid-cols-2">
          <Field label="Form name" required>{(p) => <Input {...p} value={meta.name} maxLength={160} onChange={(e) => { setDirty(true); setMeta({ ...meta, name: e.target.value }); }} />}</Field>
          <Field label="Title shown on the form" required>{(p) => <Input {...p} value={def.title} maxLength={200} onChange={(e) => edit((d) => ({ ...d, title: e.target.value }))} />}</Field>
          <Field label="Who it is for">
            {(p) => (
              <Select {...p} value={meta.audience} onChange={(e) => { setDirty(true); setMeta({ ...meta, audience: e.target.value }); }}>
                <option value="all">Everyone</option><option value="managers">People managers only</option><option value="non_managers">Individual contributors only</option>
              </Select>
            )}
          </Field>
          <div className="grid content-end gap-2">
            <Checkbox label="Active" description="Inactive forms cannot be used in new cycles." checked={meta.active} onChange={(e) => { setDirty(true); setMeta({ ...meta, active: e.target.checked }); }} />
            <Checkbox label="Default form" description="Used when no other form's rules fit a person." checked={meta.isDefault} onChange={(e) => { setDirty(true); setMeta({ ...meta, isDefault: e.target.checked }); }} />
          </div>
          <Field className="md:col-span-2" label="Introduction">{(p) => <Textarea {...p} rows={2} maxLength={4000} value={def.intro} onChange={(e) => edit((d) => ({ ...d, intro: e.target.value }))} />}</Field>
          {departments.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Departments <span className="font-normal text-fg-subtle">(none means any)</span></legend>
              <div className="grid max-h-40 gap-2 overflow-auto">{departments.map((d) => <Checkbox key={d.id} label={d.name} checked={meta.departmentIds.includes(d.id)} onChange={(e) => { setDirty(true); setMeta({ ...meta, departmentIds: e.target.checked ? [...meta.departmentIds, d.id] : meta.departmentIds.filter((x) => x !== d.id) }); }} />)}</div>
            </fieldset>
          )}
          {designations.length > 0 && (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Designations <span className="font-normal text-fg-subtle">(none means any)</span></legend>
              <div className="grid max-h-40 gap-2 overflow-auto">{designations.map((d) => <Checkbox key={d.id} label={d.name} checked={meta.designationIds.includes(d.id)} onChange={(e) => { setDirty(true); setMeta({ ...meta, designationIds: e.target.checked ? [...meta.designationIds, d.id] : meta.designationIds.filter((x) => x !== d.id) }); }} />)}</div>
            </fieldset>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title="Sections and questions" description={`Rated questions add up to a weight of ${totalWeight}. Each score counts as (score ÷ ${def.scale.max}) × weight, so the result is a percentage.`} />
        <div className="grid gap-4 px-5 pb-5">
          {def.sections.map((s, i) => (
            <fieldset key={i} className="grid gap-3 rounded-xl border border-border p-4" aria-label={`Section ${s.title}`}>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_14rem_12rem_auto]">
                <Field label="Section title" required>{(p) => <Input {...p} value={s.title} maxLength={160} onChange={(e) => editSection(i, { title: e.target.value })} />}</Field>
                <Field label="Answered by">
                  {(p) => (
                    <Select {...p} value={s.kind} onChange={(e) => { const kind = e.target.value as AppraisalSection['kind']; editSection(i, { kind, questions: s.questions.map((q) => ({ ...q, kind: kind === 'rated' ? 'score' : q.kind === 'score' ? 'long_text' : q.kind })) }); }}>
                      {Object.entries(SECTION_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Shown to">
                  {(p) => (
                    <Select {...p} value={s.audience} onChange={(e) => editSection(i, { audience: e.target.value as AppraisalSection['audience'] })}>
                      <option value="all">Everyone</option><option value="managers">People managers</option><option value="non_managers">Individual contributors</option>
                    </Select>
                  )}
                </Field>
                <div className="flex items-end gap-1">
                  <Button size="sm" variant="ghost" aria-label={`Move ${s.title} up`} disabled={i === 0} onClick={() => edit((d) => ({ ...d, sections: move(d.sections, i, -1) }))}><ArrowUp className="size-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Move ${s.title} down`} disabled={i === def.sections.length - 1} onClick={() => edit((d) => ({ ...d, sections: move(d.sections, i, 1) }))}><ArrowDown className="size-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${s.title}`} disabled={def.sections.length < 2} onClick={() => edit((d) => ({ ...d, sections: d.sections.filter((_, k) => k !== i) }))}><Trash2 className="size-4" /></Button>
                </div>
              </div>
              <Checkbox label="Section is in use" checked={s.active} onChange={(e) => editSection(i, { active: e.target.checked })} />
              <ol className="grid gap-2">
                {s.questions.map((q, j) => {
                  const setQ = (patch: Partial<typeof q>) => editSection(i, { questions: s.questions.map((x, k) => (k === j ? { ...x, ...patch } : x)) });
                  return (
                    <li key={j} className="grid gap-2 rounded-lg bg-bg-subtle p-3 md:grid-cols-[minmax(0,1fr)_7rem_9rem_auto] md:items-end">
                      <Field label={`Question ${j + 1}`}>{(p) => <Input {...p} value={q.text} maxLength={500} onChange={(e) => setQ({ text: e.target.value })} />}</Field>
                      {s.kind === 'rated'
                        ? <Field label="Weight">{(p) => <Input {...p} type="number" min={0} max={100} step={0.5} value={q.weight} onChange={(e) => setQ({ weight: Number(e.target.value) })} />}</Field>
                        : <Field label="Answer">{(p) => <Select {...p} value={q.kind} onChange={(e) => setQ({ kind: e.target.value as typeof q.kind })}><option value="long_text">Paragraph</option><option value="short_text">One line</option></Select>}</Field>}
                      <div className="grid gap-1 pb-1">
                        <Checkbox label="Required" checked={q.required} onChange={(e) => setQ({ required: e.target.checked })} />
                        <Checkbox label="In use" checked={q.active} onChange={(e) => setQ({ active: e.target.checked })} />
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" aria-label={`Move question ${j + 1} up`} disabled={j === 0} onClick={() => editSection(i, { questions: move(s.questions, j, -1) })}><ArrowUp className="size-4" /></Button>
                        <Button size="sm" variant="ghost" aria-label={`Move question ${j + 1} down`} disabled={j === s.questions.length - 1} onClick={() => editSection(i, { questions: move(s.questions, j, 1) })}><ArrowDown className="size-4" /></Button>
                        <Button size="sm" variant="ghost" aria-label={`Remove question ${j + 1}`} disabled={s.questions.length < 2} onClick={() => editSection(i, { questions: s.questions.filter((_, k) => k !== j) })}><Trash2 className="size-4" /></Button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div><Button size="sm" variant="secondary" onClick={() => editSection(i, { questions: [...s.questions, { id: slug(`${s.id}_q${s.questions.length + 1}`, allIds()), text: 'New question', kind: s.kind === 'rated' ? 'score' : 'long_text', weight: 1, required: true, active: true }] })}><Plus className="size-4" />Add question</Button></div>
            </fieldset>
          ))}
          <div><Button variant="secondary" onClick={() => edit((d) => ({ ...d, sections: [...d.sections, { id: slug(`section_${d.sections.length + 1}`, allIds()), title: 'New section', description: '', kind: 'rated', audience: 'all', active: true, questions: [{ id: slug(`section_${d.sections.length + 1}_q1`, allIds()), text: 'New question', kind: 'score', weight: 1, required: true, active: true }] }] }))}><Plus className="size-4" />Add section</Button></div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Rating scale" description="The scores people pick from, and what each range means." />
          <div className="grid gap-3 px-5 pb-5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Lowest score">{(p) => <Select {...p} value={def.scale.min} onChange={(e) => edit((d) => ({ ...d, scale: { ...d.scale, min: Number(e.target.value) } }))}><option value={0}>0</option><option value={1}>1</option></Select>}</Field>
              <Field label="Highest score">{(p) => <Input {...p} type="number" min={2} max={10} value={def.scale.max} onChange={(e) => edit((d) => ({ ...d, scale: { ...d.scale, max: Number(e.target.value) } }))} />}</Field>
            </div>
            {def.scale.levels.map((l, i) => {
              const setL = (patch: Partial<typeof l>) => edit((d) => ({ ...d, scale: { ...d.scale, levels: d.scale.levels.map((x, k) => (k === i ? { ...x, ...patch } : x)) } }));
              return (
                <div key={i} className="grid grid-cols-[4rem_4rem_minmax(0,1fr)_auto] items-end gap-2">
                  <Field label="From">{(p) => <Input {...p} type="number" min={0} max={100} value={l.from} onChange={(e) => setL({ from: Number(e.target.value) })} />}</Field>
                  <Field label="To">{(p) => <Input {...p} type="number" min={0} max={100} value={l.to} onChange={(e) => setL({ to: Number(e.target.value) })} />}</Field>
                  <Field label="Meaning">{(p) => <Input {...p} value={l.label} maxLength={80} onChange={(e) => setL({ label: e.target.value })} />}</Field>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${l.label}`} onClick={() => edit((d) => ({ ...d, scale: { ...d.scale, levels: d.scale.levels.filter((_, k) => k !== i) } }))}><Trash2 className="size-4" /></Button>
                </div>
              );
            })}
            <div><Button size="sm" variant="secondary" onClick={() => edit((d) => ({ ...d, scale: { ...d.scale, levels: [...d.scale.levels, { from: d.scale.max, to: d.scale.max, label: 'New level', description: '' }] } }))}><Plus className="size-4" />Add level</Button></div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Performance categories" description="Each category starts at a final percentage. One must start at 0%." />
          <div className="grid gap-3 px-5 pb-5">
            {def.bands.map((b, i) => (
              <div key={i} className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-end gap-2">
                <Field label="From %">{(p) => <Input {...p} type="number" min={0} max={100} value={b.min} onChange={(e) => edit((d) => ({ ...d, bands: d.bands.map((x, k) => (k === i ? { ...x, min: Number(e.target.value) } : x)) }))} />}</Field>
                <Field label="Category">{(p) => <Input {...p} value={b.label} maxLength={80} onChange={(e) => edit((d) => ({ ...d, bands: d.bands.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) }))} />}</Field>
                <Button size="sm" variant="ghost" aria-label={`Remove ${b.label}`} disabled={def.bands.length < 2} onClick={() => edit((d) => ({ ...d, bands: d.bands.filter((_, k) => k !== i) }))}><Trash2 className="size-4" /></Button>
              </div>
            ))}
            <div><Button size="sm" variant="secondary" onClick={() => edit((d) => ({ ...d, bands: [...d.bands, { min: Math.min(100, Math.max(...d.bands.map((x) => x.min)) + 5), label: 'New category' }] }))}><Plus className="size-4" />Add category</Button></div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Final score" description="How each question's final score is decided. HR can still override a question or the final percentage, with a reason." />
        <div className="grid gap-4 px-5 pb-5 md:grid-cols-2">
          <Field label="Method">
            {(p) => (
              <Select {...p} value={def.scoring.method} onChange={(e) => edit((d) => ({ ...d, scoring: { ...d.scoring, method: e.target.value as typeof d.scoring.method } }))}>
                <option value="manager">The manager&apos;s score</option>
                <option value="hr">HR&apos;s score (the manager&apos;s where HR gives none)</option>
                <option value="combined">A weighted mix of the scores</option>
              </Select>
            )}
          </Field>
          <Checkbox className="self-end" label="HR also scores rated questions" checked={def.scoring.hrScores} onChange={(e) => edit((d) => ({ ...d, scoring: { ...d.scoring, hrScores: e.target.checked } }))} />
          {def.scoring.method === 'combined' && (
            <div className="grid grid-cols-3 gap-3 md:col-span-2">
              {(['employee', 'manager', 'hr'] as const).map((k) => (
                <Field key={k} label={`${k === 'hr' ? 'HR' : k[0]!.toUpperCase() + k.slice(1)} weight %`}>{(p) => <Input {...p} type="number" min={0} max={100} value={def.scoring.weights[k]} onChange={(e) => edit((d) => ({ ...d, scoring: { ...d.scoring, weights: { ...d.scoring.weights, [k]: Number(e.target.value) } } }))} />}</Field>
              ))}
            </div>
          )}
          <Field className="md:col-span-2" label="Declaration shown to the employee">{(p) => <Textarea {...p} rows={2} maxLength={2000} value={def.declaration} onChange={(e) => edit((d) => ({ ...d, declaration: e.target.value }))} />}</Field>
        </div>
      </Card>

      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-bg/95 p-3 backdrop-blur">
        <span className="mr-auto text-sm text-fg-muted">Version {form.version}{dirty ? <Badge tone="warning" className="ml-2">Unsaved changes</Badge> : null}</span>
        <Button loading={pending} onClick={save}>Save form</Button>
      </div>
    </div>
  );
}

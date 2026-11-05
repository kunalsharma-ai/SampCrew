'use client';
import { DEFAULT_RATING_SCALE } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { CalendarRange, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Department, LegalEntity } from '@/lib/types';
import { saveCycleAction } from '../../talent/actions';
import { CYCLE_STATUS, CYCLE_TONE } from '../../talent/labels';
import type { CycleDetail, CycleSummary, Level, Question } from '../../talent/types';

const DEFAULT_QUESTIONS: Question[] = [
  { id: 'achievements', text: 'What were the most important results this period?' },
  { id: 'strengths', text: 'Which strengths made the biggest difference?' },
  { id: 'growth', text: 'What should change or grow next period?' },
];

/** Create or edit a draft cycle. */
export function CycleDialog({ open, onClose, entities, departments, cycle }: { open: boolean; onClose: () => void; entities: LegalEntity[]; departments: Department[]; cycle?: CycleDetail }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<Question[]>(cycle?.questions ?? DEFAULT_QUESTIONS);
  const [scale, setScale] = useState<Level[]>(cycle?.ratingScale ?? DEFAULT_RATING_SCALE);
  const y = new Date().getFullYear();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={cycle ? 'Edit draft cycle' : 'New review cycle'}
      description="A draft changes nothing until you launch it. Launching creates a review for everyone it includes."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="cycle-form" loading={pending}>{cycle ? 'Save draft' : 'Create draft'}</Button>
        </>
      }
    >
      <form
        id="cycle-form"
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const body = {
            name: String(f.get('name') ?? ''),
            periodStart: String(f.get('periodStart') ?? ''),
            periodEnd: String(f.get('periodEnd') ?? ''),
            selfReview: f.get('selfReview') === 'on',
            peerFeedback: f.get('peerFeedback') === 'on',
            legalEntityId: String(f.get('legalEntityId') ?? '') || null,
            departmentId: String(f.get('departmentId') ?? '') || null,
            selfDue: String(f.get('selfDue') ?? '') || null,
            managerDue: String(f.get('managerDue') ?? '') || null,
            questions: questions.map((q, i) => ({ id: q.id || `q${i + 1}`, text: q.text })),
            ratingScale: scale,
          };
          setError(null);
          start(async () => {
            const r = await saveCycleAction(cycle?.id ?? null, body);
            if (r.ok) {
              onClose();
              if (!cycle && r.data) router.push(`/reviews/cycles/${(r.data as { id: string }).id}`);
              else router.refresh();
            } else setError(r.message);
          });
        }}
      >
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        <Field label="Name" required className="col-span-2">{(p) => <Input {...p} name="name" required defaultValue={cycle?.name ?? `H1 ${y} review`} />}</Field>
        <Field label="Period from" required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} type="date" name="periodStart" required defaultValue={cycle?.periodStart ?? `${y}-01-01`} />}</Field>
        <Field label="Period to" required className="col-span-2 sm:col-span-1">{(p) => <Input {...p} type="date" name="periodEnd" required defaultValue={cycle?.periodEnd ?? `${y}-06-30`} />}</Field>
        <Field label="Legal entity" hint="Leave empty for everyone" className="col-span-2 sm:col-span-1">
          {(p) => <Select {...p} name="legalEntityId" defaultValue={cycle?.legalEntityId ?? ''}><option value="">All legal entities</option>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        </Field>
        <Field label="Department" hint="Includes its sub-departments" className="col-span-2 sm:col-span-1">
          {(p) => <Select {...p} name="departmentId" defaultValue={cycle?.departmentId ?? ''}><option value="">All departments</option>{departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        </Field>
        <Field label="Self reviews due" className="col-span-2 sm:col-span-1">{(p) => <Input {...p} type="date" name="selfDue" defaultValue={cycle?.selfDue ?? ''} />}</Field>
        <Field label="Manager reviews due" className="col-span-2 sm:col-span-1">{(p) => <Input {...p} type="date" name="managerDue" defaultValue={cycle?.managerDue ?? ''} />}</Field>
        <div className="col-span-2 grid gap-2 sm:grid-cols-2">
          <Checkbox name="selfReview" defaultChecked={cycle?.selfReview ?? true} label="Self review" description="People reflect on their own period first." />
          <Checkbox name="peerFeedback" defaultChecked={cycle?.peerFeedback ?? true} label="360 peer feedback" description="Managers can ask colleagues for input." />
        </div>
        <div className="col-span-2 grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[0.8125rem] font-medium">Questions</span>
            <Button size="sm" variant="ghost" type="button" disabled={questions.length >= 15} onClick={() => setQuestions([...questions, { id: `q${Date.now() % 100000}`, text: '' }])}><Plus className="size-3.5" /> Add question</Button>
          </div>
          {questions.map((q, i) => (
            <div key={q.id} className="flex gap-2">
              <Input aria-label={`Question ${i + 1}`} value={q.text} required onChange={(e) => setQuestions(questions.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <Button size="sm" variant="ghost" type="button" aria-label="Remove question" disabled={questions.length <= 1} onClick={() => setQuestions(questions.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
        </div>
        <div className="col-span-2 grid gap-2">
          <span className="text-[0.8125rem] font-medium">Rating scale (lowest first)</span>
          {scale.map((l, i) => (
            <div key={l.value} className="flex items-center gap-2">
              <span className="w-6 text-right text-[0.8125rem] tabular-nums text-fg-muted">{l.value}</span>
              <Input aria-label={`Rating ${l.value}`} value={l.label} required onChange={(e) => setScale(scale.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </div>
          ))}
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" type="button" disabled={scale.length >= 10} onClick={() => setScale([...scale, { value: scale.length + 1, label: '' }])}>Add level</Button>
            <Button size="sm" variant="ghost" type="button" disabled={scale.length <= 2} onClick={() => setScale(scale.slice(0, -1))}>Remove top level</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

export function CyclesView({ cycles, entities, departments }: { cycles: CycleSummary[]; entities: LegalEntity[]; departments: Department[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card>
        <CardHeader title="Cycles" action={<Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> New review cycle</Button>} />
        {cycles.length ? (
          <Table>
            <THead><tr><TH>Cycle</TH><TH>Who</TH><TH>Stage</TH><TH className="text-right">People</TH><TH className="text-right">Self reviews</TH><TH className="text-right">Manager reviews</TH></tr></THead>
            <TBody>
              {cycles.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/reviews/cycles/${c.id}`}>{c.name}</Link>
                    <div className="text-xs text-fg-muted">{c.periodStart} to {c.periodEnd}</div>
                  </TD>
                  <TD className="text-fg-muted">{[c.legalEntityName, c.departmentName].filter(Boolean).join(' · ') || 'Everyone'}</TD>
                  <TD><Badge tone={CYCLE_TONE[c.status]} dot>{CYCLE_STATUS[c.status]}</Badge></TD>
                  <TD className="text-right tabular-nums">{c.status === 'draft' ? '–' : c.participants}</TD>
                  <TD className="text-right tabular-nums">{c.status === 'draft' || !c.selfReview ? '–' : `${c.selfDone} of ${c.participants}`}</TD>
                  <TD className="text-right tabular-nums">{c.status === 'draft' ? '–' : `${c.managerDone} of ${c.participants}`}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<CalendarRange className="size-5" />} title="No review cycles yet" description="Create a draft, check who it includes, then launch it." />
        )}
      </Card>
      <CycleDialog open={open} onClose={() => setOpen(false)} entities={entities} departments={departments} />
    </>
  );
}

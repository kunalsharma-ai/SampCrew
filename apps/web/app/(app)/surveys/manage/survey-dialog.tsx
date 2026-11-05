'use client';
import { Alert, Button, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Department, LegalEntity } from '@/lib/types';
import { saveSurveyAction } from '../../talent/actions';
import { QUESTION_KIND } from '../../talent/labels';
import type { SurveyDetail, SurveyKind, SurveyQuestionDef } from '../../talent/types';

const DEFAULT: SurveyQuestionDef[] = [
  { id: 'tools', kind: 'scale', text: 'I have the tools and information I need to do my job well' },
  { id: 'manager', kind: 'scale', text: 'My manager gives me useful feedback' },
  { id: 'enps', kind: 'enps', text: 'How likely are you to recommend working here to a friend?' },
  { id: 'comments', kind: 'text', text: 'What one thing would make work better?' },
];

export function SurveyDialog({ open, onClose, entities, departments, survey }: { open: boolean; onClose: () => void; entities: LegalEntity[]; departments: Department[]; survey?: SurveyDetail }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<SurveyQuestionDef[]>(survey?.questions ?? DEFAULT);
  const set = (i: number, patch: Partial<SurveyQuestionDef>) => setQuestions(questions.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={survey ? 'Edit draft survey' : 'New anonymous survey'}
      description="Questions are fixed once the survey opens, so every answer responds to the same questions."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="survey-form" loading={pending}>{survey ? 'Save draft' : 'Create draft'}</Button></>}
    >
      <form
        id="survey-form"
        className="grid grid-cols-2 gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const body = {
            title: String(f.get('title') ?? ''),
            description: String(f.get('description') ?? ''),
            minResponses: Number(f.get('minResponses') || 5),
            legalEntityId: String(f.get('legalEntityId') ?? '') || null,
            departmentId: String(f.get('departmentId') ?? '') || null,
            closesOn: String(f.get('closesOn') ?? '') || null,
            questions,
          };
          setError(null);
          start(async () => {
            const r = await saveSurveyAction(survey?.id ?? null, body);
            if (r.ok) {
              onClose();
              if (!survey && r.data) router.push(`/surveys/manage/${(r.data as { id: string }).id}`);
              else router.refresh();
            } else setError(r.message);
          });
        }}
      >
        {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
        <Field label="Title" required className="col-span-2">{(p) => <Input {...p} name="title" required defaultValue={survey?.title ?? 'Quarterly pulse'} />}</Field>
        <Field label="Introduction" className="col-span-2">{(p) => <Textarea {...p} name="description" rows={2} defaultValue={survey?.description ?? 'Five minutes, fully anonymous. We share the results and what we will change.'} />}</Field>
        <Field label="Legal entity" className="col-span-2 sm:col-span-1">
          {(p) => <Select {...p} name="legalEntityId" defaultValue={survey?.legalEntityId ?? ''}><option value="">Everyone</option>{entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        </Field>
        <Field label="Department" hint="Includes sub-departments" className="col-span-2 sm:col-span-1">
          {(p) => <Select {...p} name="departmentId" defaultValue={survey?.departmentId ?? ''}><option value="">All departments</option>{departments.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>}
        </Field>
        <Field label="Anonymity threshold" hint="Fewest answers before any result is shown (3 to 50)" className="col-span-2 sm:col-span-1">
          {(p) => <Input {...p} type="number" name="minResponses" min={3} max={50} defaultValue={survey?.minResponses ?? 5} />}
        </Field>
        <Field label="Closes on" className="col-span-2 sm:col-span-1">{(p) => <Input {...p} type="date" name="closesOn" defaultValue={survey?.closesOn ?? ''} />}</Field>
        <div className="col-span-2 grid gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[0.8125rem] font-medium">Questions</span>
            <Button size="sm" variant="ghost" type="button" disabled={questions.length >= 30} onClick={() => setQuestions([...questions, { id: `q${Date.now() % 100000}`, kind: 'scale', text: '' }])}><Plus className="size-3.5" /> Add question</Button>
          </div>
          {questions.map((q, i) => (
            <div key={q.id} className="grid grid-cols-12 gap-2">
              <Input className="col-span-12 sm:col-span-7" aria-label={`Question ${i + 1}`} value={q.text} required onChange={(e) => set(i, { text: e.target.value })} />
              <Select className="col-span-10 sm:col-span-4" aria-label={`Question ${i + 1} type`} value={q.kind} onChange={(e) => set(i, { kind: e.target.value as SurveyKind })}>
                {Object.entries(QUESTION_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
              <Button className="col-span-2 sm:col-span-1" size="sm" variant="ghost" type="button" aria-label="Remove question" disabled={questions.length <= 1} onClick={() => setQuestions(questions.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

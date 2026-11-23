'use client';
import {
  BLOCK_KINDS, BLOCK_LABEL, COMPLETION_RULE_LABEL, DIFFICULTY_LABEL, LEARNING_DIFFICULTIES, QUESTION_LABEL, QUESTION_TYPES, quizSettings,
  type AssignmentSettings, type BlockKind, type ContentBlock, type QuestionType, type QuizQuestion, type QuizSettings,
} from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, DatePicker, Field, Input, Select, Switch, Textarea, cn } from '@crew/ui';
import { ArrowDown, ArrowUp, Check, Copy, FileText, Image as ImageIcon, Link2, ListChecks, Mic, NotebookPen, Plus, Presentation, Trash2, Type, Video, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { RichTextEditor } from '@/components/rich-text';
import { saveModuleAction } from '../actions';
import type { LearningAccessView, LearningOptions, ModuleDetail } from '../types';
import { ACCEPT, UploadButton } from '../upload';

const newId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 9)}`;
const KIND_ICON: Record<BlockKind, typeof Video> = { text: Type, video: Video, audio: Mic, document: FileText, presentation: Presentation, external: Link2, image: ImageIcon, quiz: ListChecks, assignment: NotebookPen };

type Block = ContentBlock;

function blankBlock(kind: BlockKind): Block {
  const base = { id: newId('i'), title: '', description: '', required: true };
  switch (kind) {
    case 'text': return { ...base, kind, body: '', attachmentFileIds: [], completion: 'manual' };
    case 'video': case 'audio': return { ...base, kind, source: { type: 'url', url: '' }, durationMinutes: null, coverFileId: null, completion: 'full', minPercent: 90 };
    case 'document': return { ...base, kind, source: { type: 'url', url: '' }, coverFileId: null, completion: 'manual' };
    case 'presentation': return { ...base, kind, source: { type: 'url', url: '' }, completion: 'manual' };
    case 'image': return { ...base, kind, source: { type: 'url', url: '' }, caption: '', completion: 'open' };
    case 'external': return { ...base, kind, url: '', completion: 'open' };
    case 'quiz': return { ...base, kind, settings: quizSettings.parse({}), questions: [blankQuestion('single')] };
    case 'assignment': return { ...base, kind, settings: { instructions: '', startOn: null, dueOn: null, maxScore: 100, passScore: 50, submissionTypes: ['text'], referenceFileIds: [], gradingMethod: 'score' } };
  }
}

function blankQuestion(type: QuestionType): QuizQuestion {
  return {
    id: newId('q'), type, text: '', scenario: '', explanation: '', marks: 1, difficulty: 'medium', required: true, accepted: [], pairs: type === 'matching' ? [{ left: '', right: '' }, { left: '', right: '' }] : [],
    options: ['single', 'multiple', 'scenario'].includes(type) ? [{ id: 'a', text: '' }, { id: 'b', text: '' }] : [], correct: type === 'true_false' ? ['true'] : [],
  };
}

const move = <T,>(list: T[], i: number, by: number) => {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

function SourceEditor({ block, onChange, accept, label }: { block: Extract<Block, { source: unknown }>; onChange: (b: Block) => void; accept: string; label: string }) {
  const s = block.source;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`${label} source`}>
        {(['upload', 'url'] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={s.type === t} onClick={() => onChange({ ...block, source: t === 'url' ? { type: 'url', url: '' } : { type: 'upload', fileId: '' } } as Block)}
            className={cn('rounded-full border px-3 py-1 text-xs', s.type === t ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted')}>
            {t === 'upload' ? 'Upload a file' : 'Use a link'}
          </button>
        ))}
      </div>
      {s.type === 'url' ? (
        <Field label={`${label} link`} hint={block.kind === 'video' ? 'A YouTube or Vimeo link, or an https link to an MP4 or WebM file' : 'An https:// link'}>
          {(p) => <Input {...p} type="url" value={s.url} placeholder="https://" onChange={(e) => onChange({ ...block, source: { type: 'url', url: e.target.value } } as Block)} data-testid={`url-${block.id}`} />}
        </Field>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {s.fileId ? <Badge tone="success"><Check className="size-3" aria-hidden />File uploaded</Badge> : <span className="text-xs text-fg-muted">No file yet</span>}
          <UploadButton purpose="content" accept={accept} label={s.fileId ? 'Replace the file' : `Upload ${label.toLowerCase()}`} onUploaded={(f) => onChange({ ...block, source: { type: 'upload', fileId: f.id }, ...(block.title ? {} : { title: f.name.replace(/\.[a-z0-9]+$/i, '') }) } as Block)} testId={`upload-${block.id}`} />
          {s.fileId && <a href={`/learning-files/${s.fileId}`} target="_blank" rel="noreferrer" className="text-xs text-accent underline">Open</a>}
        </div>
      )}
    </div>
  );
}

function QuestionEditor({ q, n, onChange, onMove, onRemove }: { q: QuizQuestion; n: number; onChange: (q: QuizQuestion) => void; onMove: (by: number) => void; onRemove: () => void }) {
  const choice = q.type === 'single' || q.type === 'scenario' || q.type === 'multiple';
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-bg p-3" data-testid="question-editor">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">Question {n}</span>
        <Select aria-label="Question type" value={q.type} className="h-8 max-w-60 text-xs" onChange={(e) => onChange({ ...blankQuestion(e.target.value as QuestionType), id: q.id, text: q.text, marks: q.marks, explanation: q.explanation })}>
          {QUESTION_TYPES.map((t) => <option key={t} value={t}>{QUESTION_LABEL[t]}</option>)}
        </Select>
        <span className="ml-auto flex gap-1">
          <Button type="button" size="sm" variant="ghost" aria-label="Move question up" onClick={() => onMove(-1)}><ArrowUp className="size-4" /></Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Move question down" onClick={() => onMove(1)}><ArrowDown className="size-4" /></Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Remove question" onClick={onRemove}><Trash2 className="size-4" /></Button>
        </span>
      </div>
      {q.type === 'scenario' && <Field label="Scenario">{(p) => <Textarea {...p} rows={3} value={q.scenario} onChange={(e) => onChange({ ...q, scenario: e.target.value })} />}</Field>}
      <Field label="Question">{(p) => <Input {...p} value={q.text} onChange={(e) => onChange({ ...q, text: e.target.value })} data-testid="question-text" />}</Field>
      {choice && (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-xs font-medium">Answer options: tick the correct {q.type === 'multiple' ? 'ones' : 'one'}</legend>
          {q.options.map((o, i) => (
            <div key={o.id} className="flex items-center gap-2">
              <input type={q.type === 'multiple' ? 'checkbox' : 'radio'} name={`correct-${q.id}`} aria-label={`Option ${i + 1} is correct`} checked={q.correct.includes(o.id)}
                onChange={() => onChange({ ...q, correct: q.type === 'multiple' ? (q.correct.includes(o.id) ? q.correct.filter((c) => c !== o.id) : [...q.correct, o.id]) : [o.id] })} />
              <Input aria-label={`Option ${i + 1}`} value={o.text} className="h-8" onChange={(e) => onChange({ ...q, options: q.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })} />
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove option ${i + 1}`} disabled={q.options.length <= 2} onClick={() => onChange({ ...q, options: q.options.filter((x) => x.id !== o.id), correct: q.correct.filter((c) => c !== o.id) })}><X className="size-4" /></Button>
            </div>
          ))}
          {q.options.length < 12 && <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={() => onChange({ ...q, options: [...q.options, { id: newId('o'), text: '' }] })}><Plus className="size-4" aria-hidden />Add option</Button>}
        </fieldset>
      )}
      {q.type === 'true_false' && (
        <div className="flex gap-4 text-[0.8125rem]" role="radiogroup" aria-label="Correct answer">
          {['true', 'false'].map((v) => <label key={v} className="flex items-center gap-2"><input type="radio" name={`tf-${q.id}`} checked={q.correct[0] === v} onChange={() => onChange({ ...q, correct: [v] })} />{v === 'true' ? 'True' : 'False'} is correct</label>)}
        </div>
      )}
      {q.type === 'exact' && <Field label="Accepted answers" hint="Separate with commas. Matching ignores capitals and extra spaces.">{(p) => <Input {...p} value={q.accepted.join(', ')} onChange={(e) => onChange({ ...q, accepted: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />}</Field>}
      {(q.type === 'short' || q.type === 'long') && <p className="text-xs text-fg-muted">A reviewer marks this answer. The quiz result waits until it is marked.</p>}
      {q.type === 'matching' && (
        <fieldset className="grid gap-1.5">
          <legend className="mb-1 text-xs font-medium">Pairs: the learner matches each left item to its right item</legend>
          {q.pairs.map((pr, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <Input aria-label={`Left item ${i + 1}`} className="h-8" value={pr.left} onChange={(e) => onChange({ ...q, pairs: q.pairs.map((x, k) => (k === i ? { ...x, left: e.target.value } : x)) })} />
              <Input aria-label={`Right item ${i + 1}`} className="h-8" value={pr.right} onChange={(e) => onChange({ ...q, pairs: q.pairs.map((x, k) => (k === i ? { ...x, right: e.target.value } : x)) })} />
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove pair ${i + 1}`} disabled={q.pairs.length <= 2} onClick={() => onChange({ ...q, pairs: q.pairs.filter((_, k) => k !== i) })}><X className="size-4" /></Button>
            </div>
          ))}
          {q.pairs.length < 12 && <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={() => onChange({ ...q, pairs: [...q.pairs, { left: '', right: '' }] })}><Plus className="size-4" aria-hidden />Add pair</Button>}
        </fieldset>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_7rem_9rem]">
        <Field label="Explanation" hint="Shown after the quiz when correct answers are shown">{(p) => <Input {...p} value={q.explanation} onChange={(e) => onChange({ ...q, explanation: e.target.value })} />}</Field>
        <Field label="Marks">{(p) => <Input {...p} type="number" min={0.5} max={100} step={0.5} value={q.marks} onChange={(e) => onChange({ ...q, marks: Number(e.target.value) || 1 })} />}</Field>
        <Field label="Difficulty">{(p) => <Select {...p} value={q.difficulty} onChange={(e) => onChange({ ...q, difficulty: e.target.value as QuizQuestion['difficulty'] })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></Select>}</Field>
      </div>
      <Checkbox label="Required question" checked={q.required} onChange={(e) => onChange({ ...q, required: e.target.checked })} />
    </div>
  );
}

function QuizEditor({ block, onChange }: { block: Extract<Block, { kind: 'quiz' }>; onChange: (b: Block) => void }) {
  const s = block.settings;
  const set = (patch: Partial<QuizSettings>) => onChange({ ...block, settings: { ...s, ...patch } });
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Passing score (%)">{(p) => <Input {...p} type="number" min={0} max={100} value={s.passPercent} onChange={(e) => set({ passPercent: Number(e.target.value) })} />}</Field>
        <Field label="Attempts allowed" hint="0 means no limit">{(p) => <Input {...p} type="number" min={0} max={20} value={s.maxAttempts} onChange={(e) => set({ maxAttempts: Number(e.target.value) })} />}</Field>
        <Field label="Time limit (minutes)" hint="0 means no time limit">{(p) => <Input {...p} type="number" min={0} max={600} value={s.timeLimitMinutes} onChange={(e) => set({ timeLimitMinutes: Number(e.target.value) })} />}</Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Checkbox label="Shuffle the questions" checked={s.randomizeQuestions} onChange={(e) => set({ randomizeQuestions: e.target.checked })} />
        <Checkbox label="Shuffle the answer options" checked={s.randomizeOptions} onChange={(e) => set({ randomizeOptions: e.target.checked })} />
        <Checkbox label="Show the score after submitting" checked={s.showScore} onChange={(e) => set({ showScore: e.target.checked })} />
        <Checkbox label="Show correct answers after submitting" checked={s.showCorrectAnswers} onChange={(e) => set({ showCorrectAnswers: e.target.checked })} />
        <Checkbox label="Allow retakes" checked={s.allowRetake} onChange={(e) => set({ allowRetake: e.target.checked })} />
        <Checkbox label="Final assessment" description="Its score is the module's score" checked={s.finalAssessment} onChange={(e) => set({ finalAssessment: e.target.checked })} />
      </div>
      <div className="grid gap-3">
        {block.questions.map((q, i) => (
          <QuestionEditor key={q.id} q={q} n={i + 1}
            onChange={(next) => onChange({ ...block, questions: block.questions.map((x) => (x.id === q.id ? next : x)) })}
            onMove={(by) => onChange({ ...block, questions: move(block.questions, i, by) })}
            onRemove={() => onChange({ ...block, questions: block.questions.filter((x) => x.id !== q.id) })} />
        ))}
        <Button type="button" size="sm" variant="secondary" className="w-fit" onClick={() => onChange({ ...block, questions: [...block.questions, blankQuestion('single')] })} data-testid="add-question"><Plus className="size-4" aria-hidden />Add question</Button>
      </div>
    </div>
  );
}

function AssignmentEditor({ block, onChange }: { block: Extract<Block, { kind: 'assignment' }>; onChange: (b: Block) => void }) {
  const s = block.settings;
  const set = (patch: Partial<AssignmentSettings>) => onChange({ ...block, settings: { ...s, ...patch } });
  return (
    <div className="grid gap-3">
      <Field label="Instructions">{(p) => <Textarea {...p} rows={4} value={s.instructions} onChange={(e) => set({ instructions: e.target.value })} data-testid={`instructions-${block.id}`} />}</Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Opens on" hint="Optional">{(p) => <DatePicker id={p.id} value={s.startOn ?? ''} onChange={(v) => set({ startOn: v || null })} calendarLabel="Choose when it opens" />}</Field>
        <Field label="Due on" hint="Optional">{(p) => <DatePicker id={p.id} value={s.dueOn ?? ''} min={s.startOn ?? undefined} onChange={(v) => set({ dueOn: v || null })} calendarLabel="Choose the due date" />}</Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Grading">{(p) => <Select {...p} value={s.gradingMethod} onChange={(e) => set({ gradingMethod: e.target.value as AssignmentSettings['gradingMethod'] })}><option value="score">Score</option><option value="pass_fail">Pass or fail</option></Select>}</Field>
        {s.gradingMethod === 'score' && <Field label="Maximum score">{(p) => <Input {...p} type="number" min={1} max={1000} value={s.maxScore} onChange={(e) => set({ maxScore: Number(e.target.value) })} />}</Field>}
        {s.gradingMethod === 'score' && <Field label="Passing score">{(p) => <Input {...p} type="number" min={0} max={1000} value={s.passScore} onChange={(e) => set({ passScore: Number(e.target.value) })} />}</Field>}
      </div>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-1 text-xs font-medium">Learners can submit</legend>
        {(['text', 'file', 'link'] as const).map((t) => (
          <Checkbox key={t} label={{ text: 'A written response', file: 'Files', link: 'A link' }[t]} checked={s.submissionTypes.includes(t)}
            onChange={() => set({ submissionTypes: s.submissionTypes.includes(t) ? s.submissionTypes.filter((x) => x !== t) : [...s.submissionTypes, t] })} />
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">Reference material</span>
        {s.referenceFileIds.map((f, i) => <Badge key={f}>File {i + 1}<button type="button" aria-label={`Remove file ${i + 1}`} onClick={() => set({ referenceFileIds: s.referenceFileIds.filter((x) => x !== f) })}><X className="size-3" /></button></Badge>)}
        {s.referenceFileIds.length < 10 && <UploadButton purpose="content" accept={ACCEPT.any} label="Add a file" variant="ghost" onUploaded={(f) => set({ referenceFileIds: [...s.referenceFileIds, f.id] })} />}
      </div>
    </div>
  );
}

function CompletionSelect({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  if (block.kind === 'quiz' || block.kind === 'assignment') return null;
  const media = block.kind === 'video' || block.kind === 'audio';
  const rules = media ? (['full', 'percent', 'manual', 'open'] as const) : (['manual', 'open'] as const);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Counts as done when">
        {(p) => (
          <Select {...p} value={block.completion} onChange={(e) => onChange({ ...block, completion: e.target.value } as Block)} data-testid={`completion-${block.id}`}>
            {rules.map((r) => <option key={r} value={r}>{COMPLETION_RULE_LABEL[r]}</option>)}
          </Select>
        )}
      </Field>
      {media && block.completion === 'percent' && <Field label="Minimum to watch (%)">{(p) => <Input {...p} type="number" min={10} max={100} value={block.minPercent} onChange={(e) => onChange({ ...block, minPercent: Number(e.target.value) })} />}</Field>}
    </div>
  );
}

function BlockEditor({ block, n, total, onChange, onMove, onRemove, onCopy }: { block: Block; n: number; total: number; onChange: (b: Block) => void; onMove: (by: number) => void; onRemove: () => void; onCopy: () => void }) {
  const Icon = KIND_ICON[block.kind];
  return (
    <Card data-testid="block-editor" data-kind={block.kind}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="grid size-7 place-items-center rounded-md bg-accent/10 text-accent"><Icon className="size-4" aria-hidden /></span>
        <span className="text-sm font-semibold">{n}. {BLOCK_LABEL[block.kind]}</span>
        <span className="ml-auto flex items-center gap-1">
          <Button type="button" size="sm" variant="ghost" aria-label="Move up" disabled={n === 1} onClick={() => onMove(-1)}><ArrowUp className="size-4" /></Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Move down" disabled={n === total} onClick={() => onMove(1)}><ArrowDown className="size-4" /></Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Duplicate" onClick={onCopy}><Copy className="size-4" /></Button>
          <Button type="button" size="sm" variant="ghost" aria-label="Remove" onClick={onRemove}><Trash2 className="size-4" /></Button>
        </span>
      </div>
      <CardBody className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Title">{(p) => <Input {...p} value={block.title} onChange={(e) => onChange({ ...block, title: e.target.value })} data-testid={`title-${block.id}`} />}</Field>
          <label className="flex items-center gap-2 pb-2 text-[0.8125rem]"><Switch checked={block.required} onChange={(v) => onChange({ ...block, required: v })} label="Required to complete the module" />Required</label>
        </div>
        <Field label="Description" hint="Optional">{(p) => <Textarea {...p} rows={2} value={block.description} onChange={(e) => onChange({ ...block, description: e.target.value })} />}</Field>
        {block.kind === 'text' && (
          <>
            <RichTextEditor label="Content" value={block.body} onChange={(body) => onChange({ ...block, body })} placeholder="Write the lesson" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">Attachments</span>
              {block.attachmentFileIds.map((f, i) => <Badge key={f}>File {i + 1}<button type="button" aria-label={`Remove attachment ${i + 1}`} onClick={() => onChange({ ...block, attachmentFileIds: block.attachmentFileIds.filter((x) => x !== f) })}><X className="size-3" /></button></Badge>)}
              {block.attachmentFileIds.length < 10 && <UploadButton purpose="content" accept={ACCEPT.any} label="Attach a file" variant="ghost" onUploaded={(f) => onChange({ ...block, attachmentFileIds: [...block.attachmentFileIds, f.id] })} />}
            </div>
          </>
        )}
        {(block.kind === 'video' || block.kind === 'audio') && (
          <>
            <SourceEditor block={block} onChange={onChange} accept={block.kind === 'video' ? ACCEPT.video : ACCEPT.audio} label={block.kind === 'video' ? 'Video' : 'Audio'} />
            <Field label="Length (minutes)" hint="Optional" className="max-max-w-48">{(p) => <Input {...p} type="number" min={1} max={1000} value={block.durationMinutes ?? ''} onChange={(e) => onChange({ ...block, durationMinutes: e.target.value ? Number(e.target.value) : null })} />}</Field>
          </>
        )}
        {block.kind === 'document' && <SourceEditor block={block} onChange={onChange} accept={ACCEPT.document} label="Document" />}
        {block.kind === 'presentation' && <SourceEditor block={block} onChange={onChange} accept={ACCEPT.presentation} label="Presentation" />}
        {block.kind === 'image' && (
          <>
            <SourceEditor block={block} onChange={onChange} accept={ACCEPT.image} label="Image" />
            <Field label="Caption" hint="Optional">{(p) => <Input {...p} value={block.caption} onChange={(e) => onChange({ ...block, caption: e.target.value })} />}</Field>
          </>
        )}
        {block.kind === 'external' && <Field label="Link" hint="An https:// link. It opens in a new tab.">{(p) => <Input {...p} type="url" value={block.url} placeholder="https://" onChange={(e) => onChange({ ...block, url: e.target.value })} />}</Field>}
        {block.kind === 'quiz' && <QuizEditor block={block} onChange={onChange} />}
        {block.kind === 'assignment' && <AssignmentEditor block={block} onChange={onChange} />}
        <CompletionSelect block={block} onChange={onChange} />
      </CardBody>
    </Card>
  );
}

function TagInput({ label, value, onChange, suggestions, hint, testId }: { label: string; value: string[]; onChange: (v: string[]) => void; suggestions?: string[]; hint?: string; testId?: string }) {
  const [draft, setDraft] = useState('');
  const add = (v: string) => {
    const t = v.trim();
    if (t && !value.some((x) => x.toLowerCase() === t.toLowerCase()) && value.length < 20) onChange([...value, t]);
    setDraft('');
  };
  const listId = `${testId ?? label}-list`;
  return (
    <Field label={label} hint={hint}>
      {(p) => (
        <div className="grid gap-1.5">
          <div className="flex flex-wrap gap-1.5">{value.map((v) => <Badge key={v}>{v}<button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}><X className="size-3" /></button></Badge>)}</div>
          <Input {...p} list={suggestions ? listId : undefined} value={draft} data-testid={testId} placeholder="Type and press Enter"
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft); } }} onBlur={() => draft && add(draft)} />
          {suggestions && <datalist id={listId}>{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>}
        </div>
      )}
    </Field>
  );
}

const STEPS = ['Details', 'Content', 'Settings'] as const;

export function ModuleEditor({ options, access, initial }: { options: LearningOptions; access: LearningAccessView; initial: ModuleDetail | null }) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string; issues?: string[] } | null>(null);
  const [m, setM] = useState({
    title: initial?.title ?? '', shortDescription: initial?.shortDescription ?? '', description: initial?.description ?? '', category: initial?.category ?? '',
    topic: initial?.topic ?? '', skills: initial?.skills ?? [], difficulty: initial?.difficulty ?? 'beginner', customDifficulty: initial?.customDifficulty ?? '',
    durationMinutes: initial?.durationMinutes ?? null as number | null, creatorName: initial?.creatorName ?? '', creatorDesignation: initial?.creatorDesignation ?? '',
    coverFileId: initial?.coverFileId ?? null as string | null, tags: initial?.tags ?? [], language: initial?.language ?? 'English', selfEnrol: initial?.selfEnrol ?? false,
    certificate: initial?.certificate ?? true, defaultDueDays: initial?.defaultDueDays ?? null as number | null, hrWorkspaceId: initial?.hrWorkspaceId ?? null as string | null,
  });
  const [blocks, setBlocks] = useState<Block[]>(initial?.blocks ?? []);
  const set = (patch: Partial<typeof m>) => setM({ ...m, ...patch });
  const categories = [...new Set([...options.categories, ...options.customCategories.map((c) => c.name), ...(m.category ? [m.category] : [])])].sort((a, b) => a.localeCompare(b));
  const createScopes = access.scopes.filter((s) => s.caps.includes('create'));
  const scope = access.level === 'super' ? null : access.scopes.find((s) => s.key === (initial?.hrWorkspaceId ?? m.hrWorkspaceId ?? 'central')) ?? createScopes[0];
  const can = (cap: 'quiz' | 'assignment') => access.level === 'super' || Boolean(scope?.caps.includes(cap));

  const save = () => start(async () => {
    setNotice(null);
    const r = await saveModuleAction(initial?.id ?? null, { ...m, blocks });
    if (!r.ok) {
      setNotice({ tone: 'danger', text: r.message, issues: r.fieldErrors ? Object.entries(r.fieldErrors).map(([path, msg]) => {
        const [, i, ...rest] = path.split('.');
        return path.startsWith('blocks.') && i !== undefined ? `Item ${Number(i) + 1}${blocks[Number(i)]?.title ? ` (${blocks[Number(i)]!.title})` : ''}: ${msg}${rest.length ? '' : ''}` : msg;
      }) : undefined });
      return;
    }
    if (!initial) router.push(`/learning/manage/modules/${(r.data as { id: string }).id}`);
    else { setNotice({ tone: 'success', text: r.message ?? 'Saved.' }); router.refresh(); }
  });

  return (
    <div className="grid gap-4" data-testid="module-editor">
      <ol className="flex flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button type="button" onClick={() => setStep(i)} aria-current={step === i ? 'step' : undefined} data-testid={`wizard-${s.toLowerCase()}`}
              className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.8125rem]', step === i ? 'border-accent bg-accent text-accent-fg' : 'border-border text-fg-muted hover:text-fg')}>
              <span className="grid size-5 place-items-center rounded-full bg-bg-subtle text-[0.6875rem] font-semibold text-fg">{i + 1}</span>{s}{s === 'Content' && blocks.length ? ` (${blocks.length})` : ''}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <Card>
          <CardHeader title="Module details" description="What learners see in their list and the library." />
          <CardBody className="grid gap-4">
            <Field label="Title" required>{(p) => <Input {...p} value={m.title} onChange={(e) => set({ title: e.target.value })} data-testid="module-title" maxLength={160} />}</Field>
            <Field label="Short description" hint="One or two lines for the module card">{(p) => <Input {...p} value={m.shortDescription} onChange={(e) => set({ shortDescription: e.target.value })} maxLength={300} />}</Field>
            <Field label="Full description">{(p) => <Textarea {...p} rows={4} value={m.description} onChange={(e) => set({ description: e.target.value })} maxLength={4000} />}</Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" required>{(p) => <Select {...p} value={m.category} onChange={(e) => set({ category: e.target.value })} data-testid="module-category"><option value="">Choose a category</option>{categories.map((c) => <option key={c}>{c}</option>)}</Select>}</Field>
              <Field label="Topic">{(p) => <Input {...p} value={m.topic} onChange={(e) => set({ topic: e.target.value })} maxLength={120} />}</Field>
            </div>
            <TagInput label="Skills" value={m.skills} onChange={(skills) => set({ skills })} suggestions={options.skills} hint="Pick from the list or type a new skill" testId="module-skills" />
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Difficulty">{(p) => <Select {...p} value={m.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>{LEARNING_DIFFICULTIES.map((d) => <option key={d} value={d}>{DIFFICULTY_LABEL[d]}</option>)}</Select>}</Field>
              {m.difficulty === 'custom' && <Field label="Custom level">{(p) => <Input {...p} value={m.customDifficulty} onChange={(e) => set({ customDifficulty: e.target.value })} maxLength={40} />}</Field>}
              <Field label="Estimated length (minutes)">{(p) => <Input {...p} type="number" min={1} max={10000} value={m.durationMinutes ?? ''} onChange={(e) => set({ durationMinutes: e.target.value ? Number(e.target.value) : null })} />}</Field>
              <Field label="Language">{(p) => <Select {...p} value={m.language} onChange={(e) => set({ language: e.target.value })}>{options.languages.map((l) => <option key={l}>{l}</option>)}</Select>}</Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Instructor or creator" required hint="Shown to learners with your workspace level">{(p) => <Input {...p} value={m.creatorName} onChange={(e) => set({ creatorName: e.target.value })} data-testid="module-creator" maxLength={120} />}</Field>
              <Field label="Creator designation">{(p) => <Input {...p} value={m.creatorDesignation} onChange={(e) => set({ creatorDesignation: e.target.value })} maxLength={120} placeholder="For example, Learning & Development Manager" />}</Field>
            </div>
            <TagInput label="Tags" value={m.tags} onChange={(tags) => set({ tags })} hint="Words people may search for" />
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[0.8125rem] font-medium">Cover image</span>
              {m.coverFileId ? <img src={`/learning-files/${m.coverFileId}`} alt="Cover" className="h-16 w-28 rounded-md object-cover" /> : <span className="text-xs text-fg-muted">None</span>}
              <UploadButton purpose="content" accept={ACCEPT.image} label={m.coverFileId ? 'Replace' : 'Upload a cover'} onUploaded={(f) => set({ coverFileId: f.id })} variant="ghost" />
              {m.coverFileId && <Button type="button" size="sm" variant="ghost" onClick={() => set({ coverFileId: null })}>Remove</Button>}
            </div>
            {access.level !== 'super' && !initial && createScopes.length > 1 && (
              <Field label="HR Workspace" hint="Which of your HR Workspaces owns this module">
                {(p) => <Select {...p} value={m.hrWorkspaceId ?? ''} onChange={(e) => set({ hrWorkspaceId: e.target.value || null })}>{createScopes.map((s) => <option key={s.key} value={s.key === 'central' ? '' : s.key}>{s.name}</option>)}</Select>}
              </Field>
            )}
          </CardBody>
        </Card>
      )}

      {step === 1 && (
        <div className="grid gap-3">
          {blocks.length === 0 && <Alert tone="info">Add the content in the order learners go through it: a video, a reading, a document, then a quiz, for example.</Alert>}
          {blocks.map((b, i) => (
            <BlockEditor key={b.id} block={b} n={i + 1} total={blocks.length}
              onChange={(next) => setBlocks(blocks.map((x) => (x.id === b.id ? next : x)))}
              onMove={(by) => setBlocks(move(blocks, i, by))}
              onRemove={() => setBlocks(blocks.filter((x) => x.id !== b.id))}
              onCopy={() => setBlocks([...blocks.slice(0, i + 1), { ...structuredClone(b), id: newId('i'), title: `${b.title} (copy)` }, ...blocks.slice(i + 1)])} />
          ))}
          <Card>
            <CardBody>
              <p className="mb-2 text-[0.8125rem] font-medium">Add content</p>
              <div className="flex flex-wrap gap-2">
                {BLOCK_KINDS.map((k) => {
                  const Icon = KIND_ICON[k];
                  const allowed = (k !== 'quiz' || can('quiz')) && (k !== 'assignment' || can('assignment'));
                  return (
                    <Button key={k} type="button" size="sm" variant="secondary" disabled={!allowed || blocks.length >= 60} title={allowed ? undefined : 'Your Super Workspace has not switched this on for your HR Workspace'}
                      onClick={() => setBlocks([...blocks, blankBlock(k)])} data-testid={`add-${k}`}>
                      <Icon className="size-4" aria-hidden />{BLOCK_LABEL[k]}
                    </Button>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {step === 2 && (
        <Card>
          <CardHeader title="Enrolment and certificate" description="How people get the module and what they receive when they finish." />
          <CardBody className="grid gap-4">
            <div className="flex items-start gap-3"><Switch checked={m.certificate} onChange={(v) => set({ certificate: v })} label="Issue a certificate" testId="module-certificate" /><span className="text-[0.8125rem]"><span className="font-medium">Issue a completion certificate</span><span className="block text-xs text-fg-muted">Learners get a certificate with a number when they complete the module.</span></span></div>
            <div className="flex items-start gap-3"><Switch checked={m.selfEnrol} onChange={(v) => set({ selfEnrol: v })} label="Open for anyone to enrol" /><span className="text-[0.8125rem]"><span className="font-medium">Open in the learning library</span><span className="block text-xs text-fg-muted">Any employee can enrol on their own once it is published.</span></span></div>
            <Field label="Due after (days)" hint="When an assignment gives no due date, it is due this many days after enrolling. Leave empty for no deadline." className="max-w-xs">
              {(p) => <Input {...p} type="number" min={1} max={365} value={m.defaultDueDays ?? ''} onChange={(e) => set({ defaultDueDays: e.target.value ? Number(e.target.value) : null })} />}
            </Field>
          </CardBody>
        </Card>
      )}

      {notice && (
        <Alert tone={notice.tone} title={notice.text}>
          {notice.issues && <ul className="list-disc pl-5">{notice.issues.map((x) => <li key={x}>{x}</li>)}</ul>}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {step > 0 && <Button type="button" variant="ghost" onClick={() => setStep(step - 1)}>Back</Button>}
        {step < STEPS.length - 1 && <Button type="button" variant="secondary" onClick={() => setStep(step + 1)} data-testid="wizard-next">Next: {STEPS[step + 1]}</Button>}
        <Button type="button" loading={pending} onClick={save} data-testid="save-module">{initial ? (initial.version > 0 ? 'Save changes' : 'Save draft') : 'Create draft'}</Button>
        {initial && initial.version > 0 && <span className="text-xs text-fg-muted">Learners keep the published version until you publish the changes.</span>}
      </div>
    </div>
  );
}

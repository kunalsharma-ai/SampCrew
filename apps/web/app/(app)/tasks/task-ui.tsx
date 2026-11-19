'use client';
import { Alert, Badge, Button, Checkbox, DatePicker, Dialog, EmptyState, Field, Input, Select, Textarea, type Tone } from '@crew/ui';
import { CalendarClock, CheckCircle2, ClipboardCheck, FileUp, ListTodo, Search, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { AssignablePerson, WorkTask } from '@/lib/types';
import { assignTaskAction } from './actions';

export const STATUS_LABEL: Record<WorkTask['displayStatus'], string> = {
  new: 'New', not_started: 'Not started', in_progress: 'In progress', pending_review: 'Pending review', completed: 'Completed', reopened: 'Reopened', cancelled: 'Cancelled', overdue: 'Overdue',
};
const STATUS_TONE: Record<WorkTask['displayStatus'], Tone> = {
  new: 'info', not_started: 'neutral', in_progress: 'accent', pending_review: 'warning', completed: 'success', reopened: 'warning', cancelled: 'neutral', overdue: 'danger',
};
const PRIORITY_TONE: Record<WorkTask['priority'], Tone> = { low: 'neutral', normal: 'info', high: 'warning', urgent: 'danger' };
export const KIND_LABEL: Record<WorkTask['kind'], string> = { general: 'Task', document: 'Document upload', acknowledgement: 'Acknowledgement' };
const VERIFY_LABEL = { pending: 'Waiting for HR', verified: 'Verified', rejected: 'Rejected' } as const;
const VERIFY_TONE = { pending: 'warning', verified: 'success', rejected: 'danger' } as const;

export const fmtDate = (d: string | null | undefined) => (d ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(d.length === 10 ? `${d}T00:00:00Z` : d)) : '—');

export function StatusBadge({ task }: { task: Pick<WorkTask, 'displayStatus'> }) {
  return <Badge tone={STATUS_TONE[task.displayStatus]} dot>{STATUS_LABEL[task.displayStatus]}</Badge>;
}
export function PriorityBadge({ priority }: { priority: WorkTask['priority'] }) {
  return <Badge tone={PRIORITY_TONE[priority]}>{priority[0]!.toUpperCase() + priority.slice(1)} priority</Badge>;
}
export function VerificationBadge({ status }: { status: 'pending' | 'verified' | 'rejected' | null | undefined }) {
  if (!status) return null;
  return <Badge tone={VERIFY_TONE[status]}>{VERIFY_LABEL[status]}</Badge>;
}

const KIND_ICON = { general: ListTodo, document: FileUp, acknowledgement: ClipboardCheck } as const;

/** Tasks as cards: what it is, who it is from (or for), when it is due and where it stands. */
export function TaskCards({ tasks, showEmployee, empty }: { tasks: WorkTask[]; showEmployee?: boolean; empty: { title: string; description: string } }) {
  if (!tasks.length) return <EmptyState icon={<CheckCircle2 className="size-6" />} title={empty.title} description={empty.description} />;
  return (
    <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="task-cards">
      {tasks.map((t) => {
        const Icon = KIND_ICON[t.kind];
        return (
          <li key={t.id} className="min-w-0">
            <Link
              href={`/tasks/${t.id}`}
              className="group flex h-full flex-col gap-3 rounded-xl border border-border bg-bg-elevated p-4 transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent"><Icon className="size-4.5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg group-hover:text-accent">{t.title}</span>
                    {t.isNew && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold uppercase leading-4 text-accent-fg">New</span>}
                  </div>
                  <div className="truncate text-xs text-fg-subtle">{KIND_LABEL[t.kind]}{t.description ? ` · ${t.description}` : ''}</div>
                </div>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                <StatusBadge task={t} />
                {t.priority !== 'normal' && <PriorityBadge priority={t.priority} />}
                {t.document?.verificationStatus && t.status !== 'completed' && <VerificationBadge status={t.document.verificationStatus} />}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                <span className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" aria-hidden />{t.dueOn ? `Due ${fmtDate(t.dueOn)}` : 'No due date'}</span>
                <span className="inline-flex min-w-0 items-center gap-1"><UserRound className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{showEmployee ? t.employeeName : `From ${t.assignedBy ?? 'HR'}`}</span></span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const SUGGESTIONS = [
  ['Upload joining documents', 'document', 'other'], ['Submit identity proof', 'document', 'id_proof'], ['Submit address proof', 'document', 'address_proof'],
  ['Upload educational certificates', 'document', 'certificate'], ['Upload previous employment documents', 'document', 'other'], ['Submit bank details', 'general', ''],
  ['Complete your employee profile', 'general', ''], ['Sign employment documents', 'document', 'contract'], ['Submit emergency contact information', 'general', ''],
  ['Complete onboarding forms', 'general', ''], ['Acknowledge company policies', 'acknowledgement', ''], ['Complete HR compliance requirements', 'general', ''],
] as const;
const MANAGER_SUGGESTIONS = ['Project assignment', 'Daily work activities', 'Weekly deliverables', 'Monthly targets', 'Performance improvement activities', 'Client-related task', 'Internal reporting', 'Team responsibilities', 'Training activity'];
const DOC_CATEGORIES = [['id_proof', 'Identity proof'], ['address_proof', 'Address proof'], ['certificate', 'Certificate'], ['contract', 'Contract or signed document'], ['tax', 'Tax'], ['policy', 'Policy'], ['other', 'Other']] as const;
const FORMATS = [['pdf', 'PDF'], ['image', 'Image (PNG, JPEG, WebP)'], ['word', 'Word (.docx)'], ['text', 'Plain text']] as const;

/** Assign a task to one or more people. Only categories the member may assign are offered. */
export function AssignTask({ people }: { people: { hr: AssignablePerson[]; manager: AssignablePerson[] } }) {
  const router = useRouter();
  const categories = (['hr', 'manager'] as const).filter((c) => people[c].length);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<'hr' | 'manager'>(categories[0] ?? 'manager');
  const [kind, setKind] = useState<WorkTask['kind']>('general');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<WorkTask['priority']>('normal');
  const [dueOn, setDueOn] = useState('');
  const [docCategory, setDocCategory] = useState('other');
  const [formats, setFormats] = useState<string[]>(['pdf', 'image']);
  const [maxMb, setMaxMb] = useState('5');
  const [chosen, setChosen] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [pending, start] = useTransition();
  const list = people[category];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((p) => `${p.name} ${p.code ?? ''} ${p.departmentName ?? ''} ${p.designationName ?? ''}`.toLowerCase().includes(needle)) : list;
  }, [list, q]);
  if (!categories.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const reset = () => {
    setTitle(''); setDescription(''); setPriority('normal'); setDueOn(''); setKind('general'); setChosen([]); setQ(''); setError(null);
  };
  const pickSuggestion = (value: string) => {
    setTitle(value);
    const s = SUGGESTIONS.find(([t]) => t === value);
    if (s && category === 'hr') {
      setKind(s[1]);
      if (s[2]) setDocCategory(s[2]);
    }
  };
  const submit = () => start(async () => {
    setError(null);
    const r = await assignTaskAction({
      category, kind: category === 'manager' && kind === 'document' ? 'general' : kind, title, description: description || null, priority, dueOn: dueOn || null, employeeIds: chosen,
      document: kind === 'document' ? { category: docCategory, formats, maxMb: Number(maxMb) } : null,
    });
    if (!r.ok) {
      setError({ message: r.message, fields: r.fieldErrors });
      return;
    }
    setOpen(false);
    reset();
    router.refresh();
  });
  const allShown = filtered.length > 0 && filtered.every((p) => chosen.includes(p.id));
  return (
    <>
      <Button onClick={() => setOpen(true)} data-testid="assign-task">Assign a task</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Assign a task"
        description="Each person gets their own copy and a notification. Document tasks go to HR to verify once uploaded."
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!title.trim() || !chosen.length || (kind === 'document' && !formats.length)} onClick={submit}>Assign to {chosen.length || 'nobody yet'}</Button></>}
      >
        <div className="grid gap-4">
          {error && <Alert tone="danger">{error.message}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type of task">
              {(p) => (
                <Select {...p} value={category} onChange={(e) => { setCategory(e.target.value as 'hr' | 'manager'); setChosen([]); if (e.target.value === 'manager' && kind === 'document') setKind('general'); }} disabled={categories.length < 2}>
                  {categories.includes('hr') && <option value="hr">HR task</option>}
                  {categories.includes('manager') && <option value="manager">Manager task</option>}
                </Select>
              )}
            </Field>
            <Field label="What the person does">
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as WorkTask['kind'])}>
                  <option value="general">Complete a task</option>
                  {category === 'hr' && <option value="document">Upload a document for HR to verify</option>}
                  <option value="acknowledgement">Read and acknowledge</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Title" required error={error?.fields?.title}>
            {(p) => (
              <>
                <Input {...p} value={title} maxLength={200} list="task-suggestions" onChange={(e) => pickSuggestion(e.target.value)} placeholder={category === 'hr' ? 'Submit identity proof' : 'Weekly deliverables'} />
                <datalist id="task-suggestions">{(category === 'hr' ? SUGGESTIONS.map(([t]) => t) : MANAGER_SUGGESTIONS).map((t) => <option key={t} value={t} />)}</datalist>
              </>
            )}
          </Field>
          <Field label="Description" hint="What exactly is needed, and any instructions.">
            {(p) => <Textarea {...p} rows={3} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority">
              {(p) => (
                <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as WorkTask['priority'])}>
                  <option value="low">Low</option><option value="normal">Normal</option><option value="high">High (also emailed)</option><option value="urgent">Urgent (also emailed)</option>
                </Select>
              )}
            </Field>
            <Field label="Due date" error={error?.fields?.dueOn}>{(p) => <DatePicker {...p} value={dueOn} min={today} onChange={setDueOn} calendarLabel="Choose the due date" />}</Field>
          </div>
          {kind === 'document' && (
            <fieldset className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
              <legend className="px-1 text-sm font-medium">Document rules</legend>
              <Field label="Filed under">
                {(p) => <Select {...p} value={docCategory} onChange={(e) => setDocCategory(e.target.value)}>{DOC_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
              </Field>
              <Field label="Largest file (MB)">{(p) => <Input {...p} type="number" min={1} max={10} value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />}</Field>
              <div className="grid gap-2 sm:col-span-2">
                <span className="text-sm font-medium">Accepted formats</span>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {FORMATS.map(([v, l]) => <Checkbox key={v} label={l} checked={formats.includes(v)} onChange={(e) => setFormats((f) => (e.target.checked ? [...f, v] : f.filter((x) => x !== v)))} />)}
                </div>
              </div>
            </fieldset>
          )}
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">Assign to ({chosen.length} chosen)</span>
              <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={() => setChosen((c) => (allShown ? c.filter((id) => !filtered.some((p) => p.id === id)) : [...new Set([...c, ...filtered.map((p) => p.id)])]))}>
                {allShown ? 'Clear the people shown' : `Choose all ${filtered.length} shown`}
              </button>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input aria-label="Find people" className="pl-8" placeholder="Name, code, department or designation" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="People">
              {filtered.map((p) => (
                <li key={p.id} className="px-3 py-2">
                  <Checkbox
                    label={p.name}
                    description={[p.code, p.designationName, p.departmentName].filter(Boolean).join(' · ') || undefined}
                    checked={chosen.includes(p.id)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                  />
                </li>
              ))}
              {!filtered.length && <li className="px-3 py-4 text-center text-sm text-fg-muted">Nobody matches.</li>}
            </ul>
          </div>
        </div>
      </Dialog>
    </>
  );
}

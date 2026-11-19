'use client';
import type { AppraisalSection } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardHeader, cn, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { ActionResult } from '@/lib/api';
import type { AnswerValue, AppraisalDetail } from '@/lib/types';
import { publishAppraisalAction, reopenAppraisalAction, saveAppraisalAction, submitAppraisalAction } from '../actions';
import { day, pct, StageBadge, StageStepper } from '../appraisal-ui';

type Role = AppraisalDetail['role'];
const ROLE_LABEL: Record<Role, string> = { employee: 'Employee', manager: 'Manager', hr: 'HR' };
const ACTION_LABEL: Record<string, string> = {
  created: 'Appraisal opened', assigned: 'Appraisal opened', self_submitted: 'Self-appraisal submitted', manager_submitted: 'Manager evaluation submitted', finalized: 'Finalised by HR',
  published: 'Result shared with the employee', reopened: 'Reopened',
};
const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/** Which part of a section the viewer writes in. */
function writes(section: AppraisalSection, role: Role, hrScores: boolean) {
  if (section.kind === 'rated') return role !== 'hr' || hrScores ? 'score' : 'comment';
  return section.kind === (role === 'employee' ? 'self' : role) ? 'text' : null;
}

function ScorePicker({ value, min, max, onChange, label, disabled }: { value: number | null | undefined; min: number; max: number; onChange: (n: number | null) => void; label: string; disabled?: boolean }) {
  const values = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {values.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          disabled={disabled}
          onClick={() => onChange(value === n ? null : n)}
          className={cn(
            'size-8 rounded-md border text-sm font-medium tabular transition-colors motion-reduce:transition-none',
            value === n ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-bg hover:border-accent/60',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

const shown = (a: AnswerValue | undefined) => (a?.score === undefined || a?.score === null ? '—' : String(a.score));

export function AppraisalForm({ detail }: { detail: AppraisalDetail }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const d = detail.definition;
  const role = detail.role;
  const mineKey = role === 'employee' ? 'employee' : role;
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(detail.answers[mineKey] ?? {});
  const [finals, setFinals] = useState<Record<string, number | null>>(detail.answers.finalScores ?? {});
  const [finalPercent, setFinalPercent] = useState(detail.finalPercentOverride === null ? '' : String(detail.finalPercentOverride));
  const [overrideReason, setOverrideReason] = useState(detail.overrideReason ?? '');
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<null | 'submit' | 'publish' | 'reopen'>(null);
  const [reopenStage, setReopenStage] = useState<'self' | 'manager' | 'hr'>('self');
  const [reason, setReason] = useState('');
  const [dirty, setDirty] = useState(false);

  const isHr = role === 'hr';
  const showHrColumn = d.scoring.hrScores && (isHr || Object.keys(detail.answers.hr).length > 0);
  const showFinal = Object.keys(detail.result.finals).length > 0 || isHr;
  const editing = detail.canEdit;

  const set = (qid: string, patch: AnswerValue) => {
    setDirty(true);
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], ...patch } }));
  };

  // What is still unanswered for the viewer's part, so they can see it before submitting.
  const missing = useMemo(() => {
    if (!editing) return 0;
    let n = 0;
    for (const s of d.sections) {
      const w = writes(s, role, d.scoring.hrScores);
      if (w === 'score') for (const q of s.questions) if (q.required && (answers[q.id]?.score === undefined || answers[q.id]?.score === null)) n++;
      if (w === 'text') for (const q of s.questions) if (q.required && !answers[q.id]?.text?.trim()) n++;
    }
    return n;
  }, [answers, d, editing, role]);

  const body = () => {
    const b: Record<string, unknown> = { answers };
    if (isHr) {
      b.finalScores = finals;
      b.finalPercent = finalPercent.trim() === '' ? null : Number(finalPercent);
      b.overrideReason = overrideReason.trim() || null;
    }
    return b;
  };
  const run = (fn: () => Promise<ActionResult<unknown>>) => start(async () => {
    const r = await fn();
    setNotice(r.ok ? { tone: 'success', text: r.message ?? 'Saved.' } : { tone: 'danger', text: r.message });
    if (r.ok) {
      setDirty(false);
      setConfirm(null);
      setReason('');
      router.refresh();
    }
  });

  const stageFor: Record<Role, string> = { employee: 'self-appraisal', manager: 'evaluation', hr: 'review' };
  const submitLabel = role === 'employee' ? 'Submit self-appraisal' : role === 'manager' ? 'Submit evaluation' : 'Finalise appraisal';

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 content-start gap-6">
        <Card>
          <div className="grid gap-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StageStepper stage={detail.stage} />
              <StageBadge stage={detail.stage} />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div><dt className="text-xs text-fg-subtle">Employee</dt><dd className="font-medium">{detail.employee.name}{detail.employee.code ? ` · ${detail.employee.code}` : ''}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Designation</dt><dd className="font-medium">{detail.employee.designation ?? '—'}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Department</dt><dd className="font-medium">{detail.employee.department ?? '—'}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Date of joining</dt><dd className="font-medium">{day(detail.employee.dateOfJoining)}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Reporting manager</dt><dd className="font-medium">{detail.employee.managerName ?? 'None (goes to HR)'}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Review period</dt><dd className="font-medium">{day(detail.cycle.periodStart)} to {day(detail.cycle.periodEnd)}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Self-appraisal due</dt><dd className="font-medium">{day(detail.cycle.selfDue)}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Manager due</dt><dd className="font-medium">{day(detail.cycle.managerDue)}</dd></div>
            </dl>
            {d.intro && <p className="whitespace-pre-line text-sm text-fg-muted">{d.intro}</p>}
          </div>
        </Card>

        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {!editing && role === 'employee' && detail.stage !== 'published' && (
          <Alert tone="info" title="Submitted and locked">Your manager and HR are working on it now. You will see the result when HR shares it.</Alert>
        )}
        {!editing && role === 'manager' && detail.stage === 'self' && (
          <Alert tone="info" title="Waiting for the self-appraisal">You can evaluate once {detail.employee.name} submits. You will be notified.</Alert>
        )}

        {d.scale.levels.length > 0 && (
          <Card>
            <CardHeader title="Rating scale" description={`Scores from ${d.scale.min} to ${d.scale.max}.`} />
            <ul className="grid gap-2 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3" aria-label="Rating scale">
              {d.scale.levels.map((l) => (
                <li key={l.label} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2"><span className="font-medium">{l.label}</span><Badge tone="neutral">{l.from}–{l.to}</Badge></div>
                  {l.description && <p className="mt-1 text-xs text-fg-muted">{l.description}</p>}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {d.sections.map((s) => {
          const w = editing ? writes(s, role, d.scoring.hrScores) : null;
          if (s.kind === 'rated') {
            return (
              <Card key={s.id}>
                <CardHeader title={s.title} description={s.description || undefined} />
                <ol className="grid divide-y divide-border">
                  {s.questions.map((q, i) => {
                    const mine = answers[q.id];
                    const level = detail.result.levels[q.id];
                    return (
                      <li key={q.id} className="grid gap-3 px-5 py-4" data-testid={`question-${q.id}`}>
                        <div className="flex items-start justify-between gap-3">
                          <p className="text-sm font-medium"><span className="text-fg-subtle">{i + 1}. </span>{q.text}{q.required && w === 'score' && <span className="text-danger" aria-hidden> *</span>}</p>
                          {q.weight !== 1 && <Badge tone="neutral">Weight {q.weight}</Badge>}
                        </div>
                        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-fg-muted">
                          {(role !== 'employee' || !editing) && <span>Employee: <b className="tabular text-fg">{shown(role === 'employee' ? mine : detail.answers.employee[q.id])}</b></span>}
                          {(role === 'hr' || Object.keys(detail.answers.manager).length > 0) && role !== 'manager' && <span>Manager: <b className="tabular text-fg">{shown(detail.answers.manager[q.id])}</b></span>}
                          {showHrColumn && role !== 'hr' && <span>HR: <b className="tabular text-fg">{shown(detail.answers.hr[q.id])}</b></span>}
                          {showFinal && detail.result.finals[q.id] !== undefined && <span>Final: <b className="tabular text-fg">{detail.result.finals[q.id] ?? '—'}</b>{level ? ` (${level})` : ''}</span>}
                        </div>
                        {role === 'manager' && detail.answers.employee[q.id]?.comment && <p className="rounded-md bg-bg-subtle px-3 py-2 text-xs text-fg-muted"><b>Employee comment:</b> {detail.answers.employee[q.id]?.comment}</p>}
                        {role === 'hr' && detail.answers.manager[q.id]?.comment && <p className="rounded-md bg-bg-subtle px-3 py-2 text-xs text-fg-muted"><b>Manager comment:</b> {detail.answers.manager[q.id]?.comment}</p>}
                        {w === 'score' && (
                          <div className="grid gap-2 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
                            <ScorePicker label={`${ROLE_LABEL[role]} score for ${q.text}`} min={d.scale.min} max={d.scale.max} value={mine?.score} onChange={(n) => set(q.id, { score: n })} />
                            <Textarea aria-label={`Comment on ${q.text}`} rows={1} maxLength={4000} placeholder="Comment (optional)" value={mine?.comment ?? ''} onChange={(e) => set(q.id, { comment: e.target.value })} />
                          </div>
                        )}
                        {w === 'comment' && <Textarea aria-label={`HR comment on ${q.text}`} rows={1} maxLength={4000} placeholder="HR comment (optional)" value={mine?.comment ?? ''} onChange={(e) => set(q.id, { comment: e.target.value })} />}
                        {isHr && editing && (
                          <label className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                            Final score override
                            <Select aria-label={`Final score for ${q.text}`} className="h-8 w-24" value={finals[q.id] ?? ''} onChange={(e) => { setDirty(true); setFinals((p) => ({ ...p, [q.id]: e.target.value === '' ? null : Number(e.target.value) })); }}>
                              <option value="">Calculated</option>
                              {Array.from({ length: d.scale.max - d.scale.min + 1 }, (_, k) => d.scale.min + k).map((n) => <option key={n} value={n}>{n}</option>)}
                            </Select>
                          </label>
                        )}
                        {!editing && mine?.comment && role !== 'hr' && <p className="text-xs text-fg-muted"><b>Your comment:</b> {mine.comment}</p>}
                      </li>
                    );
                  })}
                </ol>
              </Card>
            );
          }
          // Written sections: self (employee), manager, hr.
          const source = s.kind === 'self' ? detail.answers.employee : s.kind === 'manager' ? detail.answers.manager : detail.answers.hr;
          const ownSection = s.kind === (role === 'employee' ? 'self' : role);
          const visible = ownSection || Object.keys(source).length > 0;
          if (!visible) return null;
          const who = s.kind === 'self' ? 'Employee' : s.kind === 'manager' ? 'Manager' : 'HR';
          return (
            <Card key={s.id}>
              <CardHeader title={s.title} description={s.description || `Written by: ${who}`} />
              <div className="grid gap-4 px-5 pb-5">
                {s.questions.map((q) => {
                  const value = ownSection ? answers[q.id]?.text ?? '' : source[q.id]?.text ?? '';
                  return w === 'text' ? (
                    <Field key={q.id} label={q.text} required={q.required}>
                      {(p) => q.kind === 'short_text'
                        ? <Input {...p} maxLength={8000} value={value} onChange={(e) => set(q.id, { text: e.target.value })} />
                        : <Textarea {...p} rows={4} maxLength={8000} value={value} onChange={(e) => set(q.id, { text: e.target.value })} />}
                    </Field>
                  ) : (
                    <div key={q.id}>
                      <div className="text-sm font-medium">{q.text}</div>
                      <p className="mt-1 whitespace-pre-line text-sm text-fg-muted">{value || '—'}</p>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}

        {isHr && editing && (
          <Card>
            <CardHeader title="Final percentage" description={`Calculated: ${pct(detail.result.calculatedPercent)}. Leave the box empty to use it, or record a different approved percentage with a reason.`} />
            <div className="grid gap-4 px-5 pb-5 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Field label="Approved %">{(p) => <Input {...p} type="number" min={0} max={100} step={0.1} value={finalPercent} onChange={(e) => { setDirty(true); setFinalPercent(e.target.value); }} />}</Field>
              <Field label="Reason for the change" required={finalPercent.trim() !== ''}>{(p) => <Textarea {...p} rows={2} maxLength={1000} value={overrideReason} onChange={(e) => { setDirty(true); setOverrideReason(e.target.value); }} />}</Field>
            </div>
          </Card>
        )}

        {d.declaration && role === 'employee' && editing && <Alert tone="info" title="Declaration">{d.declaration}</Alert>}

        {(editing || (isHr && detail.stage !== 'self')) && (
          <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border bg-bg/95 p-3 backdrop-blur">
            {editing && <span className="mr-auto text-sm text-fg-muted">{missing ? `${missing} required ${missing === 1 ? 'answer' : 'answers'} left` : 'Everything required is answered'}{dirty ? ' · unsaved changes' : ''}</span>}
            {isHr && detail.stage !== 'self' && <Button variant="ghost" onClick={() => { setReopenStage(detail.stage === 'manager' ? 'self' : 'manager'); setConfirm('reopen'); }}>Reopen a stage</Button>}
            {editing && <Button variant="secondary" loading={pending && !confirm} onClick={() => run(() => saveAppraisalAction(detail.id, body()))}>Save draft</Button>}
            {editing && <Button disabled={missing > 0} onClick={() => setConfirm('submit')}>{submitLabel}</Button>}
            {isHr && detail.stage === 'finalized' && <Button onClick={() => setConfirm('publish')}>Share result with employee</Button>}
          </div>
        )}
      </div>

      <aside className="grid content-start gap-6">
        <Card>
          <CardHeader title="Result" />
          <dl className="grid gap-3 px-5 pb-5 text-sm">
            <div className="flex justify-between"><dt className="text-fg-muted">Self score</dt><dd className="tabular font-medium">{pct(detail.result.selfPercent)}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-muted">Manager score</dt><dd className="tabular font-medium">{pct(detail.result.managerPercent)}</dd></div>
            {d.scoring.hrScores && <div className="flex justify-between"><dt className="text-fg-muted">HR score</dt><dd className="tabular font-medium">{pct(detail.result.hrPercent)}</dd></div>}
            {isHr && <div className="flex justify-between"><dt className="text-fg-muted">Calculated</dt><dd className="tabular font-medium">{pct(detail.result.calculatedPercent)}</dd></div>}
            <div className="flex justify-between border-t border-border pt-3"><dt className="font-medium">Final</dt><dd className="tabular text-lg font-semibold" data-testid="final-percent">{pct(detail.result.finalPercent)}</dd></div>
            <div className="flex justify-between"><dt className="text-fg-muted">Category</dt><dd className="font-medium" data-testid="final-band">{detail.result.band ?? '—'}</dd></div>
            {detail.overrideReason && <div className="rounded-md bg-bg-subtle p-2 text-xs text-fg-muted"><b>Changed by HR:</b> {detail.overrideReason}</div>}
          </dl>
        </Card>
        <Card>
          <CardHeader title="Performance categories" />
          <ul className="grid gap-1 px-5 pb-5 text-sm">
            {[...d.bands].sort((a, b) => b.min - a.min).map((b) => (
              <li key={b.label} className={cn('flex justify-between rounded px-2 py-1', detail.result.band === b.label && 'bg-accent/10 font-semibold')}><span>{b.label}</span><span className="tabular text-fg-muted">{b.min}%+</span></li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Timeline" />
          <ol className="grid gap-3 px-5 pb-5 text-sm" aria-label="Appraisal history">
            {detail.history.map((h, i) => (
              <li key={i} className="border-l-2 border-border pl-3">
                <div className="font-medium">{ACTION_LABEL[h.action] ?? h.action}</div>
                <div className="text-xs text-fg-subtle">{when(h.at)}{h.by ? ` · ${h.by}` : ''}</div>
                {h.note && <p className="mt-1 text-xs text-fg-muted">{h.note}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </aside>

      <Dialog
        open={confirm === 'submit'}
        onClose={() => setConfirm(null)}
        title={submitLabel}
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Back</Button><Button loading={pending} onClick={() => run(() => submitAppraisalAction(detail.id, body()))}>Submit</Button></>}
      >
        <p className="text-sm text-fg-muted">Your {stageFor[role]} locks once you submit{role === 'hr' ? ' and the result is worked out' : ''}. Only HR can reopen it.</p>
      </Dialog>
      <Dialog
        open={confirm === 'publish'}
        onClose={() => setConfirm(null)}
        title="Share the result"
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Back</Button><Button loading={pending} onClick={() => run(() => publishAppraisalAction(detail.id))}>Share result</Button></>}
      >
        <p className="text-sm text-fg-muted">{detail.employee.name} will see the manager&apos;s scores, the final {pct(detail.result.finalPercent)} and the category &quot;{detail.result.band ?? '—'}&quot;, and is notified.</p>
      </Dialog>
      <Dialog
        open={confirm === 'reopen'}
        onClose={() => setConfirm(null)}
        title="Reopen a stage"
        footer={<><Button variant="secondary" onClick={() => setConfirm(null)}>Back</Button><Button loading={pending} disabled={reason.trim().length < 3} onClick={() => run(() => reopenAppraisalAction(detail.id, reopenStage, reason.trim()))}>Reopen</Button></>}
      >
        <div className="grid gap-4">
          <Field label="Send back to">
            {(p) => (
              <Select {...p} value={reopenStage} onChange={(e) => setReopenStage(e.target.value as typeof reopenStage)}>
                <option value="self">Employee (self-appraisal)</option>
                {detail.stage !== 'manager' && <option value="manager">Manager (evaluation)</option>}
                {(detail.stage === 'finalized' || detail.stage === 'published') && <option value="hr">HR review</option>}
              </Select>
            )}
          </Field>
          <Field label="Reason" required>{(p) => <Textarea {...p} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </div>
  );
}

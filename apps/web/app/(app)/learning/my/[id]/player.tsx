'use client';
import { BLOCK_LABEL, type LearnerQuestion, type QuizAnswers } from '@crew/contracts';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, Table, TBody, TD, TH, THead, TR, Textarea, buttonClass, cn } from '@crew/ui';
import { Award, CheckCircle2, ChevronLeft, ChevronRight, Circle, Clock, ExternalLink, FileText, Lock, Paperclip, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { RichTextView } from '@/components/rich-text';
import { progressAction, saveAnswersAction, startAttemptAction, submitAssignmentAction, submitAttemptAction } from '../../actions';
import { creatorLabel, dateLabel, DueLabel, LearnerStatusBadge, minutesLabel, ProgressBar, SubmissionBadge } from '../../labels';
import type { AttemptResult, AttemptStart, PlayerBlock, PlayerView } from '../../types';
import { UploadButton, type UploadedFile } from '../../upload';

const fileUrl = (id: string) => `/learning-files/${id}`;
const OPEN_STATUSES = ['not_started', 'in_progress', 'overdue'];

type Report = (block: PlayerBlock, body: { action: 'open' | 'complete' | 'heartbeat'; position?: number; duration?: number; seconds: number }) => Promise<string | null>;

/** Video or audio that reports how far the learner really got (skipping ahead is not counted, and is held back while the rule needs watching). */
function TrackedMedia({ block, src, report, open }: { block: PlayerBlock; src: string; report: Report; open: boolean }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const furthest = useRef(0);
  const last = useRef(0);
  const sinceReport = useRef(0);
  const watching = (block.completion === 'full' || block.completion === 'percent') && !block.state.done && open;
  const send = useCallback((ended = false) => {
    const el = ref.current;
    if (!el || !el.duration || !Number.isFinite(el.duration)) return;
    const seconds = Math.round(sinceReport.current);
    sinceReport.current = 0;
    void report(block, { action: 'heartbeat', position: ended ? el.duration : furthest.current, duration: el.duration, seconds });
  }, [block, report]);
  useEffect(() => () => { if (sinceReport.current > 1) send(); }, [send]);
  const common = {
    ref, src, controls: true, preload: 'metadata' as const, className: block.kind === 'video' ? 'aspect-video w-full rounded-lg bg-black' : 'w-full',
    'data-testid': `media-${block.id}`,
    onLoadedMetadata: () => {
      const el = ref.current;
      if (el && el.duration) furthest.current = Math.max(furthest.current, ((block.state.percent ?? 0) / 100) * el.duration);
    },
    onTimeUpdate: () => {
      const el = ref.current;
      if (!el) return;
      const step = el.currentTime - last.current;
      if (step > 0 && step < 2.5) {
        furthest.current = Math.max(furthest.current, el.currentTime);
        sinceReport.current += step;
      }
      last.current = el.currentTime;
      if (sinceReport.current >= 15) send();
    },
    onSeeking: () => {
      const el = ref.current;
      if (!el) return;
      if (watching && el.currentTime > furthest.current + 1) el.currentTime = furthest.current;
      last.current = el.currentTime;
    },
    onPause: () => send(),
    onEnded: () => {
      furthest.current = ref.current?.duration ?? furthest.current;
      send(true);
    },
  };
  return (
    <div className="grid gap-2">
      {block.kind === 'video' ? <video {...common} /> : <audio {...common} />}
      {watching && <p className="text-xs text-fg-muted">{block.completion === 'full' ? `${block.kind === 'video' ? 'Watch' : 'Listen to'} it to the end to complete this item.` : `${block.kind === 'video' ? 'Watch' : 'Listen to'} at least ${block.minPercent}% to complete this item.`} You have reached {block.state.percent ?? 0}%.</p>}
    </div>
  );
}

function Content({ block, report, open }: { block: PlayerBlock; report: Report; open: boolean }) {
  const src = block.source?.type === 'upload' ? fileUrl(block.source.fileId) : block.source?.type === 'url' ? block.source.url : null;
  switch (block.kind) {
    case 'text':
      return (
        <div className="grid gap-3">
          <RichTextView html={block.body ?? ''} className="text-sm leading-relaxed" />
          {!!block.attachmentFileIds?.length && (
            <ul className="flex flex-wrap gap-2">{block.attachmentFileIds.map((f, i) => <li key={f}><a className={buttonClass('secondary', 'sm')} href={fileUrl(f)} target="_blank" rel="noreferrer"><Paperclip className="size-4" aria-hidden />Attachment {i + 1}</a></li>)}</ul>
          )}
        </div>
      );
    case 'video':
    case 'audio':
      if (block.embed) {
        return <iframe title={block.title} src={block.embed} className="aspect-video w-full rounded-lg border-0" allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" />;
      }
      return src ? <TrackedMedia block={block} src={src} report={report} open={open} /> : null;
    case 'document':
    case 'presentation': {
      if (!src) return null;
      const pdf = block.source?.type === 'upload' ? true : /\.pdf($|\?)/i.test(src);
      return (
        <div className="grid gap-2">
          {block.source?.type === 'upload' && pdf && <iframe title={block.title} src={src} className="h-[70vh] w-full rounded-lg border border-border bg-white" />}
          <a href={src} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm', 'w-fit')} onClick={() => void report(block, { action: 'open', seconds: 0 })}>
            <FileText className="size-4" aria-hidden />Open {block.kind === 'presentation' ? 'the presentation' : 'the document'} in a new tab
          </a>
        </div>
      );
    }
    case 'image':
      return src ? <figure className="m-0 grid gap-2"><img src={src} alt={block.caption || block.title} className="max-h-[70vh] w-full rounded-lg object-contain" />{block.caption && <figcaption className="text-xs text-fg-muted">{block.caption}</figcaption>}</figure> : null;
    case 'external':
      return (
        <a href={block.url} target="_blank" rel="noreferrer noopener" className={buttonClass('primary', 'sm', 'w-fit')} onClick={() => void report(block, { action: 'open', seconds: 0 })}>
          <ExternalLink className="size-4" aria-hidden />Open the resource
        </a>
      );
    default:
      return null;
  }
}

function QuestionInput({ q, value, onChange, n }: { q: LearnerQuestion; value: string | string[] | undefined; onChange: (v: string | string[]) => void; n: number }) {
  const list = Array.isArray(value) ? value : [];
  const name = `q-${q.id}`;
  return (
    <fieldset className="grid gap-2 rounded-lg border border-border p-4" data-testid={`question-${q.id}`}>
      <legend className="px-1 text-sm font-medium">{n}. {q.text} <span className="text-xs font-normal text-fg-subtle">({q.marks} mark{q.marks === 1 ? '' : 's'}{q.required ? '' : ', optional'})</span></legend>
      {q.scenario && <p className="whitespace-pre-line rounded-md bg-bg-subtle p-3 text-[0.8125rem]">{q.scenario}</p>}
      {(q.type === 'single' || q.type === 'scenario' || q.type === 'true_false') && q.options.map((o) => (
        <label key={o.id} className="flex cursor-pointer items-center gap-2 text-[0.8125rem]">
          <input type="radio" name={name} checked={list[0] === o.id} onChange={() => onChange([o.id])} />{o.text}
        </label>
      ))}
      {q.type === 'multiple' && q.options.map((o) => (
        <label key={o.id} className="flex cursor-pointer items-center gap-2 text-[0.8125rem]">
          <input type="checkbox" checked={list.includes(o.id)} onChange={() => onChange(list.includes(o.id) ? list.filter((x) => x !== o.id) : [...list, o.id])} />{o.text}
        </label>
      ))}
      {(q.type === 'exact' || q.type === 'short') && <Input aria-label={q.text} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} maxLength={q.type === 'exact' ? 200 : 2000} />}
      {q.type === 'long' && <Textarea aria-label={q.text} rows={6} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} maxLength={8000} />}
      {q.type === 'matching' && (
        <div className="grid gap-2">
          {q.left.map((l, i) => (
            <label key={l} className="grid items-center gap-2 text-[0.8125rem] sm:grid-cols-[1fr_1fr]">
              <span>{l}</span>
              <select className="h-9 rounded-lg border border-border bg-bg px-2" aria-label={`Match for ${l}`} value={list[i] ?? ''} onChange={(e) => { const next = [...q.left.map((_, k) => list[k] ?? '')]; next[i] = e.target.value; onChange(next); }}>
                <option value="">Choose</option>
                {q.right.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function Countdown({ deadline, onExpire }: { deadline: string; onExpire: () => void }) {
  const [left, setLeft] = useState(() => new Date(deadline).getTime() - Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      const l = new Date(deadline).getTime() - Date.now();
      setLeft(l);
      if (l <= 0) { clearInterval(t); onExpire(); }
    }, 1000);
    return () => clearInterval(t);
  }, [deadline, onExpire]);
  const s = Math.max(0, Math.floor(left / 1000));
  return <Badge tone={s < 60 ? 'danger' : 'info'}><Clock className="size-3" aria-hidden />{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')} left</Badge>;
}

function QuizRunner({ enrolmentId, block, open, onView }: { enrolmentId: string; block: PlayerBlock; open: boolean; onView: (v: PlayerView) => void }) {
  const [attempt, setAttempt] = useState<AttemptStart | null>(null);
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [result, setResult] = useState<AttemptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = useRef(false);
  const s = block.settings ?? {};
  const attempts = block.attempts ?? [];
  const used = attempts.filter((a) => a.status !== 'in_progress').length;
  const waiting = attempts.some((a) => a.status === 'pending_review');
  const passed = block.state.passed === true;
  const left = s.maxAttempts ? Math.max(0, s.maxAttempts - used) : null;
  const canStart = open && !passed && !waiting && (left === null || left > 0) && (used === 0 || s.allowRetake !== false);

  useEffect(() => {
    if (!attempt) return;
    const t = setInterval(() => {
      if (!dirty.current) return;
      dirty.current = false;
      void saveAnswersAction(enrolmentId, block.id, attempt.attemptId, answers);
    }, 15_000);
    return () => clearInterval(t);
  }, [attempt, answers, enrolmentId, block.id]);

  const submit = useCallback(() => {
    if (!attempt) return;
    start(async () => {
      const r = await submitAttemptAction(enrolmentId, block.id, attempt.attemptId, answers);
      if (!r.ok) { setError(r.message); return; }
      setResult(r.data!);
      setAttempt(null);
      onView(r.data!.enrolment);
    });
  }, [attempt, answers, enrolmentId, block.id, onView]);

  if (attempt) {
    const missing = attempt.questions.filter((q) => q.required && !(Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).some(Boolean) : String(answers[q.id] ?? '').trim())).length;
    return (
      <div className="grid gap-4" data-testid="quiz-attempt">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-fg-muted">Attempt {attempt.attemptNo}{s.maxAttempts ? ` of ${s.maxAttempts}` : ''} · pass mark {s.passPercent}%</span>
          {attempt.deadlineAt && <Countdown deadline={attempt.deadlineAt} onExpire={submit} />}
        </div>
        {attempt.questions.map((q, i) => <QuestionInput key={q.id} q={q} n={i + 1} value={answers[q.id]} onChange={(v) => { dirty.current = true; setAnswers({ ...answers, [q.id]: v }); }} />)}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button loading={pending} onClick={submit} data-testid="submit-quiz">Submit answers</Button>
          {missing > 0 && <span className="text-xs text-warning">{missing} required question{missing === 1 ? '' : 's'} not answered yet</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-2 gap-3 text-[0.8125rem] sm:grid-cols-4">
        <div><dt className="text-xs text-fg-subtle">Questions</dt><dd className="font-medium">{block.questionCount}</dd></div>
        <div><dt className="text-xs text-fg-subtle">Pass mark</dt><dd className="font-medium">{s.passPercent}%</dd></div>
        <div><dt className="text-xs text-fg-subtle">Attempts</dt><dd className="font-medium">{used}{s.maxAttempts ? ` of ${s.maxAttempts}` : ' (no limit)'}</dd></div>
        <div><dt className="text-xs text-fg-subtle">Time limit</dt><dd className="font-medium">{s.timeLimitMinutes ? `${s.timeLimitMinutes} min` : 'None'}</dd></div>
      </dl>
      {result && (
        <Alert tone={result.pendingReview ? 'info' : result.passed ? 'success' : result.passed === false ? 'danger' : 'info'} title={result.pendingReview ? 'Submitted. A reviewer marks your written answers.' : result.percent !== null ? `You scored ${result.percent}%: ${result.passed ? 'passed' : 'not passed'}` : 'Submitted.'}>
          {result.late && 'The time limit had passed, so only the answers saved before it count. '}
          {!result.pendingReview && result.passed === false && (left === null || left > 0) && s.allowRetake !== false && 'You can try again.'}
        </Alert>
      )}
      {result?.questions && (
        <ul className="grid gap-2" data-testid="quiz-review">
          {result.questions.map((q) => (
            <li key={q.id} className="rounded-lg border border-border p-3 text-[0.8125rem]">
              <p className="flex items-start gap-2 font-medium">{q.correct ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Correct" /> : <X className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Not correct" />}{q.text}</p>
              <p className="mt-1 text-xs text-fg-muted">Correct answer: {q.answer.join(', ')} · {q.earned}/{q.marks}</p>
              {q.explanation && <p className="mt-1 text-xs text-fg-muted">{q.explanation}</p>}
            </li>
          ))}
        </ul>
      )}
      {attempts.length > 0 && (
        <Table aria-label="Your attempts">
          <THead><TR><TH>Attempt</TH><TH>Result</TH><TH>Submitted</TH></TR></THead>
          <TBody>
            {attempts.map((a) => (
              <TR key={a.id}>
                <TD>#{a.attemptNo}</TD>
                <TD>{a.status === 'pending_review' ? <Badge tone="info">Waiting for marks</Badge> : a.status === 'in_progress' ? <Badge>In progress</Badge> : a.percent !== null ? <Badge tone={a.passed ? 'success' : 'danger'}>{a.percent}% · {a.passed ? 'Passed' : 'Not passed'}</Badge> : <Badge>Submitted</Badge>}</TD>
                <TD className="text-fg-muted">{dateLabel(a.submittedAt)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {passed ? <Alert tone="success">You passed this quiz.</Alert> : waiting ? <Alert tone="info">Your answers are with a reviewer. You will be told the result.</Alert> : !canStart && open ? <Alert tone="warning">No attempts left. Ask HR if you need another try.</Alert> : null}
      {canStart && (
        <Button className="w-fit" loading={pending} data-testid="start-quiz" onClick={() => start(async () => {
          setError(null);
          const r = await startAttemptAction(enrolmentId, block.id);
          if (!r.ok) { setError(r.message); return; }
          setResult(null);
          setAttempt(r.data!);
          setAnswers(r.data!.answers ?? {});
        })}>{attempts.some((a) => a.status === 'in_progress') ? 'Continue the attempt' : used ? 'Try again' : 'Start the quiz'}</Button>
      )}
    </div>
  );
}

function AssignmentPanel({ enrolmentId, block, open, onView }: { enrolmentId: string; block: PlayerBlock; open: boolean; onView: (v: PlayerView) => void }) {
  const s = block.settings ?? {};
  const types = s.submissionTypes ?? ['text'];
  const subs = block.submissions ?? [];
  const last = subs.at(-1);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const notYet = s.startOn && s.startOn > new Date().toISOString().slice(0, 10);
  const canSubmit = open && !notYet && (!last || last.status === 'resubmit');
  return (
    <div className="grid gap-4">
      <p className="whitespace-pre-line text-sm leading-relaxed">{s.instructions}</p>
      <dl className="grid grid-cols-2 gap-3 text-[0.8125rem] sm:grid-cols-4">
        {s.startOn && <div><dt className="text-xs text-fg-subtle">Opens</dt><dd className="font-medium">{dateLabel(s.startOn)}</dd></div>}
        {s.dueOn && <div><dt className="text-xs text-fg-subtle">Due</dt><dd className="font-medium">{dateLabel(s.dueOn)}</dd></div>}
        <div><dt className="text-xs text-fg-subtle">{s.gradingMethod === 'pass_fail' ? 'Grading' : 'Maximum score'}</dt><dd className="font-medium">{s.gradingMethod === 'pass_fail' ? 'Pass or fail' : s.maxScore}</dd></div>
        {s.gradingMethod !== 'pass_fail' && <div><dt className="text-xs text-fg-subtle">Passing score</dt><dd className="font-medium">{s.passScore}</dd></div>}
      </dl>
      {!!s.referenceFileIds?.length && (
        <div className="flex flex-wrap gap-2">{s.referenceFileIds.map((f, i) => <a key={f} className={buttonClass('secondary', 'sm')} href={fileUrl(f)} target="_blank" rel="noreferrer"><Paperclip className="size-4" aria-hidden />Reference material {i + 1}</a>)}</div>
      )}
      {subs.length > 0 && (
        <ol className="grid gap-2" aria-label="Your submissions">
          {subs.map((x, i) => (
            <li key={x.id} className="grid gap-1 rounded-lg border border-border p-3 text-[0.8125rem]" data-testid="my-submission">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">Submission {i + 1}</span><SubmissionBadge status={x.status} /><span className="text-xs text-fg-subtle">{dateLabel(x.submittedAt)}</span>{x.score !== null && <Badge tone="neutral">Score {x.score}{s.maxScore ? `/${s.maxScore}` : ''}</Badge>}</div>
              {x.text && <p className="whitespace-pre-line text-fg-muted">{x.text}</p>}
              {x.link && <a className="text-accent underline" href={x.link} target="_blank" rel="noreferrer noopener">{x.link}</a>}
              {x.fileIds.map((f, k) => <a key={f} className="text-accent underline" href={fileUrl(f)} target="_blank" rel="noreferrer">File {k + 1}</a>)}
              {x.feedback && <p className="rounded-md bg-bg-subtle p-2"><span className="font-medium">Feedback{x.reviewer ? ` from ${x.reviewer}` : ''}:</span> {x.feedback}</p>}
            </li>
          ))}
        </ol>
      )}
      {notYet && <Alert tone="info">This assignment opens on {dateLabel(s.startOn)}.</Alert>}
      {canSubmit && (
        <div className="grid gap-3 rounded-lg border border-border p-4" data-testid="assignment-form">
          <h4 className="text-sm font-semibold">{last?.status === 'resubmit' ? 'Submit again' : 'Your submission'}</h4>
          {types.includes('text') && <Field label="Written response">{(p) => <Textarea {...p} rows={6} value={text} onChange={(e) => setText(e.target.value)} maxLength={20000} />}</Field>}
          {types.includes('link') && <Field label="Link" hint="An https:// link, for example to a shared document">{(p) => <Input {...p} type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" />}</Field>}
          {types.includes('file') && (
            <div className="grid gap-2">
              <span className="text-[0.8125rem] font-medium">Files</span>
              <ul className="flex flex-wrap gap-2">{files.map((f) => <li key={f.id}><Badge>{f.name}<button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.id !== f.id))}><X className="size-3" /></button></Badge></li>)}</ul>
              {files.length < 5 && <UploadButton purpose="submission" label="Attach a file" accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,image/png,image/jpeg,image/webp,video/mp4" onUploaded={(f) => setFiles([...files, f])} testId="submission-file" />}
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
          <Button className="w-fit" loading={pending} data-testid="submit-assignment" disabled={!text.trim() && !link.trim() && !files.length} onClick={() => start(async () => {
            setError(null);
            const r = await submitAssignmentAction(enrolmentId, block.id, { text: text.trim(), link: link.trim() || null, fileIds: files.map((f) => f.id) });
            if (!r.ok) { setError(r.message); return; }
            setText(''); setLink(''); setFiles([]);
            onView(r.data!);
          })}>Submit for review</Button>
        </div>
      )}
    </div>
  );
}

export function Player({ initial, startAt }: { initial: PlayerView; startAt?: string }) {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const firstOpen = Math.max(0, view.blocks.findIndex((b) => !b.state.done));
  const [index, setIndex] = useState(() => {
    const i = startAt ? view.blocks.findIndex((b) => b.id === startAt) : -1;
    return i >= 0 ? i : view.status === 'completed' ? 0 : firstOpen;
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shownAt = useRef(Date.now());
  const open = OPEN_STATUSES.includes(view.status);
  const block = view.blocks[index];
  const wasCompleted = useRef(view.status === 'completed');

  const onView = useCallback((v: PlayerView) => {
    setView(v);
    if (v.status === 'completed' && !wasCompleted.current) {
      wasCompleted.current = true;
      router.refresh();
    }
  }, [router]);

  const report: Report = useCallback(async (b, body) => {
    if (!open || b.kind === 'quiz' || b.kind === 'assignment') return null;
    const r = await progressAction(view.id, b.id, body);
    if (r.ok) onView(r.data!);
    return r.ok ? null : r.message;
  }, [open, view.id, onView]);

  // Opening an item is recorded (it completes items whose rule is "opening it counts").
  useEffect(() => {
    shownAt.current = Date.now();
    if (block && open && !block.state.done && block.kind !== 'quiz' && block.kind !== 'assignment' && !block.state.openedAt) void report(block, { action: 'open', seconds: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  if (!block) return <Alert tone="info">This module has no content yet.</Alert>;
  const manual = block.completion === 'manual' && !block.state.done && open && !view.classroom;
  const go = (i: number) => { setError(null); setIndex(i); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="grid content-start gap-4">
        <Card>
          <CardBody className="grid gap-3 text-[0.8125rem]">
            <div className="flex flex-wrap items-center gap-2"><LearnerStatusBadge status={view.status} /><Badge tone="neutral">Version {view.version}</Badge></div>
            <ProgressBar value={view.progressPercent} label="Module progress" />
            <dl className="grid gap-1.5 text-xs text-fg-muted">
              <div><dt className="inline font-medium text-fg">Created by: </dt><dd className="inline">{creatorLabel(view.creator)}</dd></div>
              {view.assignedBy && <div><dt className="inline font-medium text-fg">Assigned by: </dt><dd className="inline">{view.assignedBy}{view.assignedOn ? ` on ${dateLabel(view.assignedOn)}` : ''}</dd></div>}
              <div><dt className="sr-only">Deadline</dt><dd><DueLabel dueOn={view.dueOn} due={view.due} /></dd></div>
              {minutesLabel(view.durationMinutes) && <div><dt className="inline font-medium text-fg">Length: </dt><dd className="inline">{minutesLabel(view.durationMinutes)}</dd></div>}
              <div><dt className="inline font-medium text-fg">Time spent: </dt><dd className="inline">{minutesLabel(view.timeSpentMinutes) ?? 'Under a minute'}</dd></div>
              {view.scorePercent !== null && <div><dt className="inline font-medium text-fg">Score: </dt><dd className="inline" data-testid="module-score">{view.scorePercent}%</dd></div>}
            </dl>
          </CardBody>
        </Card>
        <nav aria-label="Module content">
          <ol className="grid gap-1">
            {view.blocks.map((b, i) => (
              <li key={b.id}>
                <button type="button" onClick={() => go(i)} aria-current={i === index ? 'step' : undefined} data-testid={`step-${b.id}`}
                  className={cn('flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-[0.8125rem] transition-colors', i === index ? 'bg-accent text-accent-fg' : 'hover:bg-bg-subtle')}>
                  {b.state.done ? <CheckCircle2 className={cn('mt-0.5 size-4 shrink-0', i === index ? '' : 'text-success')} aria-label="Done" /> : <Circle className="mt-0.5 size-4 shrink-0 opacity-60" aria-label="Not done" />}
                  <span className="grid">
                    <span className="font-medium">{b.title}</span>
                    <span className={cn('text-xs', i === index ? 'opacity-80' : 'text-fg-subtle')}>{BLOCK_LABEL[b.kind]}{b.required ? '' : ' · optional'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </aside>
      <div className="grid content-start gap-4">
        {view.status === 'completed' && (
          <Alert tone="success" title={`Completed ${dateLabel(view.completedOn)}${view.scorePercent !== null ? ` with ${view.scorePercent}%` : ''}`}>
            {view.certificateNo ? <Link className="font-medium underline" href={`/learning/my/${view.id}/certificate`} data-testid="certificate-link"><Award className="mr-1 inline size-4" aria-hidden />View your certificate ({view.certificateNo})</Link> : 'Your completion is on your learning record.'}
          </Alert>
        )}
        {view.status === 'cancelled' && <Alert tone="warning">This learning was removed from your list. You can still look through it.</Alert>}
        {view.classroom && open && <Alert tone="info">This is classroom training. HR or your manager confirms your attendance.</Alert>}
        <Card>
          <CardHeader title={block.title} description={`Step ${index + 1} of ${view.blocks.length} · ${BLOCK_LABEL[block.kind]}`} action={block.state.done ? <Badge tone="success" dot>Done</Badge> : undefined} />
          <CardBody className="grid gap-4">
            {block.description && <p className="whitespace-pre-line text-[0.8125rem] text-fg-muted">{block.description}</p>}
            {block.kind === 'quiz' ? <QuizRunner key={block.id} enrolmentId={view.id} block={block} open={open} onView={onView} />
              : block.kind === 'assignment' ? <AssignmentPanel key={block.id} enrolmentId={view.id} block={block} open={open} onView={onView} />
              : <Content key={block.id} block={block} report={report} open={open} />}
            {error && <Alert tone="danger">{error}</Alert>}
            {manual && (
              <Button className="w-fit" variant="secondary" loading={pending} data-testid="mark-complete" onClick={() => start(async () => {
                const msg = await report(block, { action: 'complete', seconds: Math.min(600, Math.round((Date.now() - shownAt.current) / 1000)) });
                setError(msg);
                if (!msg && index < view.blocks.length - 1) go(index + 1);
              })}>
                <CheckCircle2 className="size-4" aria-hidden />Mark as complete
              </Button>
            )}
            {!open && view.status !== 'completed' && view.status !== 'cancelled' && <p className="flex items-center gap-1 text-xs text-fg-subtle"><Lock className="size-3" aria-hidden />Read only</p>}
          </CardBody>
        </Card>
        <div className="flex justify-between gap-2">
          <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft className="size-4" aria-hidden />Previous</Button>
          <Button variant="secondary" size="sm" disabled={index >= view.blocks.length - 1} onClick={() => go(index + 1)} data-testid="next-step">Next<ChevronRight className="size-4" aria-hidden /></Button>
        </div>
      </div>
    </div>
  );
}

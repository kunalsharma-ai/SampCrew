'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Textarea } from '@crew/ui';
import { ClipboardCheck, Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { gradeAttemptAction, reviewSubmissionAction } from '../../actions';
import { dateLabel, SubmissionBadge } from '../../labels';
import type { PendingAttempt, ReviewSubmission } from '../../types';

function SubmissionCard({ s, reviewing }: { s: ReviewSubmission; reviewing: boolean }) {
  const { pending, notice, run } = useRunner();
  const [score, setScore] = useState(s.score === null ? '' : String(s.score));
  const [feedback, setFeedback] = useState('');
  const set = s.settings;
  const scored = set?.gradingMethod !== 'pass_fail';
  const decide = (decision: 'approved' | 'rejected' | 'resubmit') => run(() => reviewSubmissionAction(s.id, decision, decision === 'resubmit' || !scored || score === '' ? null : Number(score), feedback.trim()));
  return (
    <Card data-testid="submission-card">
      <CardHeader title={`${s.employeeName} · ${s.assignmentTitle}`} description={`${s.moduleTitle} · ${s.hrWorkspace}${s.department ? ` · ${s.department}` : ''} · submitted ${dateLabel(s.submittedAt)}`} action={<SubmissionBadge status={s.status} />} />
      <CardBody className="grid gap-3 text-[0.8125rem]">
        {set?.instructions && <details><summary className="cursor-pointer text-xs text-fg-muted">Instructions</summary><p className="mt-1 whitespace-pre-line text-fg-muted">{set.instructions}</p></details>}
        {s.text && <p className="whitespace-pre-line rounded-md bg-bg-subtle p-3">{s.text}</p>}
        {s.link && <a href={s.link} target="_blank" rel="noreferrer noopener" className="text-accent underline">{s.link}</a>}
        {s.fileIds.length > 0 && <div className="flex flex-wrap gap-2">{s.fileIds.map((f, i) => <a key={f} href={`/learning-files/${f}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent underline"><Paperclip className="size-3" aria-hidden />File {i + 1}</a>)}</div>}
        {!reviewing && (s.feedback || s.score !== null) && <p className="text-xs text-fg-muted">{s.score !== null ? `Score ${s.score}${set ? `/${set.maxScore}` : ''}. ` : ''}{s.feedback}{s.reviewer ? ` (${s.reviewer}, ${dateLabel(s.reviewedAt)})` : ''}</p>}
        <Link href={`/learning/manage/enrolments/${s.enrolmentId}`} className="w-fit text-xs text-accent underline">See their progress in the module</Link>
        {reviewing && s.status === 'submitted' && (
          <div className="grid gap-3 border-t border-border pt-3">
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              {scored && <Field label={`Score out of ${set?.maxScore ?? 100}`} hint={`Passing score ${set?.passScore ?? 0}`}>{(p) => <Input {...p} type="number" min={0} max={set?.maxScore ?? 1000} value={score} onChange={(e) => setScore(e.target.value)} data-testid="review-score" />}</Field>}
              <Field label="Feedback" hint="Required when you do not approve">{(p) => <Textarea {...p} rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} data-testid="review-feedback" />}</Field>
            </div>
            {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" loading={pending} onClick={() => decide('approved')} data-testid="review-approve">Approve</Button>
              <Button size="sm" variant="secondary" loading={pending} onClick={() => decide('resubmit')} data-testid="review-resubmit">Ask to resubmit</Button>
              <Button size="sm" variant="danger" loading={pending} onClick={() => decide('rejected')}>Not passed</Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function SubmissionReviews({ items, reviewing }: { items: ReviewSubmission[]; reviewing: boolean }) {
  if (!items.length) return <EmptyState icon={<ClipboardCheck className="size-5" />} title={reviewing ? 'Nothing to review' : 'Nothing here'} description={reviewing ? 'Assignments people submit show here, oldest first.' : undefined} />;
  return <div className="grid gap-4">{items.map((s) => <SubmissionCard key={s.id} s={s} reviewing={reviewing} />)}</div>;
}

function AttemptCard({ a }: { a: PendingAttempt }) {
  const { pending, notice, run } = useRunner();
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const complete = a.questions.every((q) => marks[q.id] !== undefined && marks[q.id] !== '');
  return (
    <Card data-testid="attempt-card">
      <CardHeader title={`${a.employeeName} · ${a.quizTitle}`} description={`${a.moduleTitle} · ${a.hrWorkspace} · attempt ${a.attemptNo} · submitted ${dateLabel(a.submittedAt)}`} action={<Badge tone="info">Waiting for marks</Badge>} />
      <CardBody className="grid gap-3 text-[0.8125rem]">
        {a.questions.map((q) => (
          <div key={q.id} className="grid gap-2 rounded-lg border border-border p-3">
            <p className="font-medium">{q.text}</p>
            <p className="whitespace-pre-line rounded-md bg-bg-subtle p-2">{q.answer || <span className="text-fg-subtle">No answer</span>}</p>
            <Field label={`Marks (out of ${q.marks})`} className="max-max-w-40">{(p) => <Input {...p} type="number" min={0} max={q.marks} step={0.5} value={marks[q.id] ?? ''} onChange={(e) => setMarks({ ...marks, [q.id]: e.target.value })} />}</Field>
          </div>
        ))}
        <Field label="Feedback" hint="Optional">{(p) => <Textarea {...p} rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />}</Field>
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <Button size="sm" className="w-fit" loading={pending} disabled={!complete} onClick={() => run(() => gradeAttemptAction(a.id, Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Number(v)])), feedback.trim()))}>Save marks</Button>
      </CardBody>
    </Card>
  );
}

export function AttemptReviews({ attempts }: { attempts: PendingAttempt[] }) {
  if (!attempts.length) return <EmptyState icon={<ClipboardCheck className="size-5" />} title="No written answers to mark" description="Short and long quiz answers wait here until someone marks them." />;
  return <div className="grid gap-4">{attempts.map((a) => <AttemptCard key={a.id} a={a} />)}</div>;
}

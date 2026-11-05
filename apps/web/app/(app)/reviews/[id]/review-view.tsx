'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Select, Textarea } from '@crew/ui';
import { Search, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import {
  acknowledgeAction, calibrateAction, excludeAction, requestFeedbackAction, searchColleaguesAction, withdrawFeedbackAction, writeReviewAction,
} from '../../talent/actions';
import { CYCLE_STATUS, CYCLE_TONE, dateTime, FEEDBACK_STATUS, FEEDBACK_TONE, GOAL_STATUS, ratingLabel } from '../../talent/labels';
import { Progress } from '../../talent/progress';
import type { Colleague, Level, Question, ReviewDetail } from '../../talent/types';

function Answers({ questions, answers, rating, scale }: { questions: Question[]; answers: Record<string, string>; rating: number | null; scale: Level[] }) {
  return (
    <dl className="grid gap-3 text-[13px]">
      {questions.map((q) => (
        <div key={q.id}>
          <dt className="text-xs text-fg-muted">{q.text}</dt>
          <dd className="whitespace-pre-wrap">{answers[q.id] || <span className="text-fg-subtle">No answer</span>}</dd>
        </div>
      ))}
      <div>
        <dt className="text-xs text-fg-muted">Rating</dt>
        <dd className="font-medium">{ratingLabel(scale, rating)}</dd>
      </div>
    </dl>
  );
}

function WriteForm({ review, part }: { review: ReviewDetail; part: 'self' | 'manager' }) {
  const { pending, notice, run } = useRunner();
  const initial = part === 'self' ? review.selfAnswers : review.managerAnswers;
  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  const [rating, setRating] = useState<string>(String((part === 'self' ? review.selfRating : review.managerRating) ?? ''));
  const send = (submit: boolean) => run(() => writeReviewAction(review.id, part, { answers, rating: rating ? Number(rating) : null, submit }));
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (confirm('Submit? You cannot change it afterwards.')) send(true); }}>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {review.cycle.questions.map((q) => (
        <Field key={q.id} label={q.text}>
          {(p) => <Textarea {...p} name={`q_${q.id}`} rows={3} value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />}
        </Field>
      ))}
      <Field label={part === 'self' ? 'How would you rate your performance?' : 'Your rating'}>
        {(p) => (
          <Select {...p} name="rating" value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="">Choose a rating</option>
            {review.cycle.ratingScale.map((l) => <option key={l.value} value={l.value}>{l.value} · {l.label}</option>)}
          </Select>
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" loading={pending} onClick={() => send(false)}>Save draft</Button>
        <Button type="submit" loading={pending}>Submit {part === 'self' ? 'self review' : 'manager review'}</Button>
      </div>
      <p className="text-xs text-fg-muted">{part === 'self' ? 'Drafts are private to you. Your manager sees your self review once you submit it.' : 'Drafts are private to you. The person sees your review only after HR releases results.'}</p>
    </form>
  );
}

function RequestFeedback({ review }: { review: ReviewDetail }) {
  const { pending, notice, run } = useRunner();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Colleague[]>([]);
  const [picked, setPicked] = useState<Colleague[]>([]);
  const [searching, startSearch] = useTransition();
  const excluded = new Set([review.employeeId, review.managerEmployeeId]);
  return (
    <>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><UserPlus className="size-3.5" /> Ask colleagues</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Ask for feedback on ${review.employeeName}`}
        description="Colleagues answer two short questions. Their names are shown to you and HR, never to the person."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={pending} disabled={!picked.length} onClick={() => run(() => requestFeedbackAction(review.id, picked.map((p) => p.id)), () => { setOpen(false); setPicked([]); })}>
              Send {picked.length || ''} request{picked.length === 1 ? '' : 's'}
            </Button>
          </>
        }
      >
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); startSearch(async () => { const r = await searchColleaguesAction(q); if (r.ok) setResults(r.data ?? []); }); }}>
          <Input aria-label="Search colleagues" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" />
          <Button type="submit" variant="secondary" loading={searching}><Search className="size-3.5" /> Search</Button>
        </form>
        <ul className="mt-3 grid max-h-60 gap-1 overflow-auto">
          {results.filter((c) => !excluded.has(c.id)).map((c) => {
            const on = picked.some((p) => p.id === c.id);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-bg-subtle">
                  <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((p) => p.id !== c.id) : [...picked, c])} />
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-fg-muted">{c.departmentName}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {picked.length > 0 && <p className="mt-2 text-xs text-fg-muted">Selected: {picked.map((p) => p.name).join(', ')}</p>}
      </Dialog>
    </>
  );
}

export function ReviewView({ review }: { review: ReviewDetail }) {
  const { pending, notice, run } = useRunner();
  const [comment, setComment] = useState('');
  const [finalRating, setFinalRating] = useState(String(review.finalRating ?? ''));
  const [reason, setReason] = useState('');
  const scale = review.cycle.ratingScale;
  const stage = review.cycle.status;
  const showSelf = review.cycle.selfReview && (review.can.writeSelf || review.selfStatus === 'submitted' || review.role === 'employee');
  const managerVisible = review.can.writeManager || review.managerStatus === 'submitted' || Object.keys(review.managerAnswers).length > 0;
  const stageNote =
    review.excluded ? `Left out of this cycle: ${review.excludedReason}` :
    stage === 'active' ? (review.role === 'employee' ? 'Your manager’s review and your final rating are shared when HR releases results.' : 'Reviews are being written.') :
    stage === 'calibration' ? 'Writing has closed. HR is calibrating ratings before releasing results.' :
    stage === 'released' ? 'Results are released. Nothing in this review can change now.' : '';

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid content-start gap-6 lg:col-span-2">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        <Alert tone={review.excluded ? 'warning' : 'info'}>
          <span className="mr-2"><Badge tone={CYCLE_TONE[stage] ?? 'neutral'} dot>{CYCLE_STATUS[stage] ?? stage}</Badge></span>
          {stageNote}
        </Alert>

        {review.finalRating != null && (
          <Card>
            <CardHeader title="Final rating" description={review.role === 'hr' && stage === 'calibration' ? 'Starts as the manager’s rating; change it here with a reason.' : undefined} />
            <CardBody className="grid gap-3">
              <div className="text-lg font-semibold">{ratingLabel(scale, review.finalRating)}</div>
              {review.calibrations.length > 0 && (
                <ul className="grid gap-1 text-xs text-fg-muted">
                  {review.calibrations.map((c, i) => (
                    <li key={i}>{dateTime(c.createdAt)} · {c.byName} changed {c.fromRating ?? '–'} → {c.toRating}: {c.reason}</li>
                  ))}
                </ul>
              )}
              {review.can.calibrate && (
                <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); run(() => calibrateAction(review.id, review.cycle.id, Number(finalRating), reason), () => setReason('')); }}>
                  <Field label="New final rating">
                    {(p) => <Select {...p} value={finalRating} onChange={(e) => setFinalRating(e.target.value)}>{scale.map((l) => <option key={l.value} value={l.value}>{l.value} · {l.label}</option>)}</Select>}
                  </Field>
                  <Field label="Reason (kept in the history)" className="sm:col-span-2">{(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} />}</Field>
                  <div className="sm:col-span-3"><Button type="submit" size="sm" loading={pending}>Change final rating</Button></div>
                </form>
              )}
            </CardBody>
          </Card>
        )}

        {showSelf && (
          <Card>
            <CardHeader title="Self review" description={review.selfSubmittedAt ? `Submitted ${dateTime(review.selfSubmittedAt)}` : review.role === 'employee' ? undefined : 'Not submitted yet'} />
            <CardBody>
              {review.can.writeSelf ? <WriteForm review={review} part="self" /> : <Answers questions={review.cycle.questions} answers={review.selfAnswers} rating={review.selfRating} scale={scale} />}
            </CardBody>
          </Card>
        )}

        {(managerVisible || review.role !== 'employee') && (
          <Card>
            <CardHeader title="Manager review" description={review.managerSubmittedAt ? `Submitted ${dateTime(review.managerSubmittedAt)}${review.managerName ? ` by ${review.managerName}` : ''}` : review.managerName ? `To be written by ${review.managerName}` : 'No reviewing manager: HR writes this review'} />
            <CardBody>
              {review.can.writeManager ? <WriteForm review={review} part="manager" />
                : managerVisible ? <Answers questions={review.cycle.questions} answers={review.managerAnswers} rating={review.managerRating} scale={scale} />
                : <p className="text-[13px] text-fg-muted">Not submitted yet.</p>}
            </CardBody>
          </Card>
        )}

        {review.cycle.peerFeedback && (
          <Card>
            <CardHeader title="Peer feedback" action={review.can.requestFeedback ? <RequestFeedback review={review} /> : undefined} />
            <CardBody className="grid gap-3 text-[13px]">
              {'reason' in review.peer && <p className="text-fg-muted">{review.peer.reason}</p>}
              {'answers' in review.peer && review.peer.answers.map((q) => (
                <div key={q.id}>
                  <div className="text-xs text-fg-muted">{q.text}</div>
                  <ul className="mt-1 grid list-disc gap-1 pl-5">{q.comments.map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              ))}
              {'answers' in review.peer && <p className="text-xs text-fg-muted">Shared without names, in alphabetical order.</p>}
              {'requests' in review.peer && (review.peer.requests.length ? review.peer.requests.map((f) => (
                <div key={f.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{f.reviewerName}</span>
                    <Badge tone={FEEDBACK_TONE[f.status] ?? 'neutral'} dot>{FEEDBACK_STATUS[f.status] ?? f.status}</Badge>
                    {f.status === 'requested' && review.can.requestFeedback && (
                      <Button className="ml-auto" size="sm" variant="ghost" loading={pending} onClick={() => run(() => withdrawFeedbackAction(review.id, f.id))}>Withdraw</Button>
                    )}
                  </div>
                  {f.status === 'submitted' && review.peerQuestions.map((q) => (
                    <div key={q.id} className="mt-2">
                      <div className="text-xs text-fg-muted">{q.text}</div>
                      <div className="whitespace-pre-wrap">{f.answers[q.id]}</div>
                    </div>
                  ))}
                </div>
              )) : <p className="text-fg-muted">No feedback requested yet.</p>)}
            </CardBody>
          </Card>
        )}

        {review.can.acknowledge && (
          <Card>
            <CardHeader title="Acknowledge" description="Confirm you have read your review. You can add a comment for your manager and HR." />
            <CardBody>
              <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(() => acknowledgeAction(review.id, comment)); }}>
                <Textarea aria-label="Comment" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional comment" />
                <div><Button type="submit" loading={pending}>Acknowledge review</Button></div>
              </form>
            </CardBody>
          </Card>
        )}
        {review.acknowledgedAt && (
          <Alert tone="success">Acknowledged {dateTime(review.acknowledgedAt)}{review.employeeComment ? `: “${review.employeeComment}”` : '.'}</Alert>
        )}
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader title="Goals in this period" />
          <CardBody className="grid gap-3 text-[13px]">
            {review.goals.length ? review.goals.map((g) => (
              <div key={g.id}>
                <Link className="font-medium text-accent hover:underline" href={`/goals/${g.id}`}>{g.title}</Link>
                <div className="text-xs text-fg-muted">{GOAL_STATUS[g.status]}{g.weight ? ` · weight ${g.weight}%` : ''}</div>
                <Progress value={g.progress} />
              </div>
            )) : <p className="text-fg-muted">No goals overlap this period.</p>}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Rating scale" />
          <CardBody>
            <ol className="grid gap-1 text-[13px]">{scale.map((l) => <li key={l.value}><span className="font-medium tabular-nums">{l.value}</span> · {l.label}</li>)}</ol>
          </CardBody>
        </Card>
        {review.can.exclude && (
          <Card>
            <CardHeader title="Leave out of this cycle" description="For example a long leave or a recent joiner. Their review is kept but not rated." />
            <CardBody>
              <Button size="sm" variant="secondary" loading={pending} onClick={() => { const why = prompt('Reason for leaving this person out (kept in the audit trail):'); if (why) run(() => excludeAction(review.id, review.cycle.id, why)); }}>Leave out</Button>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

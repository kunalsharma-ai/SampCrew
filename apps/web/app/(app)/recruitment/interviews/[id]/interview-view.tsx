'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Select, Textarea } from '@crew/ui';
import { FileText } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import type { Feedback, InterviewDetail } from '@/lib/types';
import { cancelInterviewAction, feedbackAction } from '../../actions';
import { RECOMMENDATION, when } from '../../labels';
import { useRunner } from '../../use-runner';

const SCORE = ['', '1 · Well below the bar', '2 · Below the bar', '3 · Meets the bar', '4 · Well above the bar'];

export function InterviewView({ d }: { d: InterviewDetail }) {
  const { pending, notice, run } = useRunner();
  const i = d.interview;
  const started = Date.parse(i.startsAt) <= Date.now();
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="grid content-start gap-6">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {i.status === 'cancelled' && <Alert tone="warning" title="Cancelled">{i.cancelReason}</Alert>}
        {d.can.feedback && i.status !== 'cancelled' && (started
          ? <ScorecardForm criteria={i.scorecard} pending={pending} onSubmit={(body) => run(() => feedbackAction(i.id, body))} />
          : <Alert tone="info" title="Scorecard opens when the interview starts">Come back after the interview to rate the candidate on each criterion.</Alert>)}
        {d.myFeedback && <FeedbackCard f={d.myFeedback} mine />}
        {d.othersHidden && <Alert tone="info">Other interviewers have submitted. You will see their scorecards after you submit yours, so first impressions stay independent.</Alert>}
        {d.otherFeedback.map((f) => <FeedbackCard key={f.id} f={f} />)}
        {!d.myFeedback && !d.otherFeedback.length && !d.can.feedback && !d.othersHidden && <Card><CardBody className="text-[0.8125rem] text-fg-muted">No scorecards yet.</CardBody></Card>}
        {i.jobDescription && (
          <Card>
            <CardHeader title="About the role" />
            <CardBody className="whitespace-pre-wrap text-[0.8125rem]">{i.jobDescription}</CardBody>
          </Card>
        )}
      </div>
      <div className="grid content-start gap-6">
        <Card>
          <CardHeader title="Details" />
          <CardBody className="grid gap-2 text-[0.8125rem]">
            <div>
              <div className="text-fg-muted">Candidate</div>
              {d.can.manage ? <Link className="text-accent hover:underline" href={`/recruitment/candidates/${i.candidateId}`}>{i.candidateName}</Link> : i.candidateName}
              {(i.currentTitle || i.currentCompany) && <div className="text-fg-muted">{[i.currentTitle, i.currentCompany].filter(Boolean).join(' at ')}</div>}
            </div>
            {i.meetingUrl && <div><div className="text-fg-muted">Meeting link</div><a className="break-all text-accent hover:underline" href={i.meetingUrl} target="_blank" rel="noreferrer noopener">{i.meetingUrl}</a></div>}
            {i.locationText && <div><div className="text-fg-muted">Where</div>{i.locationText}</div>}
            {i.profileUrl && <div><div className="text-fg-muted">Profile</div><a className="break-all text-accent hover:underline" href={i.profileUrl} target="_blank" rel="noreferrer noopener">{i.profileUrl}</a></div>}
            <div>
              <div className="text-fg-muted">Panel</div>
              <div className="mt-1 flex flex-wrap gap-1">{d.panel.map((p) => <Badge key={p.membershipId} tone={p.submitted ? 'success' : 'neutral'}>{p.name}{p.submitted ? ' ✓' : ''}</Badge>)}</div>
            </div>
            {d.files.map((f) => <a key={f.id} className="flex items-center gap-2 text-accent hover:underline" href={`/recruitment-files/${f.id}`}><FileText className="size-4" />{f.fileName}</a>)}
          </CardBody>
        </Card>
        {d.can.manage && i.status === 'scheduled' && (
          <Button variant="ghost" loading={pending} onClick={() => {
            const r = prompt('Why is this interview cancelled? The panel is told.');
            if (r && r.trim().length >= 3) run(() => cancelInterviewAction(i.id, r.trim()));
          }}>Cancel interview</Button>
        )}
      </div>
    </div>
  );
}

function ScorecardForm({ criteria, pending, onSubmit }: { criteria: string[]; pending: boolean; onSubmit: (body: { ratings: { criterion: string; score: number; note?: string }[]; recommendation: string; summary: string }) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Your scorecard" description="Rate each criterion on its own evidence. You can submit once; you cannot see other scorecards until yours is in." />
      <CardBody>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const ratings = criteria.map((criterion, idx) => ({ criterion, score: Number(f.get(`score-${idx}`)), note: String(f.get(`note-${idx}`) ?? '').trim() || undefined }));
            if (ratings.some((r) => !r.score)) return setError('Rate every criterion');
            const summary = String(f.get('summary') ?? '').trim();
            if (summary.length < 10) return setError('Write at least a sentence on why');
            setError(null);
            if (confirm('Submit your scorecard? You cannot change it afterwards.')) onSubmit({ ratings, recommendation: String(f.get('recommendation')), summary });
          }}
        >
          {error && <Alert tone="danger">{error}</Alert>}
          {criteria.map((c, idx) => (
            <div key={c} className="grid gap-2 sm:grid-cols-[1fr_1.4fr]">
              <Field label={c} required>{(p) => <Select {...p} name={`score-${idx}`} required defaultValue="">{SCORE.map((s, n) => <option key={n} value={n ? String(n) : ''}>{s || 'Choose a rating'}</option>)}</Select>}</Field>
              <Field label="Evidence">{(p) => <Textarea {...p} name={`note-${idx}`} rows={1} placeholder="What did you see or hear?" />}</Field>
            </div>
          ))}
          <Field label="Recommendation" required>
            {(p) => <Select {...p} name="recommendation" required defaultValue="">{[['', 'Choose'], ...Object.entries(RECOMMENDATION)].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
          </Field>
          <Field label="Summary" required hint="Why you recommend this">{(p) => <Textarea {...p} name="summary" rows={3} required />}</Field>
          <div><Button type="submit" loading={pending}>Submit scorecard</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}

function FeedbackCard({ f, mine }: { f: Feedback; mine?: boolean }) {
  const avg = f.ratings.reduce((s, r) => s + r.score, 0) / f.ratings.length;
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2">{mine ? 'Your scorecard' : f.interviewerName}<Badge tone={f.recommendation.endsWith('yes') ? 'success' : 'danger'}>{RECOMMENDATION[f.recommendation]}</Badge></span>}
        description={`Submitted ${when(f.submittedAt)} · average ${avg.toFixed(2)} out of 4`}
      />
      <CardBody className="grid gap-2 text-[0.8125rem]">
        {f.ratings.map((r) => (
          <div key={r.criterion} className="flex gap-3">
            <span className="w-40 shrink-0 text-fg-muted">{r.criterion}</span>
            <span className="font-medium tabular-nums">{r.score}/4</span>
            {r.note && <span className="text-fg-muted">{r.note}</span>}
          </div>
        ))}
        <p className="mt-1 whitespace-pre-wrap">{f.summary}</p>
      </CardBody>
    </Card>
  );
}

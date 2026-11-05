'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Department, LegalEntity } from '@/lib/types';
import { useRunner } from '../../../recruitment/use-runner';
import { deleteSurveyAction, surveyStepAction } from '../../../talent/actions';
import { QUESTION_KIND, SCALE_LABELS, SURVEY_STATUS, SURVEY_TONE } from '../../../talent/labels';
import type { QuestionResult, SurveyDetail, SurveyResults } from '../../../talent/types';
import { SurveyDialog } from '../survey-dialog';

function QuestionCard({ q }: { q: QuestionResult }) {
  const max = Math.max(1, ...(q.distribution?.map((d) => d.count) ?? [1]));
  return (
    <Card>
      <CardHeader
        title={q.text}
        description={`${QUESTION_KIND[q.kind]} · ${q.answered} answer${q.answered === 1 ? '' : 's'}`}
        action={q.kind === 'enps' ? <Badge tone={(q.enps ?? 0) >= 0 ? 'success' : 'danger'}>eNPS {q.enps ?? '–'}</Badge> : q.kind === 'scale' ? <Badge tone="info">Average {q.average ?? '–'}</Badge> : undefined}
      />
      <CardBody>
        {q.kind === 'text' ? (
          q.comments?.length ? <ul className="grid list-disc gap-1 pl-5 text-[0.8125rem]">{q.comments.map((c, i) => <li key={i}>{c}</li>)}</ul> : <p className="text-[0.8125rem] text-fg-muted">No comments.</p>
        ) : (
          <div className="grid gap-1.5">
            {q.distribution?.map((d) => (
              <div key={d.value} className="grid grid-cols-[minmax(0,9rem)_1fr_2.5rem] items-center gap-2 text-xs">
                <span className="truncate text-fg-muted">{q.kind === 'scale' ? `${d.value} · ${SCALE_LABELS[d.value - 1]}` : d.value}</span>
                <div className="h-2 rounded-full bg-bg-subtle"><div className={`h-full rounded-full ${q.kind === 'enps' ? (d.value >= 9 ? 'bg-success' : d.value <= 6 ? 'bg-danger' : 'bg-warning') : 'bg-accent'}`} style={{ width: `${(d.count / max) * 100}%` }} /></div>
                <span className="text-right tabular-nums">{d.count}</span>
              </div>
            ))}
            {q.kind === 'enps' && <p className="mt-1 text-xs text-fg-muted">eNPS is the percentage answering 9 or 10, minus the percentage answering 0 to 6.</p>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function SurveyAdminView({ survey, results, entities, departments }: { survey: SurveyDetail; results: SurveyResults | null; entities: LegalEntity[]; departments: Department[] }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [edit, setEdit] = useState(false);
  const scoreQuestions = survey.questions.filter((q) => q.kind !== 'text');
  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2">Status <Badge tone={SURVEY_TONE[survey.status]} dot>{SURVEY_STATUS[survey.status]}</Badge></span>}
          description={`Anonymity threshold: ${survey.minResponses} answers${survey.closesOn ? ` · closes ${survey.closesOn}` : ''}`}
          action={
            <div className="flex flex-wrap gap-2">
              {survey.status === 'draft' && (
                <>
                  <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Delete this draft?') && run(() => deleteSurveyAction(survey.id), () => router.push('/surveys/manage'))}>Delete</Button>
                  <Button size="sm" variant="secondary" onClick={() => setEdit(true)}>Edit</Button>
                  <Button size="sm" loading={pending} onClick={() => confirm('Open the survey? Everyone in its audience is invited and the questions can no longer change.') && run(() => surveyStepAction(survey.id, 'open'))}>Open survey</Button>
                </>
              )}
              {survey.status === 'open' && <Button size="sm" variant="secondary" loading={pending} onClick={() => confirm('Close the survey? No more answers will be accepted.') && run(() => surveyStepAction(survey.id, 'close'))}>Close survey</Button>}
            </div>
          }
        />
        {results && (
          <CardBody className="grid gap-4 sm:grid-cols-3">
            <Stat label="Invited" value={results.invited} />
            <Stat label="Answered" value={results.responded} hint={results.invited ? `${Math.round((results.responded / results.invited) * 100)}% response rate` : undefined} />
            <Stat label="Threshold" value={results.minResponses} hint="Answers needed before results show" />
          </CardBody>
        )}
      </Card>

      {survey.status === 'draft' && (
        <Card>
          <CardHeader title="Questions" />
          <ol className="divide-y divide-border">
            {survey.questions.map((q, i) => <li key={q.id} className="px-5 py-2.5 text-[0.8125rem]">{i + 1}. {q.text} <span className="text-xs text-fg-muted">· {QUESTION_KIND[q.kind]}</span></li>)}
          </ol>
        </Card>
      )}

      {results && <Alert tone="info">{results.notice}</Alert>}
      {results && !results.shown && <Alert tone="warning" title="Results withheld">{results.reason}. They appear once {results.minResponses} people have answered.</Alert>}
      {results?.shown && (
        <>
          {results.questions.map((q) => <QuestionCard key={q.id} q={q} />)}
          <Card>
            <CardHeader title="By department" description="Groups smaller than the threshold are merged into “Other groups”, or the breakdown is withheld when a small group could be worked out." />
            {results.breakdown.shown ? (
              <Table>
                <THead><tr><TH>Group</TH><TH className="text-right">Answers</TH>{scoreQuestions.map((q) => <TH key={q.id} className="text-right" title={q.text}>{q.kind === 'enps' ? 'eNPS' : q.text.length > 24 ? `${q.text.slice(0, 22)}…` : q.text}</TH>)}</tr></THead>
                <TBody>
                  {results.breakdown.groups.map((g) => (
                    <TR key={g.label}>
                      <TD className="font-medium">{g.label}</TD>
                      <TD className="text-right tabular-nums">{g.count}</TD>
                      {scoreQuestions.map((q) => {
                        const x = g.questions.find((y) => y.id === q.id);
                        return <TD key={q.id} className="text-right tabular-nums">{q.kind === 'enps' ? x?.enps ?? '–' : x?.average ?? '–'}</TD>;
                      })}
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <CardBody><p className="text-[0.8125rem] text-fg-muted">{results.breakdown.reason}.</p></CardBody>
            )}
          </Card>
        </>
      )}
      {survey.status === 'draft' && <SurveyDialog open={edit} onClose={() => setEdit(false)} entities={entities} departments={departments} survey={survey} />}
    </div>
  );
}

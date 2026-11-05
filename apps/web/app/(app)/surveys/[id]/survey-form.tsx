'use client';
import { Alert, Button, Card, CardBody, Textarea } from '@crew/ui';
import { ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { respondAction } from '../../talent/actions';
import { SCALE_LABELS } from '../../talent/labels';
import type { SurveyForm } from '../../talent/types';

export function SurveyFormView({ form }: { form: SurveyForm }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [answers, setAnswers] = useState<Record<string, number | string | null>>({});
  if (form.responded) return <Alert tone="success">You have answered this survey. Thank you.</Alert>;
  if (form.status !== 'open') return <Alert tone="info">This survey is closed.</Alert>;
  return (
    <form className="grid max-w-3xl gap-4" onSubmit={(e) => { e.preventDefault(); run(() => respondAction(form.id, answers), () => router.push('/surveys')); }}>
      <Alert tone="info"><span className="inline-flex items-start gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0" />{form.notice}</span></Alert>
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {form.questions.map((q, i) => (
        <Card key={q.id}>
          <CardBody className="grid gap-3">
            <div className="text-[0.8125rem] font-medium">{i + 1}. {q.text}{q.kind !== 'text' && <span className="text-danger"> *</span>}</div>
            {q.kind === 'text' ? (
              <Textarea aria-label={q.text} rows={3} maxLength={2000} value={String(answers[q.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} placeholder="Optional. Avoid details that identify you if you want to stay anonymous." />
            ) : (
              <div role="radiogroup" aria-label={q.text} className="flex flex-wrap gap-1.5">
                {Array.from({ length: q.kind === 'enps' ? 11 : 5 }, (_, k) => (q.kind === 'enps' ? k : k + 1)).map((v) => (
                  <label key={v} className={`cursor-pointer rounded-md border px-3 py-1.5 text-[0.8125rem] ${answers[q.id] === v ? 'border-accent bg-accent text-accent-fg' : 'border-border hover:bg-bg-subtle'}`}>
                    <input type="radio" className="sr-only" name={q.id} value={v} checked={answers[q.id] === v} onChange={() => setAnswers({ ...answers, [q.id]: v })} />
                    {q.kind === 'scale' ? `${v} · ${SCALE_LABELS[v - 1]}` : v}
                  </label>
                ))}
                {q.kind === 'enps' && <div className="w-full text-xs text-fg-muted">0 means not at all likely, 10 means extremely likely.</div>}
              </div>
            )}
          </CardBody>
        </Card>
      ))}
      <div><Button type="submit" loading={pending}>Send answers</Button></div>
    </form>
  );
}

'use client';
import { Alert, Button, Card, CardBody, CardHeader, Field, Textarea } from '@crew/ui';
import { useState } from 'react';
import { useRunner } from '../../../recruitment/use-runner';
import { declineFeedbackAction, writeFeedbackAction } from '../../../talent/actions';
import { FEEDBACK_STATUS } from '../../../talent/labels';
import type { FeedbackForm } from '../../../talent/types';

export function FeedbackView({ form }: { form: FeedbackForm }) {
  const { pending, notice, run } = useRunner();
  const [answers, setAnswers] = useState<Record<string, string>>(form.answers);
  return (
    <div className="grid max-w-2xl gap-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Alert tone="info">{form.notice}</Alert>
      <Card>
        <CardHeader title={form.can.write ? 'Your feedback' : FEEDBACK_STATUS[form.status] ?? form.status} />
        <CardBody>
          <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); run(() => writeFeedbackAction(form.id, answers, true)); }}>
            {form.questions.map((q) => (
              <Field key={q.id} label={q.text}>
                {(p) => <Textarea {...p} name={q.id} rows={4} disabled={!form.can.write} value={answers[q.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />}
              </Field>
            ))}
            {form.can.write && (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" loading={pending} onClick={() => run(() => writeFeedbackAction(form.id, answers, false))}>Save draft</Button>
                <Button type="submit" loading={pending}>Send feedback</Button>
                <Button type="button" variant="ghost" loading={pending} onClick={() => confirm('Decline this request?') && run(() => declineFeedbackAction(form.id))}>Decline</Button>
              </div>
            )}
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

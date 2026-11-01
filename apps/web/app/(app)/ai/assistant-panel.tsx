'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Textarea } from '@crew/ui';
import { Sparkles } from 'lucide-react';
import { useState, useTransition } from 'react';
import { articleAction } from '../helpdesk/actions';
import type { Article } from '../helpdesk/types';
import { aiFeedbackAction, askAssistantAction } from './actions';
import type { AssistantAnswer } from './types';

/** The HR assistant on the Ask HR page. It answers only from published help articles and shows which ones. */
export function AssistantPanel() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<boolean | null>(null);
  const [reading, setReading] = useState<Article | null>(null);
  const [pending, start] = useTransition();
  const q = question.trim();

  const ask = () =>
    start(async () => {
      setError(null);
      setFeedback(null);
      const r = await askAssistantAction(q);
      if (r.ok) setAnswer(r.data!);
      else { setAnswer(null); setError(r.message); }
    });
  const rate = (helpful: boolean) =>
    start(async () => {
      const r = await aiFeedbackAction(answer!.interactionId, helpful);
      if (r.ok) setFeedback(helpful);
    });
  const open = async (id: string) => {
    const r = await articleAction(id);
    if (r.ok && r.data) setReading(r.data);
  };

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Sparkles className="size-4 text-accent" />Ask the HR assistant</span>}
        description="Quick answers from your company's help articles. For anything about your own pay, leave or situation, ask HR below."
      />
      <CardBody className="grid gap-3">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (q.length >= 5) ask(); }}>
          <Field label="Question for the assistant">
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="For example: how is provident fund worked out?" />}
          </Field>
          <div><Button type="submit" loading={pending} disabled={q.length < 5}>Ask the assistant</Button></div>
        </form>
        {error && <Alert tone="danger">{error}</Alert>}
        {answer && (
          <div className="grid gap-3 rounded-lg border border-accent/20 bg-accent-subtle/30 px-4 py-3" data-testid="assistant-answer">
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <Badge tone="info">{answer.answered ? 'AI answer' : 'No answer found'}</Badge>
              <span>{answer.answered ? 'Written by AI from the articles below. Check them; HR has the final word.' : 'No AI was used.'}</span>
            </div>
            <div className="whitespace-pre-wrap text-[0.8125rem]">{answer.answer}</div>
            {answer.sources.length > 0 && (
              <div className="text-[0.8125rem]">
                <div className="mb-1 font-medium">Sources</div>
                <ol className="list-decimal space-y-0.5 pl-5">
                  {answer.sources.map((s) => (
                    <li key={s.articleId}>
                      <button type="button" className="text-left text-accent hover:underline" onClick={() => open(s.articleId)}>{s.title}</button>
                      {!s.cited && <span className="text-fg-muted"> (given to the assistant, not cited)</span>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {answer.answered && (
              <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
                {feedback === null ? (
                  <>
                    <span className="text-fg-muted">Was this helpful?</span>
                    <Button size="sm" variant="secondary" loading={pending} onClick={() => rate(true)}>Yes</Button>
                    <Button size="sm" variant="secondary" loading={pending} onClick={() => rate(false)}>No</Button>
                  </>
                ) : <span className="text-fg-muted">Thanks for the feedback.</span>}
              </div>
            )}
          </div>
        )}
      </CardBody>
      <Dialog open={reading !== null} onClose={() => setReading(null)} title={reading?.title ?? ''} description={reading?.categoryName ?? undefined} size="lg">
        <div className="whitespace-pre-wrap text-[0.8125rem] leading-relaxed">{reading?.body}</div>
      </Dialog>
    </Card>
  );
}

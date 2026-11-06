'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, Select, Textarea, cn } from '@crew/ui';
import { useState } from 'react';
import { useRunner } from '../../recruitment/use-runner';
import { assignAction, categoryAction, priorityAction, rateAction, replyAction, statusAction } from '../actions';
import { draftReplyAction } from '../../ai/actions';
import type { AiSource } from '../../ai/types';
import { dateTime, HISTORY, MOVE, PRIORITY, PRIORITY_TONE, STATUS, STATUS_MINE, STATUS_TONE, TARGET, TARGET_TONE } from '../labels';
import type { CaseDetail, Category, Handler } from '../types';

export function CaseView({ c, handlers, categories, aiDrafts }: { c: CaseDetail; handlers: Handler[]; categories: Category[]; aiDrafts: boolean }) {
  const { pending, notice, run } = useRunner();
  const [draft, setDraft] = useState<{ id: string; sources: AiSource[] } | null>(null);
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const handler = c.role === 'handler';
  const labels = handler ? STATUS : STATUS_MINE;
  const text = body.trim();

  const move = (status: string) => {
    // Resolving sends the reply box as the answer; reopening can carry a reason.
    const message = status === 'resolved' || status === 'open' ? text || undefined : undefined;
    run(() => statusAction(c.id, status, message), () => setBody(''));
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid content-start gap-6 lg:col-span-2">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {!handler && c.status === 'waiting_on_employee' && <Alert tone="warning">HR is waiting for your reply.</Alert>}
        {!handler && c.status === 'resolved' && <Alert tone="success">HR has marked this as resolved. Confirm it is solved, or reopen it if not. It closes on its own after 7 days.</Alert>}
        <Card>
          <CardHeader title="Conversation" description={c.confidential ? 'Confidential: only you and the named HR handlers can see this case.' : undefined} />
          <CardBody className="grid gap-3">
            <Message author={c.employeeName} at={c.createdAt} body={c.description} />
            {c.messages.map((m) => (
              <Message key={m.id} author={`${m.authorName}${m.fromHr ? ' (HR)' : ''}`} at={m.createdAt} body={m.body} internal={m.internal} hr={m.fromHr} ai={m.aiDrafted} />
            ))}
          </CardBody>
        </Card>

        {c.can.reply && (
          <Card>
            <CardBody>
              <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(() => replyAction(c.id, text, internal, internal ? undefined : draft?.id), () => { setBody(''); setDraft(null); }); }}>
                <Field label={internal ? 'Internal note (HR only)' : handler ? 'Reply to the employee' : 'Your reply'}>
                  {(p) => <Textarea {...p} name="body" rows={4} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />}
                </Field>
                {draft && !internal && (
                  <Alert tone="info" title="AI draft: check and edit it before sending">
                    It is sent as your reply, marked as drafted with AI.{draft.sources.length > 0 && <> Based on: {draft.sources.map((x) => x.title).join(', ')}.</>} Replace anything in [square brackets].
                  </Alert>
                )}
                {c.can.internalNote && <Checkbox label="Internal note" description="Only HR handlers see it; the employee is not notified." checked={internal} onChange={(e) => setInternal(e.target.checked)} />}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={pending} disabled={!text}>{internal ? 'Add note' : 'Send reply'}</Button>
                  {handler && aiDrafts && !c.confidential && !internal && (
                    <Button type="button" variant="secondary" loading={pending} onClick={() => run(() => draftReplyAction(c.id), (d) => { const r = d as { interactionId: string; draft: string; sources: AiSource[] }; setBody(r.draft); setDraft({ id: r.interactionId, sources: r.sources }); })}>
                      Draft a reply with AI
                    </Button>
                  )}
                  {c.moves.map((s) => (
                    <Button key={s} type="button" variant={s === 'resolved' || s === 'closed' ? 'primary' : 'secondary'} loading={pending} disabled={s === 'resolved' && (!text || internal)} onClick={() => move(s)}>
                      {MOVE[s] ?? s}
                    </Button>
                  ))}
                </div>
                {c.moves.includes('resolved') && <p className="text-xs text-fg-muted">To resolve, write the answer above; it is sent to the employee with the resolution.</p>}
              </form>
            </CardBody>
          </Card>
        )}
        {!c.can.reply && c.moves.length > 0 && (
          <div className="flex gap-2">{c.moves.map((s) => <Button key={s} variant="secondary" loading={pending} onClick={() => move(s)}>{MOVE[s] ?? s}</Button>)}</div>
        )}

        {c.can.rate && (
          <Card>
            <CardHeader title="How did HR handle this?" />
            <CardBody>
              <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); run(() => rateAction(c.id, rating, comment.trim())); }}>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} out of 5`} onClick={() => setRating(n)}
                      className={cn('size-9 rounded-full border text-sm font-medium', rating >= n ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-fg-muted')}>{n}</button>
                  ))}
                </div>
                <Field label="Comment (optional)">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
                <Button type="submit" loading={pending} disabled={!rating}>Send rating</Button>
              </form>
            </CardBody>
          </Card>
        )}
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardBody className="grid gap-3 text-[0.8125rem]">
            <Row label="Status"><Badge tone={STATUS_TONE[c.status]}>{labels[c.status]}</Badge></Row>
            <Row label="Priority"><Badge tone={PRIORITY_TONE[c.priority]}>{PRIORITY[c.priority]}</Badge></Row>
            <Row label="Handled by">{c.assigneeName ?? 'Not assigned yet'}</Row>
            {handler && (
              <>
                <Row label="First reply"><Badge tone={TARGET_TONE[c.firstResponse]}>{TARGET[c.firstResponse]}</Badge>{c.firstResponseDueAt && !c.firstRespondedAt && <span className="text-xs text-fg-muted">due {dateTime(c.firstResponseDueAt)}</span>}</Row>
                <Row label="Resolution"><Badge tone={TARGET_TONE[c.resolution]}>{TARGET[c.resolution]}</Badge>{c.resolutionDueAt && !c.resolvedAt && <span className="text-xs text-fg-muted">due {dateTime(c.resolutionDueAt)}</span>}</Row>
                {c.reopenedCount > 0 && <Row label="Reopened">{c.reopenedCount}×</Row>}
              </>
            )}
            {c.satisfaction !== null && <Row label="Rating">{c.satisfaction} / 5{c.satisfactionComment ? ` · ${c.satisfactionComment}` : ''}</Row>}
          </CardBody>
        </Card>

        {c.can.assign && (
          <Card>
            <CardHeader title="Handle" />
            <CardBody className="grid gap-3">
              <Field label="Assignee">
                {(p) => (
                  <Select {...p} value={c.assigneeMembershipId ?? ''} disabled={pending} onChange={(e) => run(() => assignAction(c.id, e.target.value || null))}>
                    <option value="">Unassigned</option>
                    {handlers.map((h) => <option key={h.membershipId} value={h.membershipId}>{h.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Priority">
                {(p) => <Select {...p} value={c.priority} disabled={pending} onChange={(e) => run(() => priorityAction(c.id, e.target.value))}>{Object.entries(PRIORITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
              </Field>
              <Field label="Category" hint="Moving a case into a confidential category makes it confidential.">
                {(p) => <Select {...p} value={c.categoryId} disabled={pending} onChange={(e) => confirm('Move this case to another category?') && run(() => categoryAction(c.id, e.target.value))}>{categories.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select>}
              </Field>
            </CardBody>
          </Card>
        )}

        {handler && c.history.length > 0 && (
          <Card>
            <CardHeader title="History" />
            <ul className="divide-y divide-border text-xs">
              {c.history.map((h, i) => (
                <li key={i} className="px-5 py-2">
                  <span className="font-medium">{h.byName ?? 'SampCrew'}</span> {HISTORY[h.action] ?? h.action}
                  {h.action === 'status' && h.to ? `: ${STATUS[h.from ?? ''] ?? h.from} → ${STATUS[h.to] ?? h.to}` : ''}
                  {h.action === 'assigned' ? ` to ${h.toName ?? 'nobody'}` : ''}
                  {h.action === 'priority' && h.to ? `: ${PRIORITY[h.to] ?? h.to}` : ''}
                  <div className="text-fg-subtle">{dateTime(h.createdAt)}</div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-fg-muted">{label}</span><span className="flex items-center gap-2">{children}</span></div>;
}

function Message({ author, at, body, internal, hr, ai }: { author: string; at: string; body: string; internal?: boolean; hr?: boolean; ai?: boolean }) {
  return (
    <div className={cn('rounded-lg border px-4 py-3', internal ? 'border-warning/40 bg-warning-subtle/50' : hr ? 'border-accent/20 bg-accent-subtle/40' : 'border-border bg-bg-subtle/40')}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span className="font-medium text-fg">{author}</span>
        {internal && <Badge tone="warning">Internal note</Badge>}
        {ai && <Badge tone="info">Drafted with AI</Badge>}
        <span>{dateTime(at)}</span>
      </div>
      <div className="whitespace-pre-wrap text-[0.8125rem]">{body}</div>
    </div>
  );
}

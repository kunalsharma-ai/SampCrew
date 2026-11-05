'use client';
import { Alert, Avatar, Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Textarea } from '@crew/ui';
import { Heart, Search } from 'lucide-react';
import { useState, useTransition } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import { useRunner } from '../recruitment/use-runner';
import { archiveValueAction, hideRecognitionAction, recogniseAction, saveValueAction, searchColleaguesAction } from '../talent/actions';
import { dateTime } from '../talent/labels';
import type { Colleague, CompanyValue, Recognition } from '../talent/types';

export function RecognitionView({ feed, values, moderator }: { feed: Recognition[]; values: CompanyValue[]; moderator: boolean }) {
  const { pending, notice, run } = useRunner();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Colleague[]>([]);
  const [to, setTo] = useState<Colleague | null>(null);
  const [valueId, setValueId] = useState('');
  const [message, setMessage] = useState('');
  const [searching, startSearch] = useTransition();
  const [valueDialog, setValueDialog] = useState<CompanyValue | 'new' | null>(null);
  const live = values.filter((v) => !v.archivedAt);
  const editing = valueDialog && valueDialog !== 'new' ? valueDialog : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid content-start gap-4 lg:col-span-2">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {feed.length ? feed.map((r) => (
          <Card key={r.id} className={r.hiddenAt ? 'opacity-60' : undefined}>
            <CardBody className="flex gap-3">
              <Avatar name={r.fromName} />
              <div className="min-w-0 flex-1 text-[0.8125rem]">
                <div><span className="font-medium">{r.fromName}</span> recognised <span className="font-medium">{r.toName}</span>{r.toDepartmentName && <span className="text-fg-muted"> · {r.toDepartmentName}</span>}</div>
                <p className="mt-1 whitespace-pre-wrap text-fg">{r.message}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                  {r.valueName && <Badge tone="ember">{r.valueName}</Badge>}
                  <span>{dateTime(r.createdAt)}</span>
                  {r.hiddenAt && <Badge tone="warning">Hidden: {r.hiddenReason}</Badge>}
                  {moderator && !r.hiddenAt && (
                    <Button size="sm" variant="ghost" className="ml-auto" loading={pending} onClick={() => { const why = prompt('Why hide this post? (kept in the audit trail)'); if (why) run(() => hideRecognitionAction(r.id, why)); }}>Hide</Button>
                  )}
                </div>
              </div>
            </CardBody>
          </Card>
        )) : (
          <Card><EmptyState icon={<Heart className="size-5" />} title="No recognition yet" description="Be the first to thank a colleague." /></Card>
        )}
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader title="Recognise someone" />
          <CardBody>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!to) return;
                run(() => recogniseAction({ toEmployeeId: to.id, valueId: valueId || null, message }), () => { setMessage(''); setTo(null); setResults([]); setQ(''); });
              }}
            >
              {to ? (
                <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.8125rem]">
                  <span className="font-medium">{to.name}</span><span className="text-xs text-fg-muted">{to.departmentName}</span>
                  <Button size="sm" variant="ghost" type="button" className="ml-auto" onClick={() => setTo(null)}>Change</Button>
                </div>
              ) : (
                <div className="grid gap-2">
                  <div className="flex gap-2">
                    <Input aria-label="Find a colleague" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a colleague"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); startSearch(async () => { const r = await searchColleaguesAction(q); if (r.ok) setResults(r.data ?? []); }); } }} />
                    <Button type="button" variant="secondary" loading={searching} onClick={() => startSearch(async () => { const r = await searchColleaguesAction(q); if (r.ok) setResults(r.data ?? []); })}><Search className="size-3.5" /></Button>
                  </div>
                  {results.length > 0 && (
                    <ul className="grid max-h-48 gap-0.5 overflow-auto rounded-lg border border-border p-1">
                      {results.map((c) => (
                        <li key={c.id}><button type="button" className="w-full rounded-md px-2 py-1 text-left text-[0.8125rem] hover:bg-bg-subtle" onClick={() => setTo(c)}>{c.name} <span className="text-xs text-fg-muted">{c.departmentName}</span></button></li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <Field label="Company value">
                {(p) => <Select {...p} name="valueId" value={valueId} onChange={(e) => setValueId(e.target.value)}><option value="">None</option>{live.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>}
              </Field>
              <Field label="What did they do?" required>{(p) => <Textarea {...p} name="message" rows={3} maxLength={500} required value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Be specific: what happened and why it mattered" />}</Field>
              <Button type="submit" loading={pending} disabled={!to || message.trim().length < 3}>Post recognition</Button>
            </form>
          </CardBody>
        </Card>

        {moderator && (
          <Card>
            <CardHeader title="Company values" action={<Button size="sm" variant="secondary" onClick={() => setValueDialog('new')}>Add</Button>} />
            <ul className="divide-y divide-border">
              {values.map((v) => (
                <li key={v.id} className={`flex items-start gap-2 px-5 py-2.5 text-[0.8125rem] ${v.archivedAt ? 'opacity-60' : ''}`}>
                  <div className="min-w-0 flex-1"><div className="font-medium">{v.name}{v.archivedAt && ' (archived)'}</div><div className="text-xs text-fg-muted">{v.description}</div></div>
                  {!v.archivedAt && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setValueDialog(v)}>Edit</Button>
                      <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm(`Archive "${v.name}"?`) && run(() => archiveValueAction(v.id))}>Archive</Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <ResourceDialog
        key={editing?.id ?? 'new-value'}
        open={valueDialog !== null}
        onClose={() => setValueDialog(null)}
        title={editing ? 'Edit value' : 'Add company value'}
        submitLabel="Save"
        initial={editing ? { name: editing.name, description: editing.description } : undefined}
        fields={[{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description', type: 'textarea' }]}
        onSubmit={(v) => saveValueAction(editing?.id ?? null, v)}
      />
    </div>
  );
}

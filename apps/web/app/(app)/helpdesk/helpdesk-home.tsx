'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { BookOpen, LifeBuoy } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { articleAction, createCaseAction, suggestArticlesAction } from './actions';
import { dateTime, hours, PRIORITY, STATUS_MINE, STATUS_TONE } from './labels';
import type { Article, CaseRow, Category } from './types';

export function HelpdeskHome({ categories, cases, articles, showAll }: { categories: Category[]; cases: CaseRow[]; articles: Article[]; showAll: boolean }) {
  const router = useRouter();
  const [categoryId, setCategoryId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('normal');
  const [suggested, setSuggested] = useState<Article[]>([]);
  const [reading, setReading] = useState<Article | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());
  const category = categories.find((c) => c.id === categoryId);

  useEffect(() => {
    if (!categoryId) return setSuggested([]);
    const t = setTimeout(async () => {
      const r = await suggestArticlesAction(categoryId, subject);
      setSuggested(r.ok ? (r.data ?? []).slice(0, 3) : []);
    }, 400);
    return () => clearTimeout(t);
  }, [categoryId, subject]);

  const open = async (id: string) => {
    const r = await articleAction(id);
    if (r.ok && r.data) setReading(r.data);
  };
  // A link to /helpdesk?article=<id> (from SampCrew IQ, for example) opens that article.
  useEffect(() => {
    const id = new URL(window.location.href).searchParams.get('article');
    if (id && /^[0-9a-f-]{36}$/.test(id)) void open(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid content-start gap-6 lg:col-span-2">
        <Card>
          <CardHeader
            title={showAll ? 'All my cases' : 'My open cases'}
            action={<Link className="text-[0.8125rem] font-medium text-accent hover:underline" href={showAll ? '/helpdesk' : '/helpdesk?show=all'}>{showAll ? 'Open only' : 'Show closed too'}</Link>}
          />
          {cases.length ? (
            <Table>
              <THead><tr><TH>Case</TH><TH>Category</TH><TH>Status</TH><TH>Updated</TH></tr></THead>
              <TBody>
                {cases.map((c) => (
                  <TR key={c.id}>
                    <TD><Link className="font-medium text-accent hover:underline" href={`/helpdesk/${c.id}`}>{c.ref}</Link> <span className="text-fg">{c.subject}</span></TD>
                    <TD className="text-fg-muted">{c.categoryName}{c.confidential && <Badge tone="warning" className="ml-1.5">Confidential</Badge>}</TD>
                    <TD><Badge tone={STATUS_TONE[c.status]}>{STATUS_MINE[c.status]}</Badge></TD>
                    <TD className="whitespace-nowrap text-fg-muted">{dateTime(c.updatedAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <CardBody><EmptyState icon={<LifeBuoy className="size-5" />} title={showAll ? 'No cases yet' : 'No open cases'} description="Ask HR a question with the form on this page." /></CardBody>
          )}
        </Card>

        <Card>
          <CardHeader title="Help articles" description="Answers to common questions, written by HR." />
          {articles.length ? (
            <ul className="divide-y divide-border">
              {articles.map((a) => (
                <li key={a.id} className="px-5 py-3">
                  <button type="button" className="text-left text-[0.8125rem] font-medium text-accent hover:underline" onClick={() => open(a.id)}>{a.title}</button>
                  <p className="mt-0.5 line-clamp-2 text-xs text-fg-muted">{a.categoryName ? `${a.categoryName} · ` : ''}{a.excerpt}</p>
                </li>
              ))}
            </ul>
          ) : (
            <CardBody><EmptyState icon={<BookOpen className="size-5" />} title="No articles yet" description="HR has not published any help articles." /></CardBody>
          )}
        </Card>
      </div>

      <Card className="content-start">
        <CardHeader title="Ask a question" />
        <CardBody>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setFe({});
              start(async () => {
                const r = await createCaseAction({ categoryId, subject, description, priority }, key.current);
                if (r.ok && r.data) {
                  key.current = crypto.randomUUID();
                  router.push(`/helpdesk/${r.data.id}`);
                } else if (!r.ok) {
                  setError(r.message);
                  setFe(r.fieldErrors ?? {});
                }
              });
            }}
          >
            {error && <Alert tone="danger">{error}</Alert>}
            <Field label="What is it about?" required error={fe.categoryId}>
              {(p) => (
                <Select {...p} name="categoryId" required value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  <option value="">Choose…</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.confidential ? ' (confidential)' : ''}</option>)}
                </Select>
              )}
            </Field>
            {category && (
              <p className="-mt-2 text-xs text-fg-muted">
                {category.description} {category.firstResponseHours ? `HR aims to reply within ${hours(category.firstResponseHours)}.` : ''}
                {category.confidential && ' Confidential: only the named HR handlers can see it.'}
              </p>
            )}
            <Field label="Subject" required error={fe.subject}>{(p) => <Input {...p} name="subject" required minLength={3} maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
            {suggested.length > 0 && (
              <div className="rounded-lg border border-border bg-bg-subtle/60 p-3 text-[0.8125rem]">
                <div className="mb-1 font-medium">These articles may already answer it</div>
                <ul className="grid gap-1">
                  {suggested.map((a) => <li key={a.id}><button type="button" className="text-left text-accent hover:underline" onClick={() => open(a.id)}>{a.title}</button></li>)}
                </ul>
              </div>
            )}
            <Field label="Your question" required error={fe.description} hint="At least 10 characters. Don't include passwords or bank details.">
              {(p) => <Textarea {...p} name="description" rows={5} required minLength={10} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} />}
            </Field>
            <Field label="How urgent is it?">
              {(p) => <Select {...p} name="priority" value={priority} onChange={(e) => setPriority(e.target.value)}>{Object.entries(PRIORITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
            </Field>
            <Button type="submit" loading={pending}>Send to HR</Button>
          </form>
        </CardBody>
      </Card>

      <Dialog open={reading !== null} onClose={() => setReading(null)} title={reading?.title ?? ''} description={reading?.categoryName ?? undefined} size="lg">
        <div className="whitespace-pre-wrap text-[0.8125rem] leading-relaxed">{reading?.body}</div>
      </Dialog>
    </div>
  );
}

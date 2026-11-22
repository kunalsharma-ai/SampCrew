'use client';
import {
  HELP_OTHER_CATEGORY, HELP_QUERY_STATUSES, HELP_QUERY_STATUS_LABEL,
  type HelpFileView, type HelpQueryCategoryView, type HelpQueryDetail, type HelpQueryList, type HelpQueryMessageView, type HelpQueryStatus, type HelpQueryView, type HelpSettings,
} from '@crew/contracts';
import {
  ArrowUpCircle, CheckCircle2, ChevronRight, CircleDot, Copy, FileText, Inbox, Lock, MessageSquarePlus, Paperclip, RotateCcw, Search, Send, Star, Ticket, UserRound, X,
} from 'lucide-react';
import { useMemo, useRef, useState, useTransition } from 'react';
import { cn } from '../../cn';
import { Button, buttonClass } from '../button';
import { Dialog } from '../dialog';
import { Field, Input, Select, Textarea } from '../form';
import { Alert, Avatar, Badge, Card, EmptyState } from '../surface';
import { type HelpUploaded, useHelpCentre } from './context';
import { Crumbs, STATUS_TONE } from './parts';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function QueryStatusBadge({ status }: { status: HelpQueryStatus }) {
  return <Badge tone={STATUS_TONE[status]} dot className="crew-query-status">{HELP_QUERY_STATUS_LABEL[status]}</Badge>;
}

export type QueryMode = 'mine' | 'inbox' | 'console';

/** The list of queries: the person's own (mine), the ones their level answers (inbox), or the Console Admin team's. */
export function HelpQueryListView({ list, mode, search, raise }: { list: HelpQueryList; mode: QueryMode; search: { q?: string; status?: string; assigned?: string }; raise?: boolean }) {
  const { base, queriesBase, inboxBase, Link, push } = useHelpCentre();
  const listBase = mode === 'mine' ? queriesBase : inboxBase;
  const [q, setQ] = useState(search.q ?? '');
  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ q: search.q, status: search.status, assigned: search.assigned, ...over }).filter(([, v]) => v) as [string, string][]);
    return `${listBase}${p.size ? `?${p}` : ''}`;
  };
  const chip = (on: boolean) => cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs', on ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-fg-muted hover:text-fg');
  return (
    <div className="grid gap-4" data-testid={`help-queries-${mode}`}>
      {mode !== 'console' && <Crumbs items={[{ label: 'Help & Support', href: base }, { label: mode === 'mine' ? 'My queries' : 'Queries inbox' }]} />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(['open', 'in_progress', 'awaiting_user', 'resolved', 'closed'] as const).map((s) => (
          <Link key={s} href={href({ status: search.status === s ? undefined : s })} className={cn('rounded-xl border bg-surface p-3 shadow-card transition hover:border-accent/50', search.status === s ? 'border-accent' : 'border-border')} data-testid={`query-count-${s}`}>
            <span className="block text-[11px] font-medium text-fg-muted">{HELP_QUERY_STATUS_LABEL[s]}</span>
            <span className="mt-0.5 block text-xl font-semibold text-fg">{list.counts[s] ?? 0}</span>
          </Link>
        ))}
      </div>
      <Card className="p-0">
        <div className="flex flex-col gap-2 border-b border-border p-3 sm:flex-row sm:items-center">
          <form className="relative flex-1" onSubmit={(e) => { e.preventDefault(); push(href({ q: q.trim() || undefined })); }}>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-fg-subtle" aria-hidden />
            <Input aria-label="Search queries" placeholder={mode === 'mine' ? 'Ticket ID, subject or text (Enter)' : 'Ticket ID, subject, person or workspace (Enter)'} value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
          </form>
          <nav aria-label="Filter queries" className="flex flex-wrap gap-1">
            <Link href={href({ status: undefined, assigned: undefined })} className={chip(!search.status && !search.assigned)}>All ({list.counts.all ?? 0})</Link>
            {mode !== 'mine' && <Link href={href({ assigned: search.assigned === 'me' ? undefined : 'me' })} className={chip(search.assigned === 'me')} data-testid="filter-assigned-me">Assigned to me</Link>}
            {mode !== 'mine' && <Link href={href({ assigned: search.assigned === 'none' ? undefined : 'none' })} className={chip(search.assigned === 'none')} data-testid="filter-unassigned">Unassigned</Link>}
          </nav>
          {raise && mode === 'mine' && <Link href={`${queriesBase}/new`} className={buttonClass('primary', 'sm')} data-testid="queries-raise"><MessageSquarePlus className="size-3.5" aria-hidden />Raise a Query</Link>}
        </div>
        <ul className="divide-y divide-border" data-testid="query-rows">
          {list.items.map((x) => <QueryRow key={x.id} x={x} href={`${listBase}/${x.id}`} mode={mode} />)}
          {!list.items.length && (
            <li>
              <EmptyState
                icon={<Inbox className="size-5" />}
                title={search.q || search.status || search.assigned ? 'No queries match' : mode === 'mine' ? 'You have not raised any queries' : 'No queries to answer'}
                description={mode === 'mine' ? 'When you raise a query it appears here with its ticket ID and status.' : 'Queries from the people you look after arrive here, and you are notified of each one.'}
                action={mode === 'mine' && raise ? <Link href={`${queriesBase}/new`} className={buttonClass('primary', 'sm')}>Raise a Query</Link> : undefined}
              />
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}

function QueryRow({ x, href, mode }: { x: HelpQueryView; href: string; mode: QueryMode }) {
  const { Link } = useHelpCentre();
  return (
    <li>
      <Link href={href} className={cn('grid grid-cols-[auto_1fr_auto] items-start gap-3 px-4 py-3 hover:bg-bg-subtle', x.unread && 'bg-accent-subtle/30')} data-testid="query-row">
        <span className="mt-0.5 flex size-9 items-center justify-center rounded-lg bg-accent-subtle text-accent"><Ticket className="size-4" aria-hidden /></span>
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle">
            <span className="font-mono font-semibold text-fg-muted" data-testid="query-ticket">{x.ticketId}</span>
            <span>· {x.category.label}</span>
            {mode === 'console' && <span>· {x.workspace.name}</span>}
            {x.unread && <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-fg" data-testid="query-unread">New reply</span>}
          </span>
          <span className={cn('mt-0.5 block truncate text-[13.5px] text-fg', x.unread ? 'font-semibold' : 'font-medium')} data-testid="query-subject">{x.subject}</span>
          <span className="block truncate text-xs text-fg-muted">
            {mode === 'mine' ? `With ${x.hrWorkspace ? `${x.hrWorkspace.name} HR Workspace` : x.routeLabel}` : `${x.raisedBy.name} · ${x.raisedBy.levelLabel}${x.raisedBy.workspace ? ` · ${x.raisedBy.workspace}` : ''}`}
            {x.assignee ? ` · assigned to ${x.assignee.name}` : mode !== 'mine' ? ' · unassigned' : ''}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <QueryStatusBadge status={x.status} />
          <span className="text-[11px] text-fg-subtle" suppressHydrationWarning>{when(x.lastMessageAt)}</span>
        </span>
      </Link>
    </li>
  );
}

function Files({ files }: { files: HelpFileView[] }) {
  if (!files.length) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {files.map((f) => (
        <li key={f.id}>
          <a href={f.href} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:border-accent/50" data-testid="query-file">
            <FileText className="size-3.5 text-fg-muted" aria-hidden />{f.name}<span className="text-fg-subtle">{size(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Message({ m }: { m: HelpQueryMessageView }) {
  if (m.kind === 'event') return <li className="flex items-center gap-2 text-xs text-fg-muted" data-testid="query-event"><CircleDot className="size-3 text-fg-subtle" aria-hidden /><span>{m.body}</span><span className="text-fg-subtle" suppressHydrationWarning>· {when(m.createdAt)}</span></li>;
  const note = m.kind === 'note';
  return (
    <li className={cn('flex gap-3', m.mine && 'flex-row-reverse')} data-testid={note ? 'query-note' : 'query-message'}>
      <Avatar name={m.author?.name ?? 'SampCrew'} size={30} />
      <div className={cn('min-w-0 max-w-[85%]', m.mine && 'items-end text-right')}>
        <div className={cn('mb-0.5 flex flex-wrap items-center gap-1.5 text-[11px]', m.mine && 'justify-end')}>
          <span className="font-semibold text-fg">{m.mine ? 'You' : m.author?.name ?? 'SampCrew'}</span>
          {m.author && <Badge tone={m.fromRaiser ? 'info' : 'ember'}>{m.author.levelLabel}</Badge>}
          {m.author?.workspace && <span className="text-fg-subtle">{m.author.workspace}</span>}
          {note && <Badge tone="warning" className="gap-1"><Lock className="size-3" aria-hidden />Internal note</Badge>}
        </div>
        <div className={cn('inline-block rounded-2xl px-3.5 py-2 text-left text-[13.5px]', note ? 'border border-dashed border-warning/50 bg-warning-subtle/40 text-fg' : m.mine ? 'rounded-tr-sm bg-accent text-accent-fg' : 'rounded-tl-sm bg-bg-subtle text-fg')}>
          <span className="whitespace-pre-wrap break-words">{m.body}</span>
        </div>
        <Files files={m.files} />
        <div className="mt-0.5 text-[11px] text-fg-subtle" suppressHydrationWarning>{when(m.createdAt)}</div>
      </div>
    </li>
  );
}

/** Picks files, uploads each through the app's upload action and keeps the uploaded ids. */
function Attachments({ files, setFiles, enabled }: { files: HelpUploaded[]; setFiles: (f: HelpUploaded[]) => void; enabled: boolean }) {
  const { actions } = useHelpCentre();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!enabled || !actions.upload) return null;
  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(null);
    setBusy(true);
    const out = [...files];
    for (const f of Array.from(list)) {
      if (out.length >= 5) { setError('Attach up to 5 files'); break; }
      const form = new FormData();
      form.set('file', f);
      const r = await actions.upload!(form);
      if (r.ok && r.data) out.push(r.data); else if (!r.ok) setError(r.message);
    }
    setFiles(out);
    setBusy(false);
    if (input.current) input.current.value = '';
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => input.current?.click()} disabled={busy || files.length >= 5} className={buttonClass('secondary', 'sm')} data-testid="query-attach"><Paperclip className="size-3.5" aria-hidden />{busy ? 'Uploading…' : 'Attach files'}</button>
        <input ref={input} type="file" multiple className="sr-only" aria-label="Attach files" data-testid="query-file-input" onChange={(e) => void pick(e.target.files)} />
        {files.map((f) => (
          <span key={f.id} className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-subtle px-2 py-1 text-xs" data-testid="query-attached">
            <FileText className="size-3" aria-hidden />{f.name}
            <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.id !== f.id))} className="text-fg-subtle hover:text-danger"><X className="size-3" /></button>
          </span>
        ))}
      </div>
      <span className="text-[11px] text-fg-subtle">Screenshots, PDFs or documents, up to 5 files of 10 MB each.</span>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}

export interface HelpQueryForm {
  categories: HelpQueryCategoryView[];
  settings: HelpSettings;
  contact: { name: string; email: string | null; phone: string | null; level: string; levelLabel: string; workspace: string | null; routesTo: string };
}

/** Raise a Query: category (or Other), subject, description, the page or feature, attachments and contact details. */
export function RaiseQueryForm({ form, preset }: { form: HelpQueryForm; preset: { page?: string; article?: string; category?: string; subject?: string } }) {
  const { base, queriesBase, Link, actions } = useHelpCentre();
  const cats = form.categories.filter((c) => c.active);
  const [category, setCategory] = useState(preset.category && cats.some((c) => c.key === preset.category) ? preset.category : '');
  const [subject, setSubject] = useState(preset.subject ?? '');
  const [description, setDescription] = useState('');
  const [page, setPage] = useState(preset.page ?? '');
  const [phone, setPhone] = useState(form.contact.phone ?? '');
  const [files, setFiles] = useState<HelpUploaded[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; ticketId: string; routeLabel: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const clientId = useMemo(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())), []);
  const chosen = cats.find((c) => c.key === category);

  if (done) {
    return (
      <Card className="mx-auto w-full max-w-xl p-6 text-center sm:p-8" data-testid="query-confirmation">
        <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-success-subtle text-success"><CheckCircle2 className="size-7" aria-hidden /></span>
        <h1 className="mt-4 text-xl font-semibold text-fg">Your query has been raised</h1>
        <p className="mt-1 text-sm text-fg-muted">We sent it to {done.routeLabel}. You will be notified of every reply, and you can follow it in My queries.</p>
        <div className="mx-auto mt-5 flex w-fit items-center gap-2 rounded-xl border border-border bg-bg-subtle px-4 py-3">
          <span className="text-xs text-fg-muted">Ticket ID</span>
          <span className="font-mono text-lg font-semibold text-fg" data-testid="query-ticket-id">{done.ticketId}</span>
          <button type="button" aria-label="Copy the ticket ID" onClick={() => { void navigator.clipboard?.writeText(done.ticketId); setCopied(true); }} className="rounded p-1 text-fg-muted hover:bg-surface"><Copy className="size-4" /></button>
          {copied && <span className="text-[11px] text-success">Copied</span>}
        </div>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href={`${queriesBase}/${done.id}`} className={buttonClass('primary', 'md')} data-testid="query-open">View the query</Link>
          <Link href={base} className={buttonClass('secondary', 'md')}>Back to Help &amp; Support</Link>
        </div>
      </Card>
    );
  }

  const submit = () => {
    setError(null);
    const e: Record<string, string> = {};
    if (!category) e.categoryKey = 'Choose a category, or Other';
    if (subject.trim().length < 5) e.subject = 'Give your query a short subject (5 characters or more)';
    if (description.trim().length < 10) e.description = 'Describe your question or problem in a sentence or two';
    setErrors(e);
    if (Object.keys(e).length || !actions.raise) return;
    start(async () => {
      const r = await actions.raise!({ categoryKey: category, subject: subject.trim(), description: description.trim(), page: page.trim() || null, articleId: preset.article ?? null, contactPhone: phone.trim() || null, fileIds: files.map((f) => f.id), clientId });
      if (r.ok && r.data) setDone(r.data);
      else if (!r.ok) { setError(r.message); setErrors(r.fieldErrors ?? {}); }
    });
  };

  return (
    <div className="grid gap-4" data-testid="raise-query">
      <Crumbs items={[{ label: 'Help & Support', href: base }, { label: 'My queries', href: queriesBase }, { label: 'Raise a Query' }]} />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="grid gap-5 p-5 sm:p-6">
          <div>
            <h1 className="text-xl font-semibold text-fg">Raise a Query</h1>
            <p className="mt-1 text-sm text-fg-muted">Tell us what you need. It goes to {form.contact.routesTo}, unless the category says otherwise.</p>
          </div>
          <fieldset className="grid gap-2" data-testid="query-categories">
            <legend className="mb-1 text-sm font-medium text-fg">What is it about? <span className="text-danger">*</span></legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {cats.map((c) => (
                <label key={c.key} className={cn('flex cursor-pointer flex-col gap-0.5 rounded-lg border p-2.5 text-left transition', category === c.key ? 'border-accent bg-accent-subtle/60 ring-1 ring-accent/40' : 'border-border hover:border-border-strong')} data-testid={`query-category-${c.key}`}>
                  <input type="radio" name="categoryKey" value={c.key} checked={category === c.key} onChange={() => setCategory(c.key)} className="sr-only" />
                  <span className="text-[13px] font-medium text-fg">{c.label}</span>
                  {c.description && <span className="line-clamp-2 text-[11px] text-fg-muted">{c.description}</span>}
                </label>
              ))}
            </div>
            {errors.categoryKey && <span className="text-xs text-danger">{errors.categoryKey}</span>}
            {chosen?.toConsole && <span className="text-xs text-fg-muted">This category goes straight to the SampCrew Support team.</span>}
            {chosen?.key === HELP_OTHER_CATEGORY && <span className="text-xs text-fg-muted">Not sure which one fits? Other is fine: describe it below.</span>}
          </fieldset>
          <Field label="Subject" required error={errors.subject}>
            {(fp) => <Input {...fp} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={150} placeholder="For example: I cannot see my leave balance" data-testid="query-subject-input" />}
          </Field>
          <Field label="Description" required error={errors.description} hint="What you tried, what you expected and any error message you saw.">
            {(fp) => <Textarea {...fp} value={description} onChange={(e) => setDescription(e.target.value)} rows={6} maxLength={5000} data-testid="query-description-input" />}
          </Field>
          <Field label="Feature or page" hint="Where in SampCrew this happens, such as Leave, then Apply for leave." error={errors.page}>
            {(fp) => <Input {...fp} value={page} onChange={(e) => setPage(e.target.value)} maxLength={200} data-testid="query-page-input" />}
          </Field>
          <Attachments files={files} setFiles={setFiles} enabled={form.settings.attachments} />
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} loading={pending} data-testid="query-submit"><Send className="size-4" aria-hidden />Submit query</Button>
            <Link href={base} className={buttonClass('ghost', 'md')}>Cancel</Link>
          </div>
        </Card>
        <Card className="h-fit p-4" data-testid="query-contact">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg"><UserRound className="size-4 text-fg-muted" aria-hidden />Your contact details</h2>
          <p className="mt-1 text-[11px] text-fg-muted">Filled in from your account so the team can reach you.</p>
          <dl className="mt-3 grid gap-2 text-xs">
            <div><dt className="text-fg-subtle">Name</dt><dd className="font-medium text-fg" data-testid="contact-name">{form.contact.name}</dd></div>
            <div><dt className="text-fg-subtle">Level</dt><dd className="text-fg">{form.contact.levelLabel}{form.contact.workspace ? ` · ${form.contact.workspace}` : ''}</dd></div>
            <div><dt className="text-fg-subtle">Email</dt><dd className="break-all text-fg" data-testid="contact-email">{form.contact.email ?? 'Not set'}</dd></div>
          </dl>
          <Field label="Phone" className="mt-3" error={errors.contactPhone}>
            {(fp) => <Input {...fp} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} data-testid="contact-phone" />}
          </Field>
        </Card>
      </div>
    </div>
  );
}

/** One query: the conversation, replies and the controls the viewer may use (close, reopen, rate, assign, escalate). */
export function HelpQueryDetailView({ d, mode, settings }: { d: HelpQueryDetail; mode: QueryMode; settings?: Pick<HelpSettings, 'attachments'> }) {
  const { base, queriesBase, inboxBase, Link, actions, refresh } = useHelpCentre();
  const handler = d.can.handle;
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [nextStatus, setNextStatus] = useState<HelpQueryStatus | ''>('');
  const [files, setFiles] = useState<HelpUploaded[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [escalating, setEscalating] = useState(false);
  const [reason, setReason] = useState('');
  const [rating, setRating] = useState(d.rating ?? 0);
  const [comment, setComment] = useState('');
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>, ok?: string, after?: () => void) => start(async () => {
    setError(null);
    const r = await fn();
    if (r.ok) { setNote(r.message ?? ok ?? null); after?.(); refresh(); } else setError(r.message ?? 'Something went wrong');
  });
  const send = () => {
    const body = text.trim();
    if (!body || !actions.reply) return;
    run(() => actions.reply!(d.id, { body, internal: handler ? internal : false, status: handler && nextStatus ? nextStatus : undefined, fileIds: files.map((f) => f.id), clientId: crypto.randomUUID() }), internal ? 'Internal note added.' : 'Reply sent.', () => { setText(''); setFiles([]); setNextStatus(''); setInternal(false); });
  };
  const back = mode === 'mine' ? queriesBase : inboxBase;
  return (
    <div className="grid gap-4" data-testid="query-detail" data-status={d.status}>
      {mode !== 'console' ? <Crumbs items={[{ label: 'Help & Support', href: base }, { label: mode === 'mine' ? 'My queries' : 'Queries inbox', href: back }, { label: d.ticketId }]} /> : <Link href={back} className="text-xs text-fg-muted hover:text-accent">← Help queries</Link>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Card className="flex min-h-[28rem] flex-col p-0">
          <div className="border-b border-border px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-semibold text-fg-muted" data-testid="query-detail-ticket">{d.ticketId}</span>
              <QueryStatusBadge status={d.status} />
              <Badge tone="neutral">{d.category.label}</Badge>
            </div>
            <h1 className="mt-1.5 text-lg font-semibold text-fg" data-testid="query-detail-subject">{d.subject}</h1>
            <p className="mt-0.5 text-xs text-fg-muted">Raised {when(d.createdAt)} by {mode === 'mine' ? 'you' : `${d.raisedBy.name} (${d.raisedBy.levelLabel})`} · with {d.hrWorkspace ? `${d.hrWorkspace.name} HR Workspace` : d.routeLabel}</p>
          </div>
          <div className="px-5 py-4">
            <div className="rounded-xl border border-border bg-bg-subtle/60 p-4">
              <p className="whitespace-pre-wrap text-[13.5px] text-fg" data-testid="query-description">{d.description}</p>
              <Files files={d.files} />
            </div>
          </div>
          <ul className="grid flex-1 gap-4 px-5 pb-4" aria-live="polite" data-testid="query-messages">
            {d.messages.map((m) => <Message key={m.id} m={m} />)}
          </ul>
          {d.can.reply && actions.reply && (
            <div className="border-t border-border p-4" data-testid="query-reply">
              {handler && (
                <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
                  <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} data-testid="query-internal" />Internal note (only handlers see it)</label>
                  {!internal && (
                    <label className="inline-flex items-center gap-1.5">Then set status
                      <Select value={nextStatus} onChange={(e) => setNextStatus(e.target.value as HelpQueryStatus)} className="h-7 w-auto text-xs" data-testid="query-reply-status">
                        <option value="">Awaiting User Response</option>
                        {HELP_QUERY_STATUSES.filter((s) => s !== 'awaiting_user').map((s) => <option key={s} value={s}>{HELP_QUERY_STATUS_LABEL[s]}</option>)}
                      </Select>
                    </label>
                  )}
                </div>
              )}
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={5000} placeholder={handler ? (internal ? 'A note for the team' : `Reply to ${d.raisedBy.name}`) : 'Add information or reply'} aria-label="Reply" data-testid="query-reply-input" />
              <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
                <Attachments files={files} setFiles={setFiles} enabled={settings?.attachments !== false} />
                <Button size="sm" onClick={send} loading={pending} disabled={!text.trim()} data-testid="query-reply-send"><Send className="size-3.5" aria-hidden />{internal ? 'Add note' : 'Send reply'}</Button>
              </div>
            </div>
          )}
          {!d.can.reply && d.status === 'closed' && <p className="border-t border-border px-5 py-3 text-xs text-fg-muted">This query is closed.{d.can.reopen ? ' You can reopen it if you still need help.' : ''}</p>}
        </Card>

        <div className="grid h-fit gap-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {note && <Alert tone="success">{note}</Alert>}
          {(d.can.close || d.can.reopen || (handler && actions.status)) && (
            <Card className="grid gap-2 p-4" data-testid="query-actions">
              <h2 className="text-sm font-semibold text-fg">Actions</h2>
              {handler && actions.status && (
                <Field label="Status">
                  {(fp) => <Select {...fp} value={d.status} onChange={(e) => run(() => actions.status!(d.id, e.target.value as HelpQueryStatus), 'Status updated.')} disabled={pending} data-testid="query-status-select">
                    {HELP_QUERY_STATUSES.map((s) => <option key={s} value={s}>{HELP_QUERY_STATUS_LABEL[s]}</option>)}
                  </Select>}
                </Field>
              )}
              {handler && actions.assign && (
                <Field label="Assigned to">
                  {(fp) => <Select {...fp} value={d.assignee?.id ?? ''} onChange={(e) => run(() => actions.assign!(d.id, e.target.value || null), 'Assignment saved.')} disabled={pending} data-testid="query-assignee-select">
                    <option value="">Unassigned</option>
                    {d.assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </Select>}
                </Field>
              )}
              {handler && d.can.escalate && actions.escalate && <Button variant="secondary" size="sm" onClick={() => setEscalating(true)} data-testid="query-escalate"><ArrowUpCircle className="size-3.5" aria-hidden />Escalate to the level above</Button>}
              {!handler && d.can.close && actions.status && <Button variant="secondary" size="sm" onClick={() => run(() => actions.status!(d.id, 'closed'), 'Query closed.')} disabled={pending} data-testid="query-close"><CheckCircle2 className="size-3.5" aria-hidden />Close query</Button>}
              {!handler && d.can.reopen && actions.status && <Button variant="secondary" size="sm" onClick={() => run(() => actions.status!(d.id, 'open'), 'Query reopened.')} disabled={pending} data-testid="query-reopen"><RotateCcw className="size-3.5" aria-hidden />Reopen query</Button>}
            </Card>
          )}
          {d.can.rate && actions.rate && (
            <Card className="grid gap-2 p-4" data-testid="query-rate">
              <h2 className="text-sm font-semibold text-fg">How did we do?</h2>
              <div className="flex gap-1" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} of 5`} onClick={() => setRating(n)} className="rounded p-0.5" data-testid={`query-star-${n}`}>
                    <Star className={cn('size-6', n <= rating ? 'fill-amber-400 text-amber-400' : 'text-fg-subtle')} aria-hidden />
                  </button>
                ))}
              </div>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={500} placeholder="Anything to add? (optional)" aria-label="Rating comment" />
              <Button size="sm" onClick={() => run(() => actions.rate!(d.id, rating, comment.trim() || null), 'Thanks for your rating.')} disabled={!rating || pending} data-testid="query-rate-send">Send rating</Button>
            </Card>
          )}
          {d.rating && !d.can.rate && <Card className="p-4 text-xs text-fg-muted" data-testid="query-rated">Rated {d.rating} of 5</Card>}
          <Card className="p-4" data-testid="query-info">
            <h2 className="text-sm font-semibold text-fg">Details</h2>
            <dl className="mt-2 grid gap-2 text-xs">
              <div><dt className="text-fg-subtle">Raised by</dt><dd className="text-fg">{d.raisedBy.name} · {d.raisedBy.levelLabel}{d.raisedBy.workspace ? ` · ${d.raisedBy.workspace}` : ''}</dd></div>
              {(d.raisedBy.email || d.raisedBy.phone) && <div><dt className="text-fg-subtle">Contact</dt><dd className="break-all text-fg">{[d.raisedBy.email, d.raisedBy.phone].filter(Boolean).join(' · ')}</dd></div>}
              {mode === 'console' && <div><dt className="text-fg-subtle">Company</dt><dd className="text-fg">{d.workspace.name}</dd></div>}
              <div><dt className="text-fg-subtle">Handled by</dt><dd className="text-fg">{d.hrWorkspace ? `${d.hrWorkspace.name} HR Workspace` : d.routeLabel}{d.assignee ? ` · ${d.assignee.name}` : ''}</dd></div>
              {d.page && <div><dt className="text-fg-subtle">Feature or page</dt><dd className="text-fg">{d.page}</dd></div>}
              {d.article && <div><dt className="text-fg-subtle">Read before raising</dt><dd className="text-fg">{d.article.title}</dd></div>}
              <div><dt className="text-fg-subtle">Last activity</dt><dd className="text-fg" suppressHydrationWarning>{when(d.lastMessageAt)}</dd></div>
            </dl>
          </Card>
          {mode === 'mine' && <Link href={base} className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">Browse help articles <ChevronRight className="size-3" aria-hidden /></Link>}
        </div>
      </div>
      <Dialog open={escalating} onClose={() => setEscalating(false)} title="Escalate this query" description="It moves to the level above you (HR Workspace to Super Workspace, Super Workspace to SampCrew Support). They are notified and you can still read it."
        footer={<><Button variant="ghost" onClick={() => setEscalating(false)}>Cancel</Button><Button onClick={() => run(() => actions.escalate!(d.id, reason.trim()), 'Escalated.', () => { setEscalating(false); setReason(''); })} disabled={reason.trim().length < 5} loading={pending} data-testid="query-escalate-confirm">Escalate</Button></>}>
        <Field label="Why does it need the level above?" required>{(fp) => <Textarea {...fp} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} data-testid="query-escalate-reason" />}</Field>
      </Dialog>
    </div>
  );
}

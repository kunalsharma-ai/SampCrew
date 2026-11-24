'use client';
import {
  SUPPORT_CATEGORY_LABEL, SUPPORT_STATE_LABEL,
  type SupportConversationDetail, type SupportMessageView, type SupportState,
} from '@crew/contracts';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Textarea, cn } from '@crew/ui';
import { Building2, Check, CheckCheck, CheckCircle2, Headset, Mail, MailOpen, MessageSquarePlus, RotateCcw, Search, Send } from 'lucide-react';
import { SUPPORT_CATEGORIES } from '@crew/contracts';
import { startConversationAction, triageConversationAction } from '../console-actions';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { readSupportAction, replySupportAction, supportStatusAction } from './actions';
import type { Inbox } from './data';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const when = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return time(iso);
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const PRIORITY_LABEL = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' } as const;
const PRIORITY_TONE = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' } as const;
type Priority = keyof typeof PRIORITY_LABEL;
const TONE: Record<SupportState, 'info' | 'warning' | 'success' | 'neutral'> = { unread: 'info', waiting: 'warning', replied: 'success', resolved: 'neutral' };
const FILTERS: [SupportState | 'all', string][] = [['all', 'All'], ['unread', 'Unread'], ['waiting', 'Waiting for reply'], ['replied', 'Replied'], ['resolved', 'Resolved']];
type Search = { q?: string; state?: string; tenant?: string; start?: string };

const href = (base: string, s: Search) => {
  const p = new URLSearchParams(Object.entries(s).filter(([, v]) => v && v !== 'all') as [string, string][]);
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
};

/** The Console Admin team's support inbox: conversations from every Super Workspace, and one open thread. */
export function SupportInbox({ inbox, detail, search, team = [], tenantName }: { inbox: Inbox; detail: SupportConversationDetail | null; search: Search; team?: { id: string; name: string }[]; tenantName?: string | null }) {
  const router = useRouter();
  const [q, setQ] = useState(search.q ?? '');
  const [starting, setStarting] = useState(search.start === '1' && !!search.tenant);
  const state = search.state ?? 'all';
  const keep = { q: search.q, state: search.state, tenant: search.tenant };
  return (
    <div className="grid gap-4 xl:grid-cols-[26rem_1fr]">
      <Card className={cn('flex min-h-[34rem] flex-col p-0', detail && 'hidden xl:flex')}>
        <div className="grid gap-2 border-b border-border p-3">
          <form className="relative" onSubmit={(e) => { e.preventDefault(); router.push(href('/support', { ...keep, q: q.trim() || undefined })); }}>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-fg-subtle" aria-hidden />
            <Input aria-label="Search support conversations" placeholder="Workspace, subject or message text (Enter)" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
          </form>
          <nav className="flex flex-wrap gap-1" aria-label="Filter conversations">
            {FILTERS.map(([k, label]) => (
              <Link key={k} href={href('/support', { ...keep, state: k })} aria-current={state === k ? 'page' : undefined} className={cn('rounded-full border px-2.5 py-0.5 text-xs', state === k ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-fg-muted hover:text-fg')}>
                {label}{k !== 'all' && inbox.counts[k] ? ` (${inbox.counts[k]})` : k === 'all' ? ` (${inbox.counts.all ?? 0})` : ''}
              </Link>
            ))}
          </nav>
          {search.tenant && <p className="flex flex-wrap items-center gap-1 text-xs text-fg-muted">{tenantName ?? 'One workspace'} only · <Link className="text-accent hover:underline" href={href('/support', { ...keep, tenant: undefined })}>Show all</Link><Button size="sm" variant="secondary" className="ml-auto" onClick={() => setStarting(true)} data-testid="support-start"><MessageSquarePlus className="size-3.5" aria-hidden />New conversation</Button></p>}
        </div>
        <div className="hidden grid-cols-[1fr_auto] gap-2 border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle sm:grid"><span>Super Workspace · last message</span><span>Status · last activity</span></div>
        <ul className="flex-1 divide-y divide-border overflow-y-auto" aria-label="Support conversations" data-testid="support-inbox">
          {inbox.items.map((c) => (
            <li key={c.id}>
              <Link href={href(`/support/${c.id}`, keep)} aria-current={detail?.conversation.id === c.id ? 'page' : undefined} data-testid="support-row" className={cn('grid grid-cols-[auto_1fr_auto] gap-3 px-3 py-2.5 hover:bg-bg-subtle', detail?.conversation.id === c.id && 'bg-accent-subtle/50', c.unread > 0 && 'bg-accent-subtle/25')}>
                <Avatar name={c.workspace.name} size={32} />
                <span className="min-w-0">
                  <span className={cn('block truncate text-[13px]', c.unread ? 'font-semibold text-fg' : 'font-medium')} data-testid="support-row-workspace">{c.workspace.name}</span>
                  <span className="block truncate text-xs text-fg">{c.subject} <span className="text-fg-subtle">#{c.number}</span></span>
                  <span className="block truncate text-xs text-fg-muted">{c.lastMessage ? `${c.lastMessage.fromConsole ? 'You (team)' : c.lastMessage.senderName}: ${c.lastMessage.body}` : ''}</span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  {c.priority && (c.priority === 'high' || c.priority === 'urgent') && <Badge tone={PRIORITY_TONE[c.priority]}>{PRIORITY_LABEL[c.priority]}</Badge>}
                  {c.unread > 0 ? <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-fg" data-testid="support-row-unread">{c.unread} unread</span> : <Badge tone={TONE[c.state]}>{SUPPORT_STATE_LABEL[c.state]}</Badge>}
                  <span className="text-[11px] text-fg-subtle" suppressHydrationWarning>{when(c.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
          {!inbox.items.length && <li><EmptyState icon={<Headset className="size-5" />} title={search.q || (state !== 'all') ? 'No conversations match' : 'No support conversations yet'} description="When a Super Workspace uses Contact SampCrew Support, the conversation arrives here." /></li>}
        </ul>
      </Card>
      {starting && search.tenant && <StartDialog tenantId={search.tenant} name={tenantName ?? 'this Super Workspace'} onClose={() => setStarting(false)} onStarted={(id) => { setStarting(false); router.push(href(`/support/${id}`, { ...keep, start: undefined })); }} />}
      {detail ? <Thread key={detail.conversation.id} d={detail} back={href('/support', keep)} team={team} /> : (
        <Card className="hidden min-h-[34rem] items-center justify-center xl:flex">
          <EmptyState icon={<Headset className="size-5" />} title="Choose a conversation" description="Messages from Super Workspaces arrive here as they are sent. Unread ones are highlighted." />
        </Card>
      )}
    </div>
  );
}

function Delivery({ m }: { m: SupportMessageView }) {
  if (!m.delivery) return null;
  const label = m.delivery === 'read' ? 'Read' : m.delivery === 'delivered' ? 'Delivered' : 'Sent';
  const Icon = m.delivery === 'sent' ? Check : CheckCheck;
  return <span className={cn('inline-flex items-center gap-0.5', m.delivery === 'read' ? 'text-accent' : 'text-fg-subtle')} data-testid="message-delivery" title={label}><Icon className="size-3" aria-hidden />{label}</span>;
}

function Message({ m }: { m: SupportMessageView }) {
  if (m.system) return <p className="text-center text-xs italic text-fg-muted" data-testid="system-message">{m.body}</p>;
  return (
    <div className={cn('flex max-w-[85%] gap-2', m.ourSide ? 'flex-row-reverse justify-self-end' : 'justify-self-start')} data-testid="message">
      <Avatar name={m.sender.name} size={28} />
      <div className={cn('flex min-w-0 flex-col', m.ourSide ? 'items-end' : 'items-start')}>
        <span className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="message-sender">
          <span className="font-semibold text-fg">{m.mine ? `You (${m.sender.name})` : m.sender.name}</span>
          <Badge tone={m.fromConsole ? 'ember' : 'info'}>{m.sender.levelLabel}</Badge>
          {m.sender.workspace && <span className="text-fg-subtle">{m.sender.workspace}</span>}
        </span>
        <div className={cn('rounded-2xl px-3 py-2 text-[13px]', m.ourSide ? 'rounded-tr-sm bg-accent text-accent-fg' : 'rounded-tl-sm bg-bg-subtle text-fg')}>
          <span className="whitespace-pre-wrap break-words">{m.body}</span>
        </div>
        <span className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-subtle"><span suppressHydrationWarning>{time(m.createdAt)}</span><Delivery m={m} /></span>
      </div>
    </div>
  );
}

function Thread({ d, back, team }: { d: SupportConversationDetail; back: string; team: { id: string; name: string }[] }) {
  const router = useRouter();
  const c = d.conversation;
  const info = d.workspaceInfo;
  const [sent, setSent] = useState<SupportMessageView[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => [...d.messages, ...sent.filter((s) => !d.messages.some((m) => m.id === s.id))], [d.messages, sent]);
  const lastId = messages.at(-1)?.id;
  const [markedUnread, setMarkedUnread] = useState(false);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lastId]);
  // Opening a conversation reads it for the whole team, unless someone just marked it unread on purpose.
  useEffect(() => {
    if (!markedUnread && c.unread > 0) void readSupportAction(c.id, true).then(() => router.refresh());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, lastId]);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setError(null);
    start(async () => {
      const r = await replySupportAction(c.id, body, crypto.randomUUID());
      if (r.ok) { setSent((cur) => [...cur, r.data!]); setText(''); router.refresh(); } else setError(r.message);
    });
  };
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) => start(async () => { const r = await fn(); if (r.ok) setNote(r.message ?? null); else setError(r.message ?? 'Something went wrong'); router.refresh(); });
  let lastDay = '';
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_16rem]">
      <Card className="flex min-h-[34rem] flex-col p-0" data-testid="support-thread">
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <Link href={back} className="text-xs text-fg-muted xl:hidden">← Support inbox</Link>
            <h2 className="truncate text-sm font-semibold" data-testid="thread-title">{c.subject}</h2>
            <p className="truncate text-xs text-fg-muted" data-testid="thread-workspace">{c.workspace.name} · Super Workspace · #{c.number} · {SUPPORT_CATEGORY_LABEL[c.category]}{c.handledBy ? ` · last answered by ${c.handledBy}` : ''}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone={TONE[c.state]}>{SUPPORT_STATE_LABEL[c.state]}</Badge>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setMarkedUnread(true); run(() => readSupportAction(c.id, false)); }}><Mail className="size-3.5" /> Mark unread</Button>
            {c.unread > 0 && <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setMarkedUnread(false); run(() => readSupportAction(c.id, true)); }}><MailOpen className="size-3.5" /> Mark read</Button>}
            {c.status === 'open'
              ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => supportStatusAction(c.id, 'resolved'))}><CheckCircle2 className="size-3.5" /> Resolve</Button>
              : <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => supportStatusAction(c.id, 'open'))}><RotateCcw className="size-3.5" /> Reopen</Button>}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite" data-testid="messages">
          {d.hasOlder && <p className="mb-2 text-center text-xs text-fg-subtle">Older messages are not shown.</p>}
          <ul className="grid gap-2.5">
            {messages.map((m) => {
              const d0 = day(m.createdAt);
              const sep = d0 !== lastDay;
              lastDay = d0;
              return <li key={m.id} className="grid">{sep && <div className="my-2 text-center text-[11px] text-fg-subtle" suppressHydrationWarning>{d0}</div>}<Message m={m} /></li>;
            })}
          </ul>
          <div ref={endRef} />
        </div>
        <div className="border-t border-border p-3">
          {error && <div className="mb-2"><Alert tone="danger">{error}</Alert></div>}
          {note && <div className="mb-2"><Alert tone="success">{note}</Alert></div>}
          <div className="flex items-end gap-2">
            <Textarea aria-label="Reply" placeholder={`Reply to ${c.workspace.name} as the Console Admin team. Enter sends, Shift+Enter adds a line.`} value={text} rows={2} maxLength={4000} onChange={(e) => setText(e.target.value)} className="min-h-9 flex-1" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
            <Button size="sm" onClick={send} loading={pending} disabled={!text.trim()} aria-label="Send reply"><Send className="size-4" /></Button>
          </div>
        </div>
      </Card>
      <Card className="h-fit p-4" data-testid="workspace-info">
        <div className="mb-3 flex items-center gap-2"><Building2 className="size-4 text-fg-muted" aria-hidden /><h3 className="text-sm font-semibold">Super Workspace</h3></div>
        <dl className="grid gap-2 text-xs">
          <div><dt className="text-fg-subtle">Company</dt><dd className="font-medium">{c.workspace.name}</dd><dd className="text-fg-muted">{c.workspace.slug}</dd></div>
          {info && <>
            <div><dt className="text-fg-subtle">Status · plan</dt><dd>{info.status}{info.plan ? ` · ${info.plan}` : ''}</dd></div>
            <div><dt className="text-fg-subtle">Super Workspace people</dt><dd>{info.superWorkspace.map((p) => p.name).join(', ') || 'None'}</dd></div>
            <div><dt className="text-fg-subtle">Active people</dt><dd>{info.people}{info.country ? ` · ${info.country}` : ''}</dd></div>
          </>}
          {c.startedBy && <div><dt className="text-fg-subtle">Started by</dt><dd>{c.startedBy.name} · {c.startedBy.levelLabel}</dd></div>}
        </dl>
        <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs" data-testid="support-triage">
          <Field label="Priority">{(p) => <Select {...p} value={c.priority ?? 'normal'} disabled={pending} onChange={(e) => run(() => triageConversationAction(c.id, { priority: e.target.value }))} data-testid="triage-priority">{(Object.keys(PRIORITY_LABEL) as Priority[]).map((k) => <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>)}</Select>}</Field>
          <Field label="Assigned to">{(p) => <Select {...p} value={c.assignedTo?.id ?? ''} disabled={pending} onChange={(e) => run(() => triageConversationAction(c.id, { assignedAdminId: e.target.value || null }))} data-testid="triage-assignee"><option value="">Nobody</option>{c.assignedTo && !team.some((t) => t.id === c.assignedTo!.id) && <option value={c.assignedTo.id}>{c.assignedTo.name}</option>}{team.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
        </div>
        <div className="mt-3 grid gap-1 border-t border-border pt-3 text-xs">
          <Link className="text-accent hover:underline" href={`/tenants/${c.workspace.id}`}>Open workspace</Link>
          <Link className="text-accent hover:underline" href={`/support?tenant=${c.workspace.id}`}>All conversations from this workspace</Link>
        </div>
      </Card>
    </div>
  );
}

/** The Console starts a conversation with a company's Super Workspace (they see it as from SampCrew Support). */
function StartDialog({ tenantId, name, onClose, onStarted }: { tenantId: string; name: string; onClose: () => void; onStarted: (id: string) => void }) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<string>('question');
  const [priority, setPriority] = useState<Priority>('normal');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`Message ${name}`} description="Starts a private conversation with this Super Workspace. They are notified and can answer from Contact SampCrew Support."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={subject.trim().length < 3 || !body.trim()} loading={pending} data-testid="support-start-send" onClick={() => start(async () => {
        const r = await startConversationAction({ tenantId, subject: subject.trim(), body: body.trim(), category, priority });
        if (!r.ok) { setError(r.message ?? 'Not sent'); return; }
        onStarted(r.data!.id);
      })}>Send</Button></>}>
      <div className="grid gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Subject" required>{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />}</Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Topic">{(p) => <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>{SUPPORT_CATEGORIES.map((k) => <option key={k} value={k}>{SUPPORT_CATEGORY_LABEL[k]}</option>)}</Select>}</Field>
          <Field label="Priority">{(p) => <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{(Object.keys(PRIORITY_LABEL) as Priority[]).map((k) => <option key={k} value={k}>{PRIORITY_LABEL[k]}</option>)}</Select>}</Field>
        </div>
        <Field label="Message" required>{(p) => <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={4000} />}</Field>
      </div>
    </Dialog>
  );
}

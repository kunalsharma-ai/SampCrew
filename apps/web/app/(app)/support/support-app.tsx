'use client';
import {
  SUPPORT_CATEGORIES, SUPPORT_CATEGORY_LABEL, SUPPORT_STATE_LABEL,
  type SupportConversationDetail, type SupportConversationView, type SupportMessageView, type SupportState,
} from '@crew/contracts';
import { Alert, Avatar, Badge, Button, Card, Dialog, EmptyState, Input, Select, Textarea, cn } from '@crew/ui';
import { Check, CheckCheck, CheckCircle2, Headset, Plus, RotateCcw, Search, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRefreshOn } from '@/components/live';
import { readSupportAction, sendSupportAction, startSupportAction, supportStatusAction } from './actions';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const listWhen = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? time(iso) : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
const STATE_TONE: Record<SupportState, 'info' | 'warning' | 'success' | 'neutral'> = { unread: 'info', waiting: 'success', replied: 'warning', resolved: 'neutral' };
/**
 * Seen from the workspace: "replied" means your side wrote last, so SampCrew owes the answer; "waiting" means the
 * Console team wrote last (answered, read).
 */
const STATE_LABEL: Record<SupportState, string> = { ...SUPPORT_STATE_LABEL, replied: 'Waiting for SampCrew', waiting: 'Answered' };
const FILTERS: [SupportState | 'all', string][] = [['all', 'All'], ['unread', 'Unread'], ['replied', 'Waiting for SampCrew'], ['waiting', 'Answered'], ['resolved', 'Resolved']];

/** SampCrew Support for the Super Workspace: its conversations with the Console Admin team, and one open thread. */
export function SupportApp({ list, detail, startNew, me }: { list: SupportConversationView[]; detail: SupportConversationDetail | null; startNew: boolean; me: string }) {
  useRefreshOn(['support.message', 'support.read', 'support.changed']);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<SupportState | 'all'>('all');
  const [newOpen, setNewOpen] = useState(startNew);
  const needle = q.trim().toLowerCase();
  const shown = list.filter((c) => (filter === 'all' || c.state === filter) && (!needle || [c.subject, c.lastMessage?.body, `#${c.number}`].some((f) => (f ?? '').toLowerCase().includes(needle))));
  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <Card className={cn('flex min-h-[32rem] flex-col p-0', detail && 'hidden lg:flex')}>
        <div className="grid gap-2 border-b border-border p-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-fg-subtle" aria-hidden />
              <Input aria-label="Search support conversations" placeholder="Search subject or message" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8" />
            </div>
            <Button size="sm" onClick={() => setNewOpen(true)} aria-label="New support conversation"><Plus className="size-3.5" /> New</Button>
          </div>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Show">
            {FILTERS.map(([k, label]) => (
              <button key={k} role="radio" aria-checked={filter === k} onClick={() => setFilter(k)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', filter === k ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-fg-muted hover:text-fg')}>{label}</button>
            ))}
          </div>
        </div>
        <ul className="flex-1 divide-y divide-border overflow-y-auto" aria-label="Support conversations" data-testid="support-list">
          {shown.map((c) => (
            <li key={c.id}>
              <Link href={`/support/${c.id}`} aria-current={detail?.conversation.id === c.id ? 'page' : undefined} data-testid="support-item" className={cn('flex gap-3 px-3 py-2.5 hover:bg-bg-subtle', detail?.conversation.id === c.id && 'bg-accent-subtle/50', c.unread > 0 && 'bg-accent-subtle/25')}>
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent" aria-hidden><Headset className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn('truncate text-[0.8125rem]', c.unread ? 'font-semibold text-fg' : 'font-medium')}>{c.subject}</span>
                    {c.lastMessage && <span className="shrink-0 text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{listWhen(c.lastMessage.at)}</span>}
                  </span>
                  <span className="block truncate text-[0.6875rem] text-fg-subtle">SampCrew Support · Console Admin · #{c.number}</span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-fg-muted">{c.lastMessage ? `${c.lastMessage.senderName.split(' ')[0]}: ${c.lastMessage.body}` : SUPPORT_CATEGORY_LABEL[c.category]}</span>
                    {c.unread > 0 ? <span className="shrink-0 rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg" data-testid="support-unread">{c.unread}</span> : <Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {!shown.length && <li><EmptyState icon={<Headset className="size-5" />} title={list.length ? 'No conversations match' : 'No conversations yet'} description="Ask the SampCrew Console Admin team anything about SampCrew: a question, a technical issue or your account." /></li>}
        </ul>
      </Card>
      {detail ? <Thread key={detail.conversation.id} d={detail} me={me} /> : (
        <Card className="hidden min-h-[32rem] items-center justify-center lg:flex">
          <EmptyState icon={<Headset className="size-5" />} title="Contact SampCrew Support" description="Choose a conversation or start a new one. The Console Admin team answers here, and you are notified when they reply." action={<Button size="sm" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New conversation</Button>} />
        </Card>
      )}
      <NewSupport open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function Delivery({ m }: { m: SupportMessageView }) {
  if (!m.delivery) return null;
  const label = m.delivery === 'read' ? 'Read' : m.delivery === 'delivered' ? 'Delivered' : 'Sent';
  const Icon = m.delivery === 'sent' ? Check : CheckCheck;
  return <span className={cn('inline-flex items-center gap-0.5', m.delivery === 'read' ? 'text-accent' : 'text-fg-subtle')} data-testid="message-delivery" title={label}><Icon className="size-3" aria-hidden />{label}</span>;
}

/** One message: who sent it (name, level, workspace), the text, the time and, on your side's messages, the ticks. */
export function SupportMessage({ m }: { m: SupportMessageView }) {
  if (m.system) return <p className="text-center text-xs italic text-fg-muted" data-testid="system-message">{m.body}</p>;
  return (
    <div className={cn('flex max-w-[85%] gap-2', m.ourSide ? 'flex-row-reverse justify-self-end' : 'justify-self-start')} data-testid="message">
      <Avatar name={m.sender.name} size={28} />
      <div className={cn('flex min-w-0 flex-col', m.ourSide ? 'items-end' : 'items-start')}>
        <span className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[0.6875rem]" data-testid="message-sender">
          <span className="font-semibold text-fg">{m.mine ? 'You' : m.sender.name}</span>
          <Badge tone={m.fromConsole ? 'ember' : 'info'}>{m.sender.levelLabel}</Badge>
          {m.sender.workspace && <span className="text-fg-subtle">{m.sender.workspace}</span>}
        </span>
        <div className={cn('rounded-2xl px-3 py-2 text-[0.8125rem]', m.ourSide ? 'rounded-tr-sm bg-accent text-accent-fg' : 'rounded-tl-sm bg-bg-subtle text-fg')}>
          <span className="whitespace-pre-wrap break-words">{m.body}</span>
        </div>
        <span className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-fg-subtle">
          <span suppressHydrationWarning>{time(m.createdAt)}</span>
          <Delivery m={m} />
        </span>
      </div>
    </div>
  );
}

function Thread({ d, me }: { d: SupportConversationDetail; me: string }) {
  const router = useRouter();
  const c = d.conversation;
  const [sent, setSent] = useState<SupportMessageView[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => [...d.messages, ...sent.filter((s) => !d.messages.some((m) => m.id === s.id))], [d.messages, sent]);
  const lastId = messages.at(-1)?.id;
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lastId]);
  // Opening the conversation reads it: clears its unread count and notification, and the Console team sees Read.
  useEffect(() => {
    if (c.unread > 0 || messages.some((m) => m.fromConsole)) void readSupportAction(c.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, lastId]);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setError(null);
    start(async () => {
      const r = await sendSupportAction(c.id, body, crypto.randomUUID());
      if (r.ok) { setSent((cur) => [...cur, r.data!]); setText(''); router.refresh(); } else setError(r.message);
    });
  };
  const setStatus = (status: 'open' | 'resolved') => start(async () => { const r = await supportStatusAction(c.id, status); if (!r.ok) setError(r.message); router.refresh(); });
  let lastDay = '';
  void me;
  return (
    <Card className="flex min-h-[32rem] flex-col p-0" data-testid="support-thread">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <Link href="/support" className="text-xs text-fg-muted lg:hidden">← Support conversations</Link>
          <h2 className="truncate text-sm font-semibold" data-testid="thread-title">{c.subject}</h2>
          <p className="truncate text-xs text-fg-muted">#{c.number} · {SUPPORT_CATEGORY_LABEL[c.category]} · Private between {c.workspace.name} (Super Workspace) and SampCrew Support (Console Admin)</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>
          {c.status === 'open'
            ? <Button size="sm" variant="ghost" onClick={() => setStatus('resolved')} disabled={pending}><CheckCircle2 className="size-3.5" /> Mark resolved</Button>
            : <Button size="sm" variant="ghost" onClick={() => setStatus('open')} disabled={pending}><RotateCcw className="size-3.5" /> Reopen</Button>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite" data-testid="messages">
        {d.hasOlder && <p className="mb-2 text-center text-xs text-fg-subtle">Older messages are not shown.</p>}
        <ul className="grid gap-2.5">
          {messages.map((m) => {
            const d0 = day(m.createdAt);
            const sep = d0 !== lastDay;
            lastDay = d0;
            return (
              <li key={m.id} className="grid">
                {sep && <div className="my-2 text-center text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{d0}</div>}
                <SupportMessage m={m} />
              </li>
            );
          })}
        </ul>
        <div ref={endRef} />
      </div>
      <div className="border-t border-border p-3">
        {error && <div className="mb-2"><Alert tone="danger">{error}</Alert></div>}
        {c.status === 'resolved' && <p className="mb-2 text-xs text-fg-muted">This conversation is resolved. Writing again reopens it.</p>}
        <div className="flex items-end gap-2">
          <Textarea aria-label="Message" placeholder="Write to SampCrew Support. Enter sends, Shift+Enter adds a line." value={text} rows={1} maxLength={4000} onChange={(e) => setText(e.target.value)} className="min-h-9 flex-1" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <Button size="sm" onClick={send} loading={pending} disabled={!text.trim()} aria-label="Send"><Send className="size-4" /></Button>
        </div>
      </div>
    </Card>
  );
}

function NewSupport({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<string>('question');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const clientId = useMemo(() => (open ? crypto.randomUUID() : ''), [open]);
  const go = () => start(async () => {
    setError(null);
    const r = await startSupportAction({ subject: subject.trim(), category, body: body.trim(), clientId });
    if (r.ok) { onClose(); setSubject(''); setBody(''); router.push(`/support/${r.data!.id}`); } else setError(r.message);
  });
  return (
    <Dialog open={open} onClose={onClose} title="Contact SampCrew Support" footer={<Button loading={pending} disabled={subject.trim().length < 3 || !body.trim()} onClick={go}><Send className="size-3.5" /> Send to Console Admin</Button>}>
      <div className="grid gap-3">
        <p className="text-[0.8125rem] text-fg-muted">Your message goes to the SampCrew Console Admin team. Only your company&apos;s Super Workspace and the Console Admin team can read this conversation.</p>
        <Input aria-label="Subject" placeholder="Subject, for example Attendance report shows zero" value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
        <Select aria-label="Topic" value={category} onChange={(e) => setCategory(e.target.value)}>
          {SUPPORT_CATEGORIES.map((k) => <option key={k} value={k}>{SUPPORT_CATEGORY_LABEL[k]}</option>)}
        </Select>
        <Textarea aria-label="Your message" placeholder="Describe what you need help with" value={body} rows={5} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}


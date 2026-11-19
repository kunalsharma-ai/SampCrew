'use client';
import type { ChatMessageView, CommFile, ConversationView } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Input, Select, Textarea, cn } from '@crew/ui';
import { BellOff, Check, CheckCheck, FileText, Headset, LogOut, MessagesSquare, Paperclip, Plus, Search, Send, Trash2, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRefreshOn } from '@/components/live';
import {
  deleteMessageAction, leaveConversationAction, manageConversationAction, markReadAction, muteAction, openConversationAction,
  searchMessagesAction, sendMessageAction, uploadFileAction,
} from '../actions';
import { PeoplePicker } from '../people-picker';
import type { ConversationDetail, Person } from '../types';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const listWhen = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? time(iso) : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
const KIND_ICON = { direct: MessagesSquare, group: Users, department: Users, hr: Headset } as const;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function ChatApp({ list, detail, isHr, departments, startNew, me }: {
  list: ConversationView[];
  detail: ConversationDetail | null;
  isHr: boolean;
  departments: { id: string; name: string }[];
  startNew: boolean;
  me: string;
}) {
  // New messages, read receipts and deletions show without reloading.
  useRefreshOn(['chat.message', 'chat.read', 'chat.updated']);
  const [filter, setFilter] = useState('');
  const [newOpen, setNewOpen] = useState(startNew);
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchMessagesAction>> | null>(null);
  const [searching, startSearch] = useTransition();
  const shown = list.filter((c) => !filter || c.title.toLowerCase().includes(filter.toLowerCase()) || c.members.some((m) => (m.name ?? '').toLowerCase().includes(filter.toLowerCase())));

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
      <Card className={cn('flex min-h-[32rem] flex-col p-0', detail && 'hidden lg:flex')}>
        <div className="flex items-center gap-2 border-b border-border p-3">
          <form className="relative flex-1" onSubmit={(e) => { e.preventDefault(); if (filter.trim().length >= 2) startSearch(async () => setHits(await searchMessagesAction(filter.trim()))); }}>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-3.5 text-fg-subtle" aria-hidden />
            <Input aria-label="Search conversations and messages" placeholder="Search (Enter for messages)" value={filter} onChange={(e) => { setFilter(e.target.value); setHits(null); }} className="h-8 pl-8" />
          </form>
          <Button size="sm" onClick={() => setNewOpen(true)} aria-label="New conversation"><Plus className="size-3.5" /> New</Button>
        </div>
        {hits && (
          <div className="border-b border-border p-3" data-testid="message-search-results">
            <div className="mb-1 flex items-center justify-between text-xs font-semibold text-fg-muted">Messages <button onClick={() => setHits(null)} aria-label="Close search"><X className="size-3.5" /></button></div>
            {!hits.ok ? <p className="text-xs text-danger">{hits.message}</p> : hits.data!.items.length === 0 ? <p className="text-xs text-fg-muted">No messages found.</p> : (
              <ul className="grid gap-1">
                {hits.data!.items.map((h) => (
                  <li key={h.messageId}><Link href={`/communication/chat/${h.conversationId}`} className="block rounded-md px-2 py-1 text-xs hover:bg-bg-subtle"><span className="font-semibold">{h.conversationTitle}</span> · {h.senderName}: <span className="text-fg-muted">{h.body.slice(0, 80)}</span></Link></li>
                ))}
              </ul>
            )}
          </div>
        )}
        {searching && <p className="px-3 py-2 text-xs text-fg-muted">Searching…</p>}
        <ul className="flex-1 divide-y divide-border overflow-y-auto" aria-label="Conversations" data-testid="conversation-list">
          {shown.map((c) => {
            const Icon = KIND_ICON[c.kind];
            return (
              <li key={c.id}>
                <Link href={`/communication/chat/${c.id}`} aria-current={detail?.conversation.id === c.id ? 'page' : undefined} data-testid="conversation-item" className={cn('flex gap-3 px-3 py-2.5 hover:bg-bg-subtle', detail?.conversation.id === c.id && 'bg-accent-subtle/50')}>
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent" aria-hidden><Icon className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn('truncate text-[0.8125rem]', c.unread ? 'font-semibold text-fg' : 'font-medium')}>{c.title}</span>
                      {c.lastMessage && <span className="shrink-0 text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{listWhen(c.lastMessage.at)}</span>}
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-fg-muted">{c.lastMessage ? `${c.lastMessage.senderName ? `${c.lastMessage.senderName.split(' ')[0]}: ` : ''}${c.lastMessage.body}` : c.subtitle}</span>
                      {c.muted && <BellOff className="size-3 shrink-0 text-fg-subtle" aria-label="Muted" />}
                      {c.unread > 0 && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg" data-testid="conversation-unread">{c.unread}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
          {!shown.length && <li><EmptyState icon={<MessagesSquare className="size-5" />} title={filter ? 'No conversations match' : 'No conversations yet'} description={isHr ? 'Start one with a person, a group or a whole department.' : 'Message a colleague, start a group, or write to HR.'} /></li>}
        </ul>
      </Card>
      {detail ? <Thread key={detail.conversation.id} d={detail} me={me} /> : (
        <Card className="hidden min-h-[32rem] items-center justify-center lg:flex">
          <EmptyState icon={<MessagesSquare className="size-5" />} title="Choose a conversation" description="Or start a new one. Messages arrive here as they are sent." action={<Button size="sm" onClick={() => setNewOpen(true)}><Plus className="size-3.5" /> New conversation</Button>} />
        </Card>
      )}
      <NewConversation open={newOpen} onClose={() => setNewOpen(false)} isHr={isHr} departments={departments} />
    </div>
  );
}

function Delivery({ m }: { m: ChatMessageView }) {
  if (!m.delivery) return null;
  const label = m.delivery === 'read' ? 'Read' : m.delivery === 'delivered' ? 'Delivered' : 'Sent';
  const Icon = m.delivery === 'sent' ? Check : CheckCheck;
  return <span className={cn('inline-flex items-center gap-0.5', m.delivery === 'read' ? 'text-accent' : 'text-fg-subtle')} data-testid="message-delivery" title={label}><Icon className="size-3" aria-hidden />{label}</span>;
}

function Files({ files, mine }: { files: CommFile[]; mine: boolean }) {
  if (!files.length) return null;
  return (
    <ul className="mt-1 grid gap-1">
      {files.map((f) => (
        <li key={f.id}>
          <a href={f.href} className={cn('inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs', mine ? 'border-accent-fg/30 text-accent-fg' : 'border-border text-fg hover:bg-bg-subtle')} data-testid="message-file">
            <FileText className="size-3.5 shrink-0" aria-hidden /><span className="truncate">{f.name}</span><span className="shrink-0 opacity-70">{size(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Thread({ d, me }: { d: ConversationDetail; me: string }) {
  const router = useRouter();
  const c = d.conversation;
  const [sent, setSent] = useState<ChatMessageView[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<CommFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [manage, setManage] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Messages sent here show at once; the server's copy replaces them on the next refresh.
  const messages = useMemo(() => [...d.messages, ...sent.filter((s) => !d.messages.some((m) => m.id === s.id))], [d.messages, sent]);
  const lastId = messages.at(-1)?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);
  // Reading the conversation clears its unread count and tells the others.
  useEffect(() => {
    if (c.unread > 0 || messages.some((m) => m.senderMembershipId && m.senderMembershipId !== me && !m.system)) void markReadAction(c.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id, lastId]);

  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setError(null);
    setUploading(true);
    try {
      for (const f of Array.from(list).slice(0, 5 - files.length)) {
        const fd = new FormData();
        fd.set('file', f);
        const r = await uploadFileAction(fd);
        if (r.ok) setFiles((cur) => [...cur, r.data!]);
        else setError(`${f.name}: ${r.message}`);
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const send = () => {
    const body = text.trim();
    if (!body && !files.length) return;
    setError(null);
    start(async () => {
      const r = await sendMessageAction(c.id, body, files.map((f) => f.id), crypto.randomUUID());
      if (r.ok) {
        setSent((cur) => [...cur, r.data!]);
        setText('');
        setFiles([]);
        router.refresh();
      } else setError(r.message);
    });
  };

  let lastDay = '';
  return (
    <Card className="flex min-h-[32rem] flex-col p-0" data-testid="chat-thread">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <Link href="/communication/chat" className="text-xs text-fg-muted lg:hidden">← Conversations</Link>
          <h2 className="truncate text-sm font-semibold" data-testid="thread-title">{c.title}</h2>
          <p className="truncate text-xs text-fg-muted">{c.kind === 'group' || c.kind === 'department' ? c.members.map((m) => m.name ?? 'Unnamed').join(', ') : c.subtitle}{c.asHr ? ' · You are answering for the HR team' : ''}</p>
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => start(async () => { const r = await muteAction(c.id, !c.muted); if (!r.ok) setError(r.message); router.refresh(); })}>{c.muted ? 'Unmute' : 'Mute'}</Button>
          {c.canManage && <Button size="sm" variant="ghost" onClick={() => setManage(true)}>Manage</Button>}
          {c.kind === 'group' && <Button size="sm" variant="ghost" onClick={() => start(async () => { const r = await leaveConversationAction(c.id); if (r.ok) router.push('/communication/chat'); else setError(r.message); })}><LogOut className="size-3.5" /> Leave</Button>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3" aria-live="polite" data-testid="messages">
        {d.hasOlder && <p className="mb-2 text-center text-xs text-fg-subtle">Older messages are not shown.</p>}
        {!messages.length && <p className="py-10 text-center text-[0.8125rem] text-fg-muted">{c.kind === 'hr' && !c.asHr ? 'Write to HR. Anyone in the HR team can read and answer; your manager cannot see this.' : 'No messages yet. Say hello.'}</p>}
        <ul className="grid gap-1.5">
          {messages.map((m) => {
            const mine = m.senderMembershipId === me;
            const d0 = day(m.createdAt);
            const sep = d0 !== lastDay;
            lastDay = d0;
            return (
              <li key={m.id} className="grid">
                {sep && <div className="my-2 text-center text-[0.6875rem] text-fg-subtle" suppressHydrationWarning>{d0}</div>}
                {m.system ? <p className="text-center text-xs italic text-fg-muted" data-testid="system-message">{m.body}</p> : (
                  <div className={cn('group flex max-w-[85%] flex-col', mine ? 'items-end justify-self-end' : 'items-start')} data-testid="message">
                    {!mine && c.kind !== 'direct' && <span className="mb-0.5 text-[0.6875rem] font-medium text-fg-muted">{m.senderName}</span>}
                    <div className={cn('rounded-2xl px-3 py-2 text-[0.8125rem]', mine ? 'rounded-br-sm bg-accent text-accent-fg' : 'rounded-bl-sm bg-bg-subtle text-fg', m.deleted && 'italic opacity-70')}>
                      {m.deleted ? 'Message deleted' : <span className="whitespace-pre-wrap break-words">{m.body}</span>}
                      <Files files={m.files} mine={mine} />
                    </div>
                    <span className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-fg-subtle">
                      <span suppressHydrationWarning>{time(m.createdAt)}</span>
                      {mine && <Delivery m={m} />}
                      {mine && !m.deleted && (
                        <button className="opacity-0 transition group-hover:opacity-100 focus:opacity-100" aria-label="Delete message" onClick={() => start(async () => { const r = await deleteMessageAction(c.id, m.id); if (!r.ok) setError(r.message); router.refresh(); })}><Trash2 className="size-3" /></button>
                      )}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div ref={endRef} />
      </div>
      <div className="border-t border-border p-3">
        {error && <div className="mb-2"><Alert tone="danger">{error}</Alert></div>}
        {files.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Attached files">
            {files.map((f) => <li key={f.id}><Badge>{f.name} <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.id !== f.id))}><X className="size-3" /></button></Badge></li>)}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} data-testid="chat-file-input" />
          <Button variant="ghost" size="sm" aria-label="Attach files" loading={uploading} disabled={files.length >= 5} onClick={() => fileRef.current?.click()}><Paperclip className="size-4" /></Button>
          <Textarea
            aria-label="Message" placeholder="Write a message. Enter sends, Shift+Enter adds a line." value={text} rows={1} maxLength={4000}
            onChange={(e) => setText(e.target.value)} className="min-h-9 flex-1"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <Button size="sm" onClick={send} loading={pending} disabled={uploading || (!text.trim() && !files.length)} aria-label="Send"><Send className="size-4" /></Button>
        </div>
      </div>
      {manage && <ManageDialog c={c} onClose={() => setManage(false)} />}
    </Card>
  );
}

function NewConversation({ open, onClose, isHr, departments }: { open: boolean; onClose: () => void; isHr: boolean; departments: { id: string; name: string }[] }) {
  const router = useRouter();
  const [mode, setMode] = useState<'direct' | 'group' | 'hr' | 'department'>('direct');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Person[]>([]);
  const [dept, setDept] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (body: Record<string, unknown>) => start(async () => {
    setError(null);
    const r = await openConversationAction(body);
    if (r.ok) { onClose(); router.push(`/communication/chat/${r.data!.id}`); } else setError(r.message);
  });
  type Mode = 'direct' | 'group' | 'department' | 'hr';
  const modes: [Mode, string][] = [['direct', 'Person'], ['group', 'Group'], isHr ? ['department', 'Department'] : ['hr', 'HR team']];
  return (
    <Dialog open={open} onClose={onClose} title="New conversation" footer={mode === 'group' ? <Button loading={pending} disabled={title.trim().length < 2 || !picked.length} onClick={() => go({ kind: 'group', title: title.trim(), membershipIds: picked.map((p) => p.membershipId) })}>Start group</Button> : mode === 'department' ? <Button loading={pending} disabled={!dept} onClick={() => go({ kind: 'department', departmentId: dept })}>Open department chat</Button> : mode === 'hr' ? <Button loading={pending} onClick={() => go({ kind: 'hr' })}>Message HR</Button> : undefined}>
      <div className="grid gap-3">
        <div className="flex rounded-lg bg-bg-subtle p-1" role="radiogroup" aria-label="Conversation type">
          {modes.map(([k, label]) => <button key={k} role="radio" aria-checked={mode === k} onClick={() => setMode(k)} className={cn('flex-1 rounded-md px-3 py-1 text-xs font-medium', mode === k ? 'bg-surface text-fg shadow-card' : 'text-fg-muted')}>{label}</button>)}
        </div>
        {mode === 'direct' && <PeoplePicker single selected={[]} onToggle={(p) => go({ kind: 'direct', membershipId: p.membershipId })} />}
        {mode === 'group' && (
          <>
            <Input aria-label="Group name" placeholder="Group name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
            {picked.length > 0 && <div className="flex flex-wrap gap-1">{picked.map((p) => <Badge key={p.membershipId}>{p.name}</Badge>)}</div>}
            <PeoplePicker selected={picked.map((p) => p.membershipId)} onToggle={(p) => setPicked((cur) => (cur.some((x) => x.membershipId === p.membershipId) ? cur.filter((x) => x.membershipId !== p.membershipId) : [...cur, p]))} />
          </>
        )}
        {mode === 'hr' && <p className="text-[0.8125rem] text-fg-muted">Your conversation with the HR team. Anyone in HR can read and answer it; your manager cannot. For a formal request with a reference number, use Help requests.</p>}
        {mode === 'department' && (
          <>
            <p className="text-[0.8125rem] text-fg-muted">Everyone in the department and its sub-departments is in it, and people joining or leaving the department are added or removed.</p>
            <Select aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)}><option value="">Choose a department</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>
          </>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

function ManageDialog({ c, onClose }: { c: ConversationView; onClose: () => void }) {
  const router = useRouter();
  const [title, setTitle] = useState(c.title);
  const [add, setAdd] = useState<Person[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title={`Manage ${c.title}`} footer={<Button loading={pending} onClick={() => start(async () => {
      const r = await manageConversationAction(c.id, { ...(title.trim() !== c.title ? { title: title.trim() } : {}), ...(c.kind === 'group' ? { add: add.map((p) => p.membershipId), remove } : {}) });
      if (r.ok) { onClose(); router.refresh(); } else setError(r.message);
    })}>Save</Button>}>
      <div className="grid gap-3">
        <Input aria-label="Conversation name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        {c.kind === 'group' && (
          <>
            <div className="text-xs font-medium">Members</div>
            <ul className="grid gap-1">{c.members.map((m) => (
              <li key={m.membershipId} className="flex items-center justify-between text-[0.8125rem]">
                <span className={cn(remove.includes(m.membershipId) && 'line-through opacity-60')}>{m.name}</span>
                <button className="text-xs text-danger hover:underline" onClick={() => setRemove((cur) => (cur.includes(m.membershipId) ? cur.filter((x) => x !== m.membershipId) : [...cur, m.membershipId]))}>{remove.includes(m.membershipId) ? 'Keep' : 'Remove'}</button>
              </li>
            ))}</ul>
            <div className="text-xs font-medium">Add people</div>
            <PeoplePicker selected={add.map((p) => p.membershipId)} onToggle={(p) => setAdd((cur) => (cur.some((x) => x.membershipId === p.membershipId) ? cur.filter((x) => x.membershipId !== p.membershipId) : [...cur, p]))} />
          </>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}

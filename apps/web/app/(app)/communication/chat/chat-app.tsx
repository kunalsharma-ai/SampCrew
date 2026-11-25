'use client';
import { CHAT_REACTIONS, senderLine, type ChatMessageView, type CommFile, type ConversationView } from '@crew/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Input, Select, Textarea, cn } from '@crew/ui';
import { BellOff, Check, CheckCheck, FileText, Headset, LogOut, MessagesSquare, Paperclip, Pencil, Plus, Search, Send, SmilePlus, Trash2, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRefreshOn } from '@/components/live';
import {
  deleteMessageAction, editMessageAction, leaveConversationAction, reactAction, restoreMessageAction, manageConversationAction, markReadAction, muteAction, openConversationAction,
  searchMessagesAction, sendMessageAction, uploadFileAction,
} from '../actions';
import { PeoplePicker } from '../people-picker';
import type { ConversationDetail, Person } from '../types';

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const listWhen = (iso: string) => (new Date(iso).toDateString() === new Date().toDateString() ? time(iso) : new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
const KIND_ICON = { direct: MessagesSquare, group: Users, department: Users, hr: Headset } as const;
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

type ChatFilter = 'all' | 'unread' | 'direct' | 'groups' | 'hr';
const FILTERS: [ChatFilter, string][] = [['all', 'All'], ['unread', 'Unread'], ['direct', 'Direct'], ['groups', 'Groups'], ['hr', 'HR']];
const inFilter = (c: ConversationView, f: ChatFilter) => f === 'all' || (f === 'unread' ? c.unread > 0 : f === 'direct' ? c.kind === 'direct' : f === 'groups' ? c.kind === 'group' || c.kind === 'department' : c.kind === 'hr');

export function ChatApp({ list, detail, isHr, departments, startNew, me, support }: {
  list: ConversationView[];
  detail: ConversationDetail | null;
  isHr: boolean;
  departments: { id: string; name: string }[];
  startNew: boolean;
  me: string;
  /** Super Workspace only: the pinned SampCrew Support entry, with its unread replies. */
  support?: { unread: number } | null;
}) {
  // New messages, read receipts and deletions show without reloading.
  useRefreshOn(['chat.message', 'chat.read', 'chat.updated']);
  const [filter, setFilter] = useState('');
  const [newOpen, setNewOpen] = useState(startNew);
  const [hits, setHits] = useState<Awaited<ReturnType<typeof searchMessagesAction>> | null>(null);
  const [searching, startSearch] = useTransition();
  const [kind, setKind] = useState<ChatFilter>('all');
  const needle = filter.toLowerCase();
  // Search matches names, levels and workspaces, so two people with similar names are told apart.
  const shown = list.filter((c) => inFilter(c, kind) && (!filter || [c.title, c.subtitle, ...c.members.flatMap((m) => [m.name, m.identity?.workspace, m.identity?.levelLabel])].some((f) => (f ?? '').toLowerCase().includes(needle))));

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
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-2" role="radiogroup" aria-label="Show conversations">
          {FILTERS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={cn('rounded-full border px-2.5 py-0.5 text-xs', kind === k ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-fg-muted hover:text-fg')}>{label}</button>
          ))}
        </div>
        {support && (
          <Link href="/support" className="flex items-center gap-3 border-b border-border bg-ember-subtle/40 px-3 py-2.5 hover:bg-bg-subtle" data-testid="support-entry">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ember-subtle text-ember" aria-hidden><Headset className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.8125rem] font-semibold">SampCrew Support</span>
              <span className="block truncate text-xs text-fg-muted">Console Admin · Private to the Super Workspace</span>
            </span>
            {support.unread > 0 && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg">{support.unread}</span>}
          </Link>
        )}
        {hits && (
          <div className="border-b border-border p-3" data-testid="message-search-results">
            <div className="mb-1 flex items-center justify-between text-xs font-semibold text-fg-muted">Messages <button onClick={() => setHits(null)} aria-label="Close search"><X className="size-3.5" /></button></div>
            {!hits.ok ? <p className="text-xs text-danger">{hits.message}</p> : hits.data!.items.length === 0 ? <p className="text-xs text-fg-muted">No messages found.</p> : (
              <ul className="grid gap-1">
                {hits.data!.items.map((h) => (
                  <li key={h.messageId}><Link href={`/communication/chat/${h.conversationId}`} className="block rounded-md px-2 py-1 text-xs hover:bg-bg-subtle"><span className="font-semibold">{h.conversationTitle}</span> · {h.senderName}{h.sender ? <span className="text-fg-subtle"> ({senderLine(h.sender)})</span> : null}: <span className="text-fg-muted">{h.body.slice(0, 80)}</span></Link></li>
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
                    {c.subtitle && c.lastMessage && <span className="block truncate text-[0.6875rem] text-fg-subtle" data-testid="conversation-identity">{c.subtitle}</span>}
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

/** Who sent a message: name, level badge and workspace, so the reader never has to guess. */
function SenderTag({ m }: { m: ChatMessageView }) {
  if (!m.sender) return m.senderName ? <span className="mb-0.5 text-[0.6875rem] font-medium text-fg-muted">{m.senderName}</span> : null;
  return (
    <span className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[0.6875rem]" data-testid="message-sender">
      <span className="font-semibold text-fg">{m.sender.name}</span>
      <Badge tone={m.sender.level === 'super' ? 'ember' : m.sender.level === 'hr' ? 'info' : 'neutral'}>{m.sender.levelLabel}</Badge>
      {m.sender.workspace && <span className="text-fg-subtle">{m.sender.workspace}</span>}
    </span>
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
          <p className="truncate text-xs text-fg-muted" data-testid="thread-identity">{c.kind === 'group' || c.kind === 'department' ? c.members.map((m) => (m.identity ? `${m.name ?? 'Unnamed'} (${m.identity.levelLabel})` : m.name ?? 'Unnamed')).join(', ') : c.subtitle}{c.asHr ? ' · You are answering for the HR team' : ''}</p>
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
                  <MessageItem m={m} mine={mine} conversationId={c.id} onError={setError} />
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

/**
 * One message with its actions (issue #86): hover or tap a message for React, Edit (your own, for
 * CHAT_EDIT_MINUTES) and Delete (your own, or anyone's for HR, after a confirmation); a delete can be undone for
 * CHAT_UNDO_SECONDS. Edited messages say so. Everything updates live for everyone in the conversation.
 */
function MessageItem({ m, mine, conversationId, onError }: { m: ChatMessageView; mine: boolean; conversationId: string; onError: (e: string | null) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [confirming, setConfirming] = useState(false);
  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) => start(async () => {
    onError(null);
    const r = await fn();
    if (!r.ok) onError(r.message ?? 'Something went wrong');
    router.refresh();
  });
  const react = (emoji: string) => { setPicking(false); run(() => reactAction(conversationId, m.id, emoji)); };
  const saveEdit = () => {
    const body = draft.trim();
    if (!body) return;
    run(async () => { const r = await editMessageAction(conversationId, m.id, body); if (r.ok) setEditing(false); return r; });
  };
  const showActions = !m.deleted && !editing;
  return (
    <div className={cn('group relative flex max-w-[85%] flex-col', mine ? 'items-end justify-self-end' : 'items-start')} data-testid="message" onMouseLeave={() => { setPicking(false); }}>
      {!mine && <SenderTag m={m} />}
      {editing ? (
        <div className="grid w-[min(28rem,80vw)] gap-1.5" data-testid="message-edit">
          <Textarea aria-label="Edit message" value={draft} rows={2} maxLength={4000} onChange={(e) => setDraft(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); } if (e.key === 'Escape') { setEditing(false); setDraft(m.body); } }} />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraft(m.body); }}>Cancel</Button>
            <Button size="sm" onClick={saveEdit} loading={pending} disabled={!draft.trim()} data-testid="message-edit-save">Save</Button>
          </div>
        </div>
      ) : (
        <div
          role="button" tabIndex={0} aria-label={m.deleted ? 'Deleted message' : 'Message actions'} aria-expanded={open}
          onClick={() => setOpen((v) => !v)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
          className={cn('cursor-default rounded-2xl px-3 py-2 text-left text-[0.8125rem] outline-none focus-visible:ring-2 focus-visible:ring-accent', mine ? 'rounded-br-sm bg-accent text-accent-fg' : 'rounded-bl-sm bg-bg-subtle text-fg', m.deleted && 'italic opacity-70')}
        >
          {m.deleted ? 'Message deleted' : <span className="whitespace-pre-wrap break-words" data-testid="message-body">{m.body}</span>}
          <Files files={m.files} mine={mine} />
        </div>
      )}
      {showActions && (
        <div className={cn('absolute -top-3 z-10 flex items-center gap-0.5 rounded-full border border-border bg-surface-raised p-0.5 shadow-card transition-opacity', mine ? 'right-2' : 'left-2', open || picking ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100')} data-testid="message-actions">
          <button type="button" className="rounded-full p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg" aria-label="React" aria-expanded={picking} onClick={() => setPicking((v) => !v)} data-testid="message-react"><SmilePlus className="size-3.5" /></button>
          {m.canEdit && <button type="button" className="rounded-full p-1 text-fg-muted hover:bg-bg-subtle hover:text-fg" aria-label="Edit message" onClick={() => { setDraft(m.body); setEditing(true); setOpen(false); }} data-testid="message-edit-start"><Pencil className="size-3.5" /></button>}
          {m.canDelete && <button type="button" data-delete-area="communication" data-delete="chat message" className="rounded-full p-1 text-fg-muted hover:bg-danger-subtle hover:text-danger" aria-label="Delete message" onClick={() => { setConfirming(true); setOpen(false); }}><Trash2 className="size-3.5" /></button>}
        </div>
      )}
      {picking && (
        <div className={cn('absolute -top-11 z-20 flex gap-0.5 rounded-full border border-border bg-surface-raised p-1 shadow-pop', mine ? 'right-2' : 'left-2')} role="group" aria-label="Choose a reaction" data-testid="reaction-picker">
          {CHAT_REACTIONS.map((e) => <button key={e} type="button" className="rounded-full px-1.5 py-0.5 text-base leading-none transition-transform hover:scale-125 hover:bg-bg-subtle" aria-label={`React with ${e}`} onClick={() => react(e)}>{e}</button>)}
        </div>
      )}
      {confirming && (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-danger/40 bg-danger-subtle/50 px-2.5 py-1.5 text-xs" role="alertdialog" aria-label="Delete this message?" data-testid="message-delete-confirm">
          <span>{mine ? 'Delete this message for everyone?' : 'Delete this message from the conversation?'}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button size="sm" variant="danger" loading={pending} data-testid="message-delete-yes" onClick={() => run(async () => { const r = await deleteMessageAction(conversationId, m.id); setConfirming(false); return r; })}>Delete</Button>
        </div>
      )}
      {m.reactions.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1" aria-label="Reactions" data-testid="message-reactions">
          {m.reactions.map((r) => (
            <li key={r.emoji}>
              <button type="button" onClick={() => react(r.emoji)} title={r.names.join(', ')} aria-pressed={r.mine} aria-label={`${r.emoji} ${r.count}${r.mine ? ', including you' : ''}`}
                className={cn('inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-xs', r.mine ? 'border-accent bg-accent-subtle text-accent' : 'border-border bg-surface hover:bg-bg-subtle')}>
                <span>{r.emoji}</span><span className="tabular">{r.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-fg-subtle">
        <span suppressHydrationWarning>{time(m.createdAt)}</span>
        {m.editedAt && !m.deleted && <span data-testid="message-edited" title={`Edited ${time(m.editedAt)}`}>Edited</span>}
        {mine && <Delivery m={m} />}
        {m.canUndo && <button type="button" className="font-semibold text-accent hover:underline" onClick={() => run(() => restoreMessageAction(conversationId, m.id))} data-testid="message-undo">Undo</button>}
      </span>
    </div>
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

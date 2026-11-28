'use client';
import type { ChatMessageView, ConversationView } from '@crew/contracts';
import { Avatar, cn } from '@crew/ui';
import { ArrowLeft, Maximize2, MessageCircle, PenSquare, Search, Send, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { markReadAction, openConversationAction, peopleAction, sendMessageAction } from '@/app/(app)/communication/actions';
import type { Person } from '@/app/(app)/communication/types';
import { widgetConversationAction, widgetConversationsAction } from '@/app/(app)/chat-widget-actions';
import { setChatWidgetOn, useOptionalLive } from './live';

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'thread'; id: string };
type Toast = { id: string; conversationId: string; title: string; body: string };

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/**
 * The small SampCrew chat in the bottom-right corner (28 November 2026, in place of the SampCrew IQ button): anyone
 * who may chat can open their conversations, start one with anyone in the company and reply without leaving the page.
 * New messages arrive live, raise the badge and show a short notice above the button. The full chat stays on
 * Communication; the widget hides itself there so the two never sit on top of each other.
 */
export function ChatWidget({ me }: { me: string }) {
  const live = useOptionalLive();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [list, setList] = useState<ConversationView[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const viewRef = useRef(view);
  const openRef = useRef(open);
  viewRef.current = view;
  openRef.current = open;
  const onChatPage = pathname.startsWith('/communication/chat');

  const refresh = useCallback(async () => {
    const r = await widgetConversationsAction();
    if (r.ok && r.data) {
      setList(r.data.items);
      setUnread(r.data.items.reduce((n, c) => n + (c.muted ? 0 : c.unread), 0));
      return r.data.items;
    }
    return null;
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    setChatWidgetOn(!onChatPage);
    return () => setChatWidgetOn(false);
  }, [onChatPage]);

  useEffect(() => {
    if (!live) return;
    const offs = [
      live.on('chat.message', (d: { conversationId: string; senderMembershipId: string | null }) => {
        void refresh().then((items) => {
          if (!d || d.senderMembershipId === me) return;
          const showing = openRef.current && viewRef.current.kind === 'thread' && viewRef.current.id === d.conversationId;
          const c = items?.find((x) => x.id === d.conversationId);
          if (showing || !c || c.muted || window.location.pathname.startsWith('/communication/chat')) return;
          setToast({ id: `${d.conversationId}-${Date.now()}`, conversationId: c.id, title: c.lastMessage?.senderName ?? c.title, body: c.lastMessage?.body ?? 'New message' });
        });
      }),
      live.on('chat.read', () => void refresh()),
    ];
    return () => offs.forEach((o) => o());
  }, [live, me, refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7000);
    return () => clearTimeout(t);
  }, [toast]);

  if (onChatPage) return null;

  const openThread = (id: string) => { setToast(null); setOpen(true); setView({ kind: 'thread', id }); };

  return (
    <div className="print:hidden" data-testid="chat-widget">
      {toast && !open && (
        <button
          type="button"
          onClick={() => openThread(toast.conversationId)}
          data-testid="chat-toast"
          className="crew-chat-toast fixed bottom-[5.25rem] right-5 z-40 flex w-[19rem] max-w-[calc(100vw-2.5rem)] items-start gap-3 rounded-2xl border border-accent/30 bg-surface p-3 text-left shadow-pop animate-slide-up"
          aria-live="polite"
        >
          <span className="relative shrink-0">
            <Avatar name={toast.title} size={36} />
            <span className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-surface bg-accent" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[0.6875rem] font-semibold uppercase tracking-wider text-accent">New message</span>
            <span className="block truncate text-[0.8125rem] font-semibold text-fg">{toast.title}</span>
            <span className="line-clamp-2 text-[0.8125rem] text-fg-muted">{toast.body}</span>
          </span>
          <span role="presentation" onClick={(e) => { e.stopPropagation(); setToast(null); }} className="rounded p-0.5 text-fg-subtle hover:text-fg"><X className="size-3.5" aria-hidden /></span>
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label="SampCrew chat"
          data-testid="chat-panel"
          className="fixed bottom-[5.25rem] right-5 z-40 flex h-[32rem] max-h-[calc(100dvh-7rem)] w-[23rem] max-w-[calc(100vw-2.5rem)] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-pop animate-slide-up"
        >
          <header className="flex items-center gap-2 bg-gradient-to-r from-glow-1 to-glow-2 px-3 py-2.5 text-white">
            {view.kind !== 'list' && (
              <button type="button" onClick={() => { setView({ kind: 'list' }); void refresh(); }} aria-label="Back to conversations" className="rounded-md p-1 hover:bg-white/15"><ArrowLeft className="size-4" /></button>
            )}
            <span className="flex size-7 items-center justify-center rounded-lg bg-white/20"><MessageCircle className="size-4" aria-hidden /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.875rem] font-semibold leading-5">{view.kind === 'thread' ? (list?.find((c) => c.id === view.id)?.title ?? 'Conversation') : view.kind === 'new' ? 'New chat' : 'SampCrew chat'}</span>
              <span className="block truncate text-[0.6875rem] leading-4 opacity-85">{view.kind === 'thread' ? (list?.find((c) => c.id === view.id)?.subtitle ?? 'Messages arrive live') : 'Chat with anyone in your company'}</span>
            </span>
            {view.kind === 'list' && <button type="button" onClick={() => setView({ kind: 'new' })} aria-label="Start a new chat" data-testid="chat-new" className="rounded-md p-1.5 hover:bg-white/15"><PenSquare className="size-4" /></button>}
            <Link href={view.kind === 'thread' ? `/communication/chat/${view.id}` : '/communication/chat'} onClick={() => setOpen(false)} aria-label="Open the full chat" className="rounded-md p-1.5 hover:bg-white/15"><Maximize2 className="size-4" /></Link>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close chat" className="rounded-md p-1.5 hover:bg-white/15"><X className="size-4" /></button>
          </header>
          {view.kind === 'list' && <ConversationListView list={list} onOpen={openThread} onNew={() => setView({ kind: 'new' })} />}
          {view.kind === 'new' && <NewChat onOpened={(id) => { void refresh(); openThread(id); }} />}
          {view.kind === 'thread' && <Thread key={view.id} id={view.id} me={me} onRead={() => void refresh()} />}
        </section>
      )}

      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setToast(null); if (!open) void refresh(); }}
        aria-expanded={open}
        aria-label={unread ? `SampCrew chat, ${unread} unread` : 'SampCrew chat'}
        title="SampCrew chat"
        data-testid="chat-launcher"
        className="crew-chat-launcher fixed bottom-5 right-5 z-40 flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-glow-1 to-glow-2 text-white shadow-pop ring-4 ring-surface transition-transform duration-150 hover:scale-105"
      >
        {open ? <X className="size-5" aria-hidden /> : <MessageCircle className="size-5" aria-hidden />}
        {unread > 0 && !open && (
          <span data-testid="chat-unread" className="absolute -right-1 -top-1 min-w-5 rounded-full border-2 border-surface bg-danger px-1 text-center text-[0.625rem] font-bold leading-4 text-white tabular">{unread > 99 ? '99+' : unread}</span>
        )}
      </button>
    </div>
  );
}

function ConversationListView({ list, onOpen, onNew }: { list: ConversationView[] | null; onOpen: (id: string) => void; onNew: () => void }) {
  const [q, setQ] = useState('');
  if (!list) return <div className="flex flex-1 items-center justify-center text-[0.8125rem] text-fg-subtle">Loading…</div>;
  const shown = list.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="m-2 flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-[0.8125rem]">
        <Search className="size-3.5 text-fg-subtle" aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" className="min-w-0 flex-1 bg-transparent outline-none" />
      </label>
      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br from-glow-1/20 to-glow-2/20 text-accent"><MessageCircle className="size-6" aria-hidden /></span>
          <p className="text-[0.8125rem] text-fg-muted">{list.length ? 'No conversation matches.' : 'No conversations yet. Start one with anyone in your company.'}</p>
          <button type="button" onClick={onNew} className="rounded-lg bg-accent px-3 py-1.5 text-[0.8125rem] font-medium text-accent-fg hover:bg-accent-hover">Start a chat</button>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-testid="chat-conversations">
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onOpen(c.id)} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-bg-subtle">
                <Avatar name={c.title} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn('min-w-0 flex-1 truncate text-[0.8125rem]', c.unread ? 'font-semibold text-fg' : 'font-medium text-fg')}>{c.title}</span>
                    {c.lastMessage && <span className="shrink-0 text-[0.6875rem] text-fg-subtle">{ago(c.lastMessage.at)}</span>}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={cn('min-w-0 flex-1 truncate text-[0.75rem]', c.unread ? 'text-fg' : 'text-fg-muted')}>{c.lastMessage ? `${c.lastMessage.senderName ? `${c.lastMessage.senderName.split(' ')[0]}: ` : ''}${c.lastMessage.body}` : (c.subtitle ?? 'No messages yet')}</span>
                    {c.unread > 0 && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[0.625rem] font-semibold leading-4 text-accent-fg">{c.unread}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewChat({ onOpened }: { onOpened: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const t = setTimeout(() => { void peopleAction(q).then((r) => r.ok && r.data && setPeople(r.data.items)); }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (p: Person) => start(async () => {
    const r = await openConversationAction({ kind: 'direct', membershipId: p.membershipId });
    if (r.ok && r.data) onOpened(r.data.id);
    else setError(r.ok ? 'Could not open the chat.' : r.message);
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="m-2 flex items-center gap-2 rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-[0.8125rem]">
        <Search className="size-3.5 text-fg-subtle" aria-hidden />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person by name or code" aria-label="Find a person" className="min-w-0 flex-1 bg-transparent outline-none" />
      </label>
      {error && <p role="alert" className="mx-3 mb-1 text-[0.75rem] text-danger">{error}</p>}
      <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" data-testid="chat-people">
        {people.map((p) => (
          <li key={p.membershipId}>
            <button type="button" disabled={pending} onClick={() => pick(p)} className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-bg-subtle disabled:opacity-60">
              <Avatar name={p.name} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.8125rem] font-medium text-fg">{p.name}</span>
                <span className="block truncate text-[0.6875rem] text-fg-muted">{[p.levelLabel, p.designation ?? p.department, p.workspace].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          </li>
        ))}
        {people.length === 0 && <li className="px-3 py-6 text-center text-[0.8125rem] text-fg-subtle">{q ? 'Nobody matches.' : 'Type a name to find someone.'}</li>}
      </ul>
    </div>
  );
}

function Thread({ id, me, onRead }: { id: string; me: string; onRead: () => void }) {
  const live = useOptionalLive();
  const [messages, setMessages] = useState<ChatMessageView[] | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const r = await widgetConversationAction(id);
    if (r.ok && r.data) {
      setMessages(r.data.messages);
      if (r.data.conversation.unread) { await markReadAction(id); onRead(); }
    } else if (!r.ok) setError(r.message);
  }, [id, onRead]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!live) return;
    const offs = ['chat.message', 'chat.updated', 'chat.read'].map((t) => live.on(t, (d: { conversationId?: string }) => { if (d?.conversationId === id) void load(); }));
    return () => offs.forEach((o) => o());
  }, [live, id, load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages]);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    start(async () => {
      const r = await sendMessageAction(id, body, [], `w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      if (r.ok && r.data) { setText(''); setError(null); setMessages((m) => [...(m ?? []), r.data!]); }
      else setError(r.ok ? 'Not sent.' : r.message);
    });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto bg-bg-subtle/50 px-3 py-3" data-testid="chat-messages">
        {!messages ? <p className="py-6 text-center text-[0.8125rem] text-fg-subtle">Loading…</p> : messages.length === 0 ? (
          <p className="py-6 text-center text-[0.8125rem] text-fg-subtle">No messages yet. Say hello.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {messages.map((m) => {
              const mine = m.senderMembershipId === me;
              if (m.system) return <li key={m.id} className="py-1 text-center text-[0.6875rem] text-fg-subtle">{m.body}</li>;
              return (
                <li key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                  {!mine && <span className="px-1 text-[0.6875rem] text-fg-subtle">{m.sender?.name ?? m.senderName}</span>}
                  <span className={cn('max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-[0.8125rem] leading-5', mine ? 'rounded-br-md bg-accent text-accent-fg' : 'rounded-bl-md border border-border bg-surface text-fg')}>
                    {m.deleted ? <em className="opacity-70">Message deleted</em> : m.body || (m.files.length ? `${m.files.length} file${m.files.length === 1 ? '' : 's'}` : '')}
                  </span>
                  <span className="px-1 text-[0.625rem] text-fg-subtle">{time(m.createdAt)}{mine && m.delivery ? ` · ${m.delivery}` : ''}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={end} />
      </div>
      {error && <p role="alert" className="px-3 pt-1 text-[0.75rem] text-danger">{error}</p>}
      <form className="flex items-end gap-2 border-t border-border p-2" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={1}
          maxLength={4000}
          placeholder="Write a message"
          aria-label="Write a message"
          className="max-h-24 min-h-9 min-w-0 flex-1 resize-none rounded-xl border border-border bg-bg-subtle px-3 py-2 text-[0.8125rem] outline-none focus:border-accent"
        />
        <button type="submit" disabled={pending || !text.trim()} aria-label="Send message" data-testid="chat-send" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-50"><Send className="size-4" /></button>
      </form>
    </div>
  );
}

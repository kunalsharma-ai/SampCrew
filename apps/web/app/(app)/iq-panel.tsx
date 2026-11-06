'use client';
import { IQ_SUGGESTIONS, type IqAnswer, type IqConversation } from '@crew/contracts';
import { Badge, Button, cn } from '@crew/ui';
import { ArrowLeft, ArrowRight, ExternalLink, History, Info, Plus, Send, Sparkles, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, useTransition } from 'react';
import { askIqAction, forgetIqAction, iqConversationAction, iqConversationsAction } from './iq-actions';

type Turn = { q: string; a: IqAnswer | null; error?: string };

const CONFIDENCE: Record<IqAnswer['confidence'], { label: string; tone: 'success' | 'info' | 'warning'; hint: string }> = {
  exact: { label: 'From your records', tone: 'success', hint: 'Figures read directly from the workspace, limited to what you can see.' },
  matched: { label: 'Matched articles', tone: 'info', hint: 'Help articles chosen by the words in your question. Check the source.' },
  low: { label: 'Not sure', tone: 'warning', hint: 'IQ could not tell exactly what you meant.' },
};

/** Suggestions for the page the person is on, then the general ones. */
function suggestionsFor(path: string) {
  const first = path.startsWith('/recruitment') ? ['Summarize recruitment performance this quarter', 'Prepare a draft job description for a Senior HR Manager']
    : path.startsWith('/staffing') ? ['Create a staffing proposal for five recruiters']
      : path.startsWith('/attendance') ? ['Show departments with increasing overtime']
        : path.startsWith('/leave') ? ['Who is on leave this week?', 'Leave trend for the last six months']
          : path.startsWith('/employees') ? ['Headcount by department', 'Show pending onboarding tasks'] : [];
  return [...new Set([...first, ...IQ_SUGGESTIONS])].slice(0, 6);
}

/**
 * SampCrew IQ: a side panel that answers from the workspace under the person's own permissions, says how it found the
 * answer and how sure it is, links to the source pages, and for actions shows a preview and opens a prefilled form.
 */
export function IqPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const path = usePathname();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [history, setHistory] = useState<IqConversation[] | null>(null);
  const [q, setQ] = useState('');
  const [pending, start] = useTransition();
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 50); }, [open]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const ask = (question: string) => {
    const text = question.trim();
    if (!text || pending) return;
    setQ('');
    setTurns((t) => [...t, { q: text, a: null }]);
    start(async () => {
      const r = await askIqAction(text, path, conversationId);
      if (r.ok && r.data?.conversationId) setConversationId(r.data.conversationId);
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? (r.ok && r.data ? { q: text, a: r.data } : { q: text, a: null, error: r.ok ? 'No answer' : r.message }) : x)));
    });
  };
  const fresh = () => { setTurns([]); setConversationId(null); setHistory(null); setTimeout(() => input.current?.focus(), 50); };
  const showHistory = () => start(async () => {
    const r = await iqConversationsAction();
    setHistory(r.ok && r.data ? r.data : []);
  });
  const open2 = (id: string) => start(async () => {
    const r = await iqConversationAction(id);
    if (!r.ok || !r.data) return;
    setConversationId(id);
    setTurns(r.data.messages.map((m) => ({ q: m.question, a: m.answer })));
    setHistory(null);
  });
  const forget = (id: string | null) => start(async () => {
    if (!confirm(id ? 'Delete this conversation?' : 'Delete all your SampCrew IQ conversations?')) return;
    await forgetIqAction(id);
    if (!id || id === conversationId) { setTurns([]); setConversationId(null); }
    const r = await iqConversationsAction();
    setHistory(r.ok && r.data ? r.data : []);
  });

  if (!open) return null;
  return (
    <aside role="complementary" aria-label="SampCrew IQ" className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-pop animate-slide-up sm:animate-none">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-glow-1 to-glow-2 text-white"><Sparkles className="size-4" /></span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold">SampCrew IQ</h2>
          <p className="text-xs text-fg-subtle">Answers from your workspace, within your access</p>
        </div>
        <button type="button" onClick={showHistory} className="rounded-md p-1.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="Past conversations"><History className="size-4" /></button>
        <button type="button" onClick={fresh} className="rounded-md p-1.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="New conversation"><Plus className="size-4" /></button>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="Close SampCrew IQ"><X className="size-4" /></button>
      </header>

      {history && (
        <div className="flex-1 overflow-y-auto px-4 py-4" aria-label="Past conversations">
          <div className="mb-3 flex items-center gap-2">
            <button type="button" onClick={() => setHistory(null)} className="inline-flex items-center gap-1 text-[0.8125rem] text-accent hover:underline"><ArrowLeft className="size-3.5" /> Back</button>
            <span className="flex-1" />
            {history.length > 0 && <button type="button" onClick={() => forget(null)} className="text-xs text-danger hover:underline">Delete all</button>}
          </div>
          {history.length ? (
            <ul className="grid gap-1.5">
              {history.map((c) => (
                <li key={c.id} className="flex items-center gap-1 rounded-md border border-border hover:border-accent/50">
                  <button type="button" onClick={() => open2(c.id)} className="flex-1 px-3 py-2 text-left text-[0.8125rem]">
                    <span className="block font-medium">{c.title}</span>
                    <span className="text-xs text-fg-subtle">{c.questions} question{c.questions === 1 ? '' : 's'} · {new Date(c.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </button>
                  <button type="button" onClick={() => forget(c.id)} className="p-2 text-fg-subtle hover:text-danger" aria-label={`Delete “${c.title}”`}><Trash2 className="size-3.5" /></button>
                </li>
              ))}
            </ul>
          ) : <p className="text-[0.8125rem] text-fg-subtle">No past conversations. Only you can see yours, and you can delete them here.</p>}
        </div>
      )}

      <div className={cn('flex-1 space-y-5 overflow-y-auto px-4 py-4', history && 'hidden')} aria-live="polite">
        {!turns.length && (
          <div className="space-y-3">
            <p className="text-[0.8125rem] text-fg-muted">Ask about approvals, leave, headcount, attendance, payroll, expenses, leavers, probation, goals, training, helpdesk cases or recruitment, or ask IQ to start a bid or a job description. Follow up with “and last month?” or “what about Sales?”. IQ never changes anything on its own.</p>
            <ul className="grid gap-1.5" aria-label="Suggested questions">
              {suggestionsFor(path).map((s) => (
                <li key={s}><button type="button" onClick={() => ask(s)} className="w-full rounded-md border border-border px-3 py-2 text-left text-[0.8125rem] hover:border-accent/50 hover:bg-bg-subtle">{s}</button></li>
              ))}
            </ul>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-accent px-3 py-2 text-[0.8125rem] text-accent-fg">{t.q}</p>
            {t.a ? <AnswerCard a={t.a} onAsk={ask} onNavigate={onClose} /> : t.error ? <p className="text-[0.8125rem] text-danger">{t.error}</p> : <p className="text-[0.8125rem] text-fg-subtle">Looking that up…</p>}
          </div>
        ))}
        <div ref={end} />
      </div>

      <form className="flex items-end gap-2 border-t border-border p-3" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <textarea
          ref={input}
          aria-label="Ask SampCrew IQ"
          rows={2}
          maxLength={500}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(q); } }}
          placeholder="Ask a question or describe what you need"
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border bg-bg px-3 py-2 text-[0.8125rem] outline-none focus:border-accent"
        />
        <Button type="submit" size="sm" loading={pending} aria-label="Send question"><Send className="size-3.5" /></Button>
      </form>
    </aside>
  );
}

function AnswerCard({ a, onAsk, onNavigate }: { a: IqAnswer; onAsk: (q: string) => void; onNavigate: () => void }) {
  const c = CONFIDENCE[a.confidence];
  return (
    <article className="space-y-2.5 rounded-lg border border-border bg-bg-subtle/60 p-3 text-[0.8125rem]" aria-label={a.title}>
      <div className="flex items-start gap-2">
        <h3 className="flex-1 font-semibold">{a.title}</h3>
        <span title={c.hint}><Badge tone={c.tone}>{c.label}</Badge></span>
      </div>
      <p className="whitespace-pre-wrap text-fg-muted">{a.summary}</p>
      {a.table && (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-left text-xs">
            <thead><tr>{a.table.columns.map((h, i) => <th key={h} className={cn('border-b border-border px-2 py-1.5 font-medium text-fg-subtle', i > 0 && typeof a.table!.rows[0]?.[i] === 'number' && 'text-right')}>{h}</th>)}</tr></thead>
            <tbody>
              {a.table.rows.map((r, i) => <tr key={i} className="border-b border-border last:border-0">{r.map((v, j) => <td key={j} className={cn('px-2 py-1.5', typeof v === 'number' && 'text-right tabular-nums')}>{v}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      )}
      {a.items && a.items.length > 0 && (
        <ul className="grid gap-1">
          {a.items.map((it, i) => (
            <li key={i}>{it.href ? <Link href={it.href} onClick={onNavigate} className="text-accent hover:underline">{it.label}</Link> : it.label}{it.detail && <span className="text-fg-subtle"> · {it.detail}</span>}</li>
          ))}
        </ul>
      )}
      {a.action && (
        <div className="rounded-md border border-accent/30 bg-surface p-2.5" aria-label="Preview">
          <p className="mb-1.5 text-xs font-medium text-fg-subtle">Preview</p>
          {a.action.preview.length > 0 && (
            <dl className="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              {a.action.preview.map((p) => <Fragment key={p.label}><dt className="text-fg-subtle">{p.label}</dt><dd>{p.value}</dd></Fragment>)}
            </dl>
          )}
          <Link href={a.action.href} onClick={onNavigate} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">{a.action.label} <ArrowRight className="size-3.5" /></Link>
          <p className="mt-1 text-xs text-fg-subtle">{a.action.note}</p>
        </div>
      )}
      {a.sources.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"><span className="text-fg-subtle">Sources:</span>{a.sources.map((s) => <Link key={s.href} href={s.href} onClick={onNavigate} className="inline-flex items-center gap-0.5 text-accent hover:underline">{s.label}<ExternalLink className="size-3" /></Link>)}</p>
      )}
      <p className="flex gap-1.5 text-xs text-fg-subtle"><Info className="mt-0.5 size-3 shrink-0" /><span><span className="sr-only">How this was answered: </span>{a.how}</span></p>
      {a.suggestions && (
        <div className="flex flex-wrap gap-1.5">{a.suggestions.map((s) => <button key={s} type="button" onClick={() => onAsk(s)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-accent/50">{s}</button>)}</div>
      )}
    </article>
  );
}

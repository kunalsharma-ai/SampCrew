'use client';
import { cn } from '@crew/ui';
import { Bold, Heading2, Italic, Link2, List, ListOrdered, Quote, Underline } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const TOOLS = [
  { cmd: 'bold', icon: Bold, label: 'Bold' },
  { cmd: 'italic', icon: Italic, label: 'Italic' },
  { cmd: 'underline', icon: Underline, label: 'Underline' },
  { cmd: 'formatBlock', arg: 'h3', icon: Heading2, label: 'Heading' },
  { cmd: 'insertUnorderedList', icon: List, label: 'Bulleted list' },
  { cmd: 'insertOrderedList', icon: ListOrdered, label: 'Numbered list' },
  { cmd: 'formatBlock', arg: 'blockquote', icon: Quote, label: 'Quote' },
] as const;

/**
 * A small rich-text editor (bold, italic, underline, heading, lists, quote, links). The HTML it produces is cleaned
 * again on the server, which keeps only this formatting, so pasted content cannot carry scripts or styles.
 */
export function RichTextEditor({ value, onChange, label, placeholder }: { value: string; onChange: (html: string) => void; label: string; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [link, setLink] = useState<string | null>(null);
  // The editor owns its content while typing; outside changes (opening a draft) are applied once.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value && document.activeElement !== ref.current) ref.current.innerHTML = value;
  }, [value]);
  const run = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    onChange(ref.current?.innerHTML ?? '');
  };
  return (
    <div className="rounded-lg border border-border focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/20">
      <div className="flex flex-wrap gap-0.5 border-b border-border p-1" role="toolbar" aria-label="Formatting">
        {TOOLS.map((t) => (
          <button key={t.label} type="button" title={t.label} aria-label={t.label} className="rounded p-1.5 text-fg-muted hover:bg-bg-subtle hover:text-fg" onMouseDown={(e) => e.preventDefault()} onClick={() => run(t.cmd, 'arg' in t ? t.arg : undefined)}>
            <t.icon className="size-4" />
          </button>
        ))}
        <button type="button" title="Link" aria-label="Link" className="rounded p-1.5 text-fg-muted hover:bg-bg-subtle hover:text-fg" onMouseDown={(e) => e.preventDefault()} onClick={() => {
          const sel = window.getSelection();
          saved.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
          setLink('https://');
        }}>
          <Link2 className="size-4" />
        </button>
        {link !== null && (
          <span className="flex items-center gap-1">
            <input aria-label="Link address" className="h-7 w-56 rounded border border-border bg-surface px-2 text-xs" value={link} onChange={(e) => setLink(e.target.value)} autoFocus />
            <button type="button" className="rounded px-2 py-1 text-xs font-medium text-accent hover:bg-bg-subtle" onClick={() => {
              const url = link.trim();
              setLink(null);
              if (!/^(https?:\/\/|mailto:)\S+$/i.test(url)) return;
              ref.current?.focus();
              const sel = window.getSelection();
              if (saved.current && sel) { sel.removeAllRanges(); sel.addRange(saved.current); }
              if (sel && sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`);
              else document.execCommand('createLink', false, url);
              onChange(ref.current?.innerHTML ?? '');
            }}>Add link</button>
            <button type="button" className="rounded px-1 py-1 text-xs text-fg-muted" onClick={() => setLink(null)}>Cancel</button>
          </span>
        )}
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        data-testid="rich-text"
        className={cn('prose-email min-h-48 px-3 py-2 text-[0.8125rem] outline-none empty:before:text-fg-subtle empty:before:content-[attr(data-placeholder)]')}
        onInput={() => onChange(ref.current?.innerHTML ?? '')}
        onBlur={() => onChange(ref.current?.innerHTML ?? '')}
      />
    </div>
  );
}

/** Shows rich text that the server already cleaned (HR emails, announcements). */
export function RichTextView({ html, className }: { html: string; className?: string }) {
  return <div className={cn('prose-email text-[0.8125rem]', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

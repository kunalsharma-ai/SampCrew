'use client';
import { HELP_ICONS, HELP_KIND_LABEL, type HelpArticleKind, type HelpArticleSummary, type HelpCategoryView, type HelpIcon, type HelpQueryStatus } from '@crew/contracts';
import { BookOpen, ChevronRight, CircleHelp, Compass, GraduationCap, ListChecks, Newspaper, PlayCircle, Rocket, Search, Sparkles, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../../cn';
import { Badge, type Tone } from '../surface';
import { useHelpCentre } from './context';

export const KIND_TONE: Record<HelpArticleKind, Tone> = { faq: 'info', guide: 'accent', tutorial: 'success', troubleshooting: 'warning', quickstart: 'ember', feature: 'accent', article: 'neutral' };
export const STATUS_TONE: Record<HelpQueryStatus, Tone> = { open: 'info', in_progress: 'warning', awaiting_user: 'ember', resolved: 'success', closed: 'neutral' };

const KIND_ICON: Record<HelpArticleKind, typeof BookOpen> = { faq: CircleHelp, guide: BookOpen, tutorial: GraduationCap, troubleshooting: Wrench, quickstart: Rocket, feature: Sparkles, article: Newspaper };

/** Gradient backgrounds for the category tiles, picked from the key so a category keeps its colour. */
const TILE_TONES = [
  'from-indigo-500/20 to-violet-500/5',
  'from-sky-500/20 to-cyan-500/5',
  'from-emerald-500/20 to-teal-500/5',
  'from-amber-500/25 to-orange-500/5',
  'from-rose-500/20 to-pink-500/5',
  'from-fuchsia-500/20 to-purple-500/5',
];
export const tileTone = (key: string) => TILE_TONES[[...key].reduce((n, c) => n + c.charCodeAt(0), 0) % TILE_TONES.length];

export function HelpGlyph({ icon, className }: { icon: HelpIcon | string; className?: string }) {
  return <span aria-hidden className={cn('inline-flex items-center justify-center leading-none', className)}>{HELP_ICONS[icon as HelpIcon] ?? HELP_ICONS.book}</span>;
}

export function KindBadge({ kind }: { kind: HelpArticleKind }) {
  const Icon = KIND_ICON[kind];
  return <Badge tone={KIND_TONE[kind]} className="gap-1"><Icon className="size-3" aria-hidden />{HELP_KIND_LABEL[kind]}</Badge>;
}

/**
 * Article text: paragraphs are separated by a blank line, lines starting with "- " are a bulleted list and lines
 * starting with "1. " a numbered one. **bold** is supported; everything else is plain text (no HTML from content).
 */
export function HelpBody({ text, className }: { text: string; className?: string }) {
  if (!text.trim()) return null;
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  return (
    <div className={cn('grid gap-3 text-[14px] leading-relaxed text-fg', className)} data-testid="help-body">
      {blocks.map((b, i) => {
        const lines = b.split('\n').filter((l) => l.trim());
        if (lines.length && lines.every((l) => /^\s*[-*] /.test(l))) return <ul key={i} className="ml-5 list-disc grid gap-1">{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*] /, ''))}</li>)}</ul>;
        if (lines.length && lines.every((l) => /^\s*\d+[.)] /.test(l))) return <ol key={i} className="ml-5 list-decimal grid gap-1">{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*\d+[.)] /, ''))}</li>)}</ol>;
        return <p key={i} className="whitespace-pre-line">{inline(b)}</p>;
      })}
    </div>
  );
}

function inline(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

/** The search box at the top of every help page: a plain GET form, so it works before scripts load. */
export function HelpSearchBox({ q = '', big, placeholder, autoFocus }: { q?: string; big?: boolean; placeholder?: string; autoFocus?: boolean }) {
  const { base } = useHelpCentre();
  return (
    <form action={`${base}/search`} method="get" role="search" className="relative w-full" data-testid="help-search">
      <Search className={cn('pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-subtle', big ? 'left-4 size-5' : 'left-3 size-4')} aria-hidden />
      <input
        name="q"
        defaultValue={q}
        autoFocus={autoFocus}
        aria-label="Search help"
        placeholder={placeholder ?? 'Search features, questions or error messages'}
        className={cn('w-full rounded-xl border border-border bg-surface text-fg shadow-card outline-none placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent/25', big ? 'h-14 pl-12 pr-28 text-[15px]' : 'h-10 pl-9 pr-20 text-sm')}
      />
      <button type="submit" className={cn('absolute top-1/2 -translate-y-1/2 rounded-lg bg-accent font-medium text-accent-fg hover:bg-accent-hover', big ? 'right-2 h-10 px-4 text-sm' : 'right-1.5 h-7 px-3 text-xs')}>Search</button>
    </form>
  );
}

export function SectionTitle({ title, action, icon }: { title: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">{icon}{title}</h2>
      {action}
    </div>
  );
}

/** One article as a row: kind, title, summary and what it contains (steps, a video). */
export function ArticleRow({ a, snippet, showCategory = true }: { a: HelpArticleSummary; snippet?: string; showCategory?: boolean }) {
  const { base, Link } = useHelpCentre();
  return (
    <Link href={`${base}/articles/${a.slug}`} className="group flex items-start gap-3 rounded-lg px-3 py-2.5 hover:bg-bg-subtle" data-testid="help-article-row">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <KindBadge kind={a.kind} />
          {showCategory && <span className="text-[11px] text-fg-subtle">{a.categoryName}</span>}
          {a.steps > 0 && <span className="inline-flex items-center gap-0.5 text-[11px] text-fg-subtle"><ListChecks className="size-3" aria-hidden />{a.steps} steps</span>}
          {a.hasVideo && <span className="inline-flex items-center gap-0.5 text-[11px] text-fg-subtle"><PlayCircle className="size-3" aria-hidden />Video</span>}
        </span>
        <span className="mt-1 block text-[13.5px] font-medium text-fg group-hover:text-accent" data-testid="help-article-title">{a.title}</span>
        {(snippet || a.summary) && <span className="mt-0.5 line-clamp-2 block text-xs text-fg-muted">{snippet || a.summary}</span>}
      </span>
      <ChevronRight className="mt-1 size-4 shrink-0 text-fg-subtle group-hover:text-accent" aria-hidden />
    </Link>
  );
}

/** A category tile: icon on a soft gradient, name, description and how many articles it holds. */
export function CategoryTile({ c }: { c: HelpCategoryView }) {
  const { base, Link } = useHelpCentre();
  return (
    <Link href={`${base}/categories/${c.key}`} className="group flex h-full flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-card transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-pop" data-testid="help-category">
      <span className={cn('flex size-11 items-center justify-center rounded-xl bg-gradient-to-br text-[22px]', tileTone(c.key))}><HelpGlyph icon={c.icon} /></span>
      <span className="text-[14px] font-semibold text-fg group-hover:text-accent">{c.name}</span>
      {c.description && <span className="line-clamp-2 text-xs text-fg-muted">{c.description}</span>}
      <span className="mt-auto text-[11px] font-medium text-fg-subtle">{c.count} {c.count === 1 ? 'article' : 'articles'}</span>
    </Link>
  );
}

/** A frequently asked question that opens in place, with a link to the full answer. */
export function FaqItem({ a }: { a: HelpArticleSummary }) {
  const { base, Link } = useHelpCentre();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-surface" data-testid="help-faq">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <CircleHelp className="size-4 shrink-0 text-accent" aria-hidden />
        <span className="flex-1 text-[13.5px] font-medium text-fg">{a.title}</span>
        <ChevronRight className={cn('size-4 shrink-0 text-fg-subtle transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div className="border-t border-border px-4 py-3 text-[13px] text-fg-muted">
          <p>{a.summary || 'Open the answer to read it in full.'}</p>
          <Link href={`${base}/articles/${a.slug}`} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">Read the full answer <ChevronRight className="size-3" aria-hidden /></Link>
        </div>
      )}
    </div>
  );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  const { Link } = useHelpCentre();
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-xs text-fg-muted">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3 text-fg-subtle" aria-hidden />}
          {it.href ? <Link href={it.href} className="hover:text-accent hover:underline">{it.label}</Link> : <span className="text-fg">{it.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export const CompassIcon = Compass;

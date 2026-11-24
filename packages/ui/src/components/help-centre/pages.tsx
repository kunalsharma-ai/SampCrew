'use client';
import {
  HELP_ARTICLE_KINDS, HELP_KIND_PLURAL,
  type HelpArticleKind, type HelpArticleSummary, type HelpArticleView, type HelpCategoryView, type HelpHome, type HelpSearchResult,
} from '@crew/contracts';
import {
  ArrowRight, BookOpen, CheckCircle2, Circle, CircleHelp, Clock3, ExternalLink, Flame, GraduationCap, Inbox, LifeBuoy, ListChecks, MessageSquarePlus, PlayCircle,
  Newspaper, Rocket, Sparkles, ThumbsDown, ThumbsUp, Ticket, Wrench,
} from 'lucide-react';
import { useState, useTransition, type ReactNode } from 'react';
import { cn } from '../../cn';
import { buttonClass } from '../button';
import { Alert, Badge, Card, EmptyState } from '../surface';
import { useHelpCentre } from './context';
import { ArticleRow, CategoryTile, Crumbs, FaqItem, HelpBody, HelpGlyph, HelpSearchBox, KindBadge, SectionTitle, tileTone } from './parts';

const KIND_ICON: Record<HelpArticleKind, typeof BookOpen> = { faq: CircleHelp, guide: BookOpen, tutorial: GraduationCap, troubleshooting: Wrench, quickstart: Rocket, feature: Sparkles, article: Newspaper };

/** The hero: greeting for the level, the big search box and the quick-access buttons. */
function Hero({ home, children }: { home: HelpHome; children?: ReactNode }) {
  const { base, queriesBase, inboxBase, Link } = useHelpCentre();
  const quick: { label: string; href: string; icon: typeof BookOpen; hint: string; testid: string; badge?: number }[] = [
    { label: 'Guides', href: `${base}/search?kind=guide`, icon: BookOpen, hint: home.counts.guide ? `${home.counts.guide} step-by-step guides` : 'Step by step', testid: 'quick-guides' },
    { label: 'FAQs', href: `${base}/search?kind=faq`, icon: CircleHelp, hint: `${home.counts.faq ?? 0} answers`, testid: 'quick-faqs' },
    { label: 'Tutorials', href: `${base}/search?kind=tutorial`, icon: GraduationCap, hint: home.counts.tutorial ? `${home.counts.tutorial} interactive tutorials` : 'Learn by doing', testid: 'quick-tutorials' },
  ];
  if (home.queries.raise) quick.push({ label: 'Raise a Query', href: `${queriesBase}/new`, icon: MessageSquarePlus, hint: home.queries.open ? `${home.queries.open} open ${home.queries.open === 1 ? 'query' : 'queries'}` : 'Ask our team anything', testid: 'quick-raise' });
  if (home.queries.inbox) quick.push({ label: 'Queries inbox', href: inboxBase, icon: Inbox, hint: home.queries.waiting ? `${home.queries.waiting} waiting for an answer` : 'Answer queries', testid: 'quick-inbox', badge: home.queries.waiting });
  return (
    <section className="crew-help-hero relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-accent/15 via-surface to-fuchsia-500/10 px-5 py-8 sm:px-10 sm:py-10" data-testid="help-hero">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-accent/20 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-20 left-1/3 size-56 rounded-full bg-fuchsia-500/10 blur-3xl" />
      <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
        <Badge tone="accent" className="gap-1"><LifeBuoy className="size-3" aria-hidden />Help &amp; Support · {home.levelLabel}</Badge>
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-[2rem]">How can we help you today?</h1>
        {home.welcome && <p className="max-w-xl text-sm text-fg-muted">{home.welcome}</p>}
        <HelpSearchBox big />
        {children}
      </div>
      <div className={cn('relative mx-auto mt-7 grid max-w-4xl gap-3', quick.length > 4 ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5' : 'grid-cols-2 sm:grid-cols-4')}>
        {quick.map((q) => (
          <Link key={q.label} href={q.href} data-testid={q.testid} className="group relative flex flex-col items-center gap-1.5 rounded-xl border border-border bg-surface/85 p-3 text-center shadow-card backdrop-blur transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-pop">
            <span className="flex size-10 items-center justify-center rounded-full bg-accent-subtle text-accent"><q.icon className="size-5" aria-hidden /></span>
            <span className="text-[13.5px] font-semibold text-fg group-hover:text-accent">{q.label}</span>
            <span className="text-[11px] text-fg-muted">{q.hint}</span>
            {!!q.badge && <span className="absolute right-2 top-2 rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-fg">{q.badge}</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}

function ArticleList({ items, empty }: { items: HelpArticleSummary[]; empty?: string }) {
  if (!items.length) return empty ? <p className="px-3 py-2 text-xs text-fg-muted">{empty}</p> : null;
  return <div className="grid">{items.map((a) => <ArticleRow key={a.id} a={a} />)}</div>;
}

/** The help centre's front page. */
export function HelpHomeView({ home }: { home: HelpHome }) {
  const { base, queriesBase, Link } = useHelpCentre();
  const top = home.categories.filter((c) => !c.parentId);
  return (
    <div className="grid gap-8" data-testid="help-home" data-level={home.level}>
      <Hero home={home} />

      {home.quickstarts.length > 0 && (
        <section>
          <SectionTitle title="Quick start" icon={<Rocket className="size-4 text-accent" aria-hidden />} />
          <div className="grid gap-3 md:grid-cols-3">
            {home.quickstarts.map((a, i) => (
              <Link key={a.id} href={`${base}/articles/${a.slug}`} data-testid="help-quickstart" className="group relative flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-surface p-4 shadow-card transition hover:border-accent/50 hover:shadow-pop">
                <span aria-hidden className="absolute -right-3 -top-4 text-[72px] font-bold leading-none text-accent/10">{i + 1}</span>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-accent">{a.audiences.length === 1 ? a.categoryName : 'Quick start'}</span>
                <span className="text-[14px] font-semibold text-fg group-hover:text-accent">{a.title}</span>
                <span className="line-clamp-2 text-xs text-fg-muted">{a.summary}</span>
                <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-accent"><ListChecks className="size-3.5" aria-hidden />{a.steps} steps · Start <ArrowRight className="size-3 transition group-hover:translate-x-0.5" aria-hidden /></span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle title="Browse by category" icon={<Sparkles className="size-4 text-accent" aria-hidden />} action={<span className="text-xs text-fg-muted">{top.length} categories</span>} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" data-testid="help-categories">
          {top.map((c) => <CategoryTile key={c.id} c={c} />)}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <SectionTitle title="Frequently asked questions" icon={<CircleHelp className="size-4 text-accent" aria-hidden />} action={<Link href={`${base}/search?kind=faq`} className="text-xs font-medium text-accent hover:underline">All FAQs</Link>} />
          <div className="grid gap-2" data-testid="help-faqs">{home.faqs.map((a) => <FaqItem key={a.id} a={a} />)}</div>
        </section>
        <div className="grid h-fit gap-6">
          <Card className="p-2" data-testid="help-recommended">
            <div className="px-3 pt-2"><SectionTitle title="Recommended guides" icon={<BookOpen className="size-4 text-accent" aria-hidden />} /></div>
            <ArticleList items={home.recommended} />
          </Card>
          <Card className="p-2" data-testid="help-recent">
            <div className="px-3 pt-2"><SectionTitle title="Recently viewed" icon={<Clock3 className="size-4 text-accent" aria-hidden />} /></div>
            <ArticleList items={home.recent} empty="Articles you open appear here so you can find them again." />
          </Card>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-2" data-testid="help-popular">
          <div className="px-3 pt-2"><SectionTitle title="Popular articles" icon={<Flame className="size-4 text-accent" aria-hidden />} /></div>
          <ArticleList items={home.popular} />
        </Card>
        <Card className="p-2" data-testid="help-tutorials">
          <div className="px-3 pt-2"><SectionTitle title="Interactive tutorials" icon={<GraduationCap className="size-4 text-accent" aria-hidden />} action={<Link href={`${base}/search?kind=tutorial`} className="text-xs font-medium text-accent hover:underline">All tutorials</Link>} /></div>
          <ArticleList items={home.tutorials} />
        </Card>
      </div>

      <StillNeedHelp raise={home.queries.raise} queriesBase={queriesBase} />
    </div>
  );
}

function StillNeedHelp({ raise, queriesBase, articleId, page }: { raise: boolean; queriesBase: string; articleId?: string; page?: string | null }) {
  const { Link } = useHelpCentre();
  if (!raise) return null;
  const qs = new URLSearchParams();
  if (articleId) qs.set('article', articleId);
  if (page) qs.set('page', page);
  return (
    <section className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-gradient-to-r from-accent/10 to-transparent p-5 sm:flex-row sm:items-center" data-testid="help-still-need">
      <span className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-fg"><Ticket className="size-5" aria-hidden /></span>
      <div className="flex-1">
        <h2 className="text-[15px] font-semibold text-fg">Still need help?</h2>
        <p className="text-sm text-fg-muted">Raise a query and the right team will answer. You get a ticket ID and a notification for every reply.</p>
      </div>
      <div className="flex gap-2">
        <Link href={`${queriesBase}`} className={buttonClass('secondary', 'md')}>My queries</Link>
        <Link href={`${queriesBase}/new${qs.size ? `?${qs}` : ''}`} className={buttonClass('primary', 'md')} data-testid="help-raise-link"><MessageSquarePlus className="size-4" aria-hidden />Raise a Query</Link>
      </div>
    </section>
  );
}

/** Search results, filtered by kind and category. */
export function HelpSearchView({ result, query, categories, raise }: { result: HelpSearchResult; query: { q?: string; kind?: string; category?: string }; categories: HelpCategoryView[]; raise: boolean }) {
  const { base, queriesBase, Link } = useHelpCentre();
  const href = (over: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ q: query.q, kind: query.kind, category: query.category, ...over }).filter(([, v]) => v) as [string, string][]);
    return `${base}/search${p.size ? `?${p}` : ''}`;
  };
  const kindLabel = query.kind ? HELP_KIND_PLURAL[query.kind as HelpArticleKind] : null;
  const cat = categories.find((c) => c.key === query.category);
  const title = query.q ? `Results for “${query.q}”` : kindLabel ?? cat?.name ?? 'All articles';
  return (
    <div className="grid gap-5" data-testid="help-search-page">
      <Crumbs items={[{ label: 'Help & Support', href: base }, { label: 'Search' }]} />
      <div className="grid gap-3">
        <h1 className="text-xl font-semibold text-fg">{title}</h1>
        <HelpSearchBox q={query.q} />
        <nav aria-label="Filter by kind" className="flex flex-wrap gap-1.5">
          <Link href={href({ kind: undefined })} aria-current={!query.kind ? 'page' : undefined} className={chip(!query.kind)}>All kinds</Link>
          {HELP_ARTICLE_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            return <Link key={k} href={href({ kind: k })} aria-current={query.kind === k ? 'page' : undefined} className={chip(query.kind === k)} data-testid={`help-kind-${k}`}><Icon className="size-3" aria-hidden />{HELP_KIND_PLURAL[k]}</Link>;
          })}
        </nav>
        {cat && <p className="text-xs text-fg-muted">In {cat.name} · <Link href={href({ category: undefined })} className="text-accent hover:underline">All categories</Link></p>}
      </div>
      <Card className="p-2">
        <p className="px-3 py-1.5 text-xs text-fg-muted" data-testid="help-search-total">{result.total} {result.total === 1 ? 'article' : 'articles'}</p>
        {result.items.length ? (
          <div className="grid" data-testid="help-search-results">{result.items.map((a) => <ArticleRow key={a.id} a={a} snippet={a.snippet} />)}</div>
        ) : (
          <EmptyState icon={<CircleHelp className="size-5" />} title="Nothing matches yet" description={raise ? 'Try fewer or different words, or raise a query and our team will answer.' : 'Try fewer or different words.'} action={raise ? <Link href={`${queriesBase}/new`} className={buttonClass('primary', 'sm')}>Raise a Query</Link> : undefined} />
        )}
      </Card>
    </div>
  );
}

const chip = (on: boolean) => cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs', on ? 'border-accent bg-accent-subtle text-accent' : 'border-border text-fg-muted hover:text-fg');

/** One category: its subcategories and the articles in it, grouped by kind. */
export function HelpCategoryPageView({ data, raise }: { data: { category: HelpCategoryView; parent: HelpCategoryView | null; subcategories: HelpCategoryView[]; articles: HelpArticleSummary[] }; raise: boolean }) {
  const { base, queriesBase } = useHelpCentre();
  const c = data.category;
  const byKind = HELP_ARTICLE_KINDS.map((k) => [k, data.articles.filter((a) => a.kind === k)] as const).filter(([, list]) => list.length);
  return (
    <div className="grid gap-6" data-testid="help-category-page">
      <div>
        <Crumbs items={[{ label: 'Help & Support', href: base }, ...(data.parent ? [{ label: data.parent.name, href: `${base}/categories/${data.parent.key}` }] : []), { label: c.name }]} />
        <div className="flex flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-card sm:flex-row sm:items-center">
          <span className={cn('flex size-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-[28px]', tileTone(c.key))}><HelpGlyph icon={c.icon} /></span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-fg" data-testid="help-category-title">{c.name}</h1>
            {c.description && <p className="mt-1 text-sm text-fg-muted">{c.description}</p>}
          </div>
          <div className="w-full sm:w-72"><HelpSearchBox placeholder={`Search ${c.name}`} /></div>
        </div>
      </div>
      {data.subcategories.length > 0 && (
        <section>
          <SectionTitle title="Topics" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{data.subcategories.map((s) => <CategoryTile key={s.id} c={s} />)}</div>
        </section>
      )}
      {byKind.map(([k, list]) => {
        const Icon = KIND_ICON[k];
        return (
          <section key={k}>
            <SectionTitle title={HELP_KIND_PLURAL[k]} icon={<Icon className="size-4 text-accent" aria-hidden />} />
            {k === 'faq' ? <div className="grid gap-2">{list.map((a) => <FaqItem key={a.id} a={a} />)}</div> : <Card className="p-2"><div className="grid">{list.map((a) => <ArticleRow key={a.id} a={a} showCategory={false} />)}</div></Card>}
          </section>
        );
      })}
      {!data.articles.length && !data.subcategories.length && <EmptyState title="No articles here yet" />}
      <StillNeedHelp raise={raise} queriesBase={queriesBase} />
    </div>
  );
}

const videoEmbed = (url: string) => {
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
};

/** One article. FAQs show the answer; guides, tutorials and quick starts show numbered steps the person can tick off. */
export function HelpArticlePageView({ article, raise, embedVideo = false }: { article: HelpArticleView; raise: boolean; embedVideo?: boolean }) {
  const { base, queriesBase, Link, actions } = useHelpCentre();
  const a = article;
  const [done, setDone] = useState<number[]>(a.mine.doneSteps);
  const [vote, setVote] = useState<boolean | null>(a.mine.helpful);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stepped = a.stepList.length > 0;
  const interactive = stepped && !!actions.progress;
  const pct = stepped ? Math.round((done.length / a.stepList.length) * 100) : 0;
  const toggle = (i: number) => {
    if (!actions.progress) return;
    const next = !done.includes(i);
    setDone((cur) => (next ? [...cur, i] : cur.filter((x) => x !== i)));
    start(async () => {
      const r = await actions.progress!(a.slug, i, next);
      if (!r.ok) { setError(r.message); setDone((cur) => (next ? cur.filter((x) => x !== i) : [...cur, i])); }
    });
  };
  const sendVote = (helpful: boolean) => {
    if (!actions.feedback) return;
    setVote(helpful);
    start(async () => { const r = await actions.feedback!(a.slug, helpful); if (!r.ok) setError(r.message); });
  };
  const embed = embedVideo && a.videoUrl ? videoEmbed(a.videoUrl) : null;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]" data-testid="help-article" data-kind={a.kind}>
      <article className="min-w-0">
        <Crumbs items={[{ label: 'Help & Support', href: base }, { label: a.categoryName, href: `${base}/categories/${a.categoryKey}` }, { label: a.title }]} />
        <Card className="p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-2"><KindBadge kind={a.kind} />{a.hasVideo && <Badge tone="neutral" className="gap-1"><PlayCircle className="size-3" aria-hidden />Video</Badge>}</div>
          <h1 className="mt-3 text-[1.4rem] font-semibold leading-snug text-fg" data-testid="help-article-heading">{a.title}</h1>
          {a.summary && <p className="mt-2 text-[15px] text-fg-muted">{a.summary}</p>}
          {a.href && (
            <Link href={a.href} className={cn(buttonClass('secondary', 'sm'), 'mt-4')} data-testid="help-go-to-page"><ExternalLink className="size-3.5" aria-hidden />Go to this page</Link>
          )}
          {a.imageUrl && <img src={a.imageUrl} alt="" className="mt-5 w-full rounded-xl border border-border" loading="lazy" />}
          {a.videoUrl && (embed ? (
            <div className="mt-5 aspect-video overflow-hidden rounded-xl border border-border"><iframe src={embed} title={`Video: ${a.title}`} className="size-full" allow="accelerometer; encrypted-media; picture-in-picture" allowFullScreen /></div>
          ) : (
            <a href={a.videoUrl} target="_blank" rel="noopener noreferrer" className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-bg-subtle p-4 hover:border-accent/50" data-testid="help-video">
              <span className="flex size-10 items-center justify-center rounded-full bg-accent text-accent-fg"><PlayCircle className="size-5" aria-hidden /></span>
              <span className="flex-1"><span className="block text-sm font-semibold text-fg">Watch the video walkthrough</span><span className="block text-xs text-fg-muted">Opens in a new tab</span></span>
              <ExternalLink className="size-4 text-fg-subtle" aria-hidden />
            </a>
          ))}
          <HelpBody text={a.body} className="mt-5" />
          {stepped && (
            <section className="mt-6" aria-label="Steps" data-testid="help-steps">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-[15px] font-semibold text-fg">{a.kind === 'tutorial' ? 'Follow along' : 'Step by step'}</h2>
                {interactive && (
                  <span className="flex items-center gap-2 text-xs text-fg-muted" data-testid="help-progress">
                    <span className="h-1.5 w-28 overflow-hidden rounded-full bg-bg-subtle"><span className="block h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} /></span>
                    {done.length} of {a.stepList.length} done
                  </span>
                )}
              </div>
              <ol className="relative grid gap-3 border-l-2 border-border pl-6">
                {a.stepList.map((s, i) => {
                  const ok = done.includes(i);
                  return (
                    <li key={i} className="relative" data-testid="help-step" data-done={ok ? 'true' : 'false'}>
                      <span className={cn('absolute -left-[2.15rem] top-0 flex size-7 items-center justify-center rounded-full border-2 text-xs font-semibold', ok ? 'border-success bg-success text-surface' : 'border-border bg-surface text-fg-muted')}>{ok ? <CheckCircle2 className="size-4" aria-hidden /> : i + 1}</span>
                      <div className={cn('rounded-xl border p-3.5 transition', ok ? 'border-success/40 bg-success-subtle/40' : 'border-border bg-surface')}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <h3 className="text-[14px] font-semibold text-fg">{s.title}</h3>
                          <div className="flex gap-1.5">
                            {s.href && <Link href={s.href} className={buttonClass('ghost', 'sm', 'h-7 px-2 text-xs')}><ExternalLink className="size-3" aria-hidden />Open</Link>}
                            {interactive && (
                              <button type="button" onClick={() => toggle(i)} disabled={pending} aria-pressed={ok} data-testid="help-step-toggle" className={buttonClass(ok ? 'secondary' : 'primary', 'sm', 'h-7 px-2 text-xs')}>
                                {ok ? <><CheckCircle2 className="size-3" aria-hidden />Done</> : <><Circle className="size-3" aria-hidden />Mark done</>}
                              </button>
                            )}
                          </div>
                        </div>
                        {s.body && <p className="mt-1 text-[13px] text-fg-muted">{s.body}</p>}
                      </div>
                    </li>
                  );
                })}
              </ol>
              {interactive && done.length === a.stepList.length && <div className="mt-4"><Alert tone="success" title="All done">You finished every step. Nice work.</Alert></div>}
            </section>
          )}
          {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
          {actions.feedback && (
            <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-border pt-4" data-testid="help-feedback">
              <span className="text-sm font-medium text-fg">Was this helpful?</span>
              <button type="button" onClick={() => sendVote(true)} aria-pressed={vote === true} className={buttonClass(vote === true ? 'primary' : 'secondary', 'sm')} data-testid="help-helpful-yes"><ThumbsUp className="size-3.5" aria-hidden />Yes</button>
              <button type="button" onClick={() => sendVote(false)} aria-pressed={vote === false} className={buttonClass(vote === false ? 'primary' : 'secondary', 'sm')} data-testid="help-helpful-no"><ThumbsDown className="size-3.5" aria-hidden />No</button>
              {vote !== null && <span className="text-xs text-fg-muted" data-testid="help-feedback-thanks">{vote ? 'Thanks for letting us know.' : 'Sorry about that. Raise a query below and we will help.'}</span>}
            </div>
          )}
        </Card>
      </article>
      <aside className="grid h-fit gap-4 lg:sticky lg:top-4">
        {a.related.length > 0 && (
          <Card className="p-2" data-testid="help-related">
            <div className="px-3 pt-2"><SectionTitle title="Related articles" /></div>
            <div className="grid">{a.related.map((r) => <ArticleRow key={r.id} a={r} />)}</div>
          </Card>
        )}
        {raise && (
          <Card className="p-4">
            <h2 className="text-sm font-semibold text-fg">Still need help?</h2>
            <p className="mt-1 text-xs text-fg-muted">Tell us what is not working and we will get back to you.</p>
            <Link href={`${queriesBase}/new?article=${a.id}${a.href ? `&page=${encodeURIComponent(a.href)}` : ''}`} className={cn(buttonClass('primary', 'sm'), 'mt-3 w-full')} data-testid="help-raise-link"><MessageSquarePlus className="size-3.5" aria-hidden />Raise a Query</Link>
          </Card>
        )}
        <Link href={`${base}/categories/${a.categoryKey}`} className="text-xs font-medium text-accent hover:underline">More in {a.categoryName}</Link>
      </aside>
    </div>
  );
}

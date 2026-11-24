'use client';
import type { HelpArticleSummary, PublicHelpEntry, PublicHelpHome } from '@crew/contracts';
import { HelpBody } from '@crew/ui';
import { ArrowRight, ChevronDown, KeyRound, LifeBuoy, LogIn, MessageSquarePlus, Search, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type CSSProperties } from 'react';
import { HelpLineIcon } from './icons';
import { toneFor } from './tones';

const firstPara = (s: string) => s.split(/\n{2,}/)[0] ?? '';
const words = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 1);

/** Every published entry matching all the words typed (title and keywords count most). */
function searchAll(home: PublicHelpHome, q: string) {
  const terms = words(q);
  if (!terms.length) return [];
  const pool: (HelpArticleSummary & { body?: string; keywords?: string[] })[] = [...home.features, ...home.faqs, ...home.articles, ...home.guides];
  return pool
    .map((a) => {
      const title = words(a.title);
      const keys = (a.keywords ?? []).flatMap(words);
      const rest = words(`${a.summary} ${a.body ?? ''} ${a.categoryName}`);
      let score = 0;
      for (const t of terms) {
        const hit = (l: string[]) => l.some((w) => w.startsWith(t));
        const s = hit(title) ? 6 : hit(keys) ? 5 : hit(rest) ? 1 : 0;
        if (!s) return { a, score: 0 };
        score += s;
      }
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 8)
    .map((x) => x.a);
}

const POPULAR = ['Forgot password', 'Two-step verification', 'Mobile app', 'Free trial', 'Payroll', 'Security'];

export function SupportView({ home }: { home: PublicHelpHome }) {
  const [q, setQ] = useState('');
  const [faqCat, setFaqCat] = useState<string>('all');
  const [open, setOpen] = useState<string | null>(home.faqs[0]?.slug ?? null);
  const results = useMemo(() => searchAll(home, q), [home, q]);
  const faqCats = [...new Map(home.faqs.map((f) => [f.categoryKey, f.categoryName])).entries()];
  const faqs = faqCat === 'all' ? home.faqs : home.faqs.filter((f) => f.categoryKey === faqCat);

  return (
    <div className="hs min-h-dvh bg-bg text-fg" data-testid="public-help">
      <header className="hs-top sticky top-0 z-40 border-b border-border/60">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link href="/help-and-support" className="flex items-center gap-2" aria-label="SampCrew Help & Support">
            <img src="/brand/sampcrew-logo-light.svg" alt="SampCrew" width={140} height={37} className="h-8 w-auto dark:hidden" />
            <img src="/brand/sampcrew-logo-dark.svg" alt="" width={140} height={37} className="hidden h-8 w-auto dark:block" />
            <span className="hidden rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] font-semibold text-accent sm:inline">Help & Support</span>
          </Link>
          <nav className="ml-auto hidden items-center gap-5 text-sm font-medium text-fg-muted md:flex" aria-label="Sections">
            <a href="#features" className="hover:text-fg">Features</a>
            <a href="#offerings" className="hover:text-fg">What we offer</a>
            <a href="#faqs" className="hover:text-fg">FAQs</a>
            <a href="#guides" className="hover:text-fg">Guides</a>
          </nav>
          <Link href="/login" className="hs-btn ml-auto md:ml-2" data-testid="public-help-sign-in"><LogIn className="size-4" aria-hidden />Sign in</Link>
        </div>
      </header>

      <section className="hs-hero relative overflow-hidden">
        <span className="hs-blob hs-blob-1" aria-hidden />
        <span className="hs-blob hs-blob-2" aria-hidden />
        <span className="hs-blob hs-blob-3" aria-hidden />
        <div className="relative mx-auto grid max-w-4xl justify-items-center gap-5 px-4 pb-16 pt-14 text-center sm:pt-20">
          <span className="hs-pill hs-in"><LifeBuoy className="size-4" aria-hidden />SampCrew Help & Support</span>
          <h1 className="hs-in text-4xl font-black tracking-tight sm:text-6xl" style={{ '--d': '80ms' } as CSSProperties}>
            How can we <span className="hs-grad">help you</span> today?
          </h1>
          <p className="hs-in max-w-2xl text-base text-fg-muted sm:text-lg" style={{ '--d': '160ms' } as CSSProperties}>{home.welcome} Everything about SampCrew, in one place: our features, what we offer, answers and guides.</p>
          <div className="hs-in relative z-30 w-full max-w-2xl" style={{ '--d': '240ms' } as CSSProperties}>
            <label htmlFor="hs-q" className="sr-only">Search Help & Support</label>
            <Search className="pointer-events-none absolute left-5 top-1/2 size-5 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <input
              id="hs-q"
              className="hs-search"
              placeholder="Search features, questions or problems"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
              data-testid="public-help-search"
            />
            {q && <button type="button" className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full p-1 text-fg-subtle hover:text-fg" onClick={() => setQ('')} aria-label="Clear search"><X className="size-4" /></button>}
            {q.trim().length > 1 && (
              <div className="hs-results" role="listbox" aria-label="Search results" data-testid="public-help-results">
                {results.length ? results.map((r) => (
                  <Link key={r.slug} href={`/help-and-support/${r.slug}`} className="hs-result" role="option" aria-selected={false}>
                    <span className="hs-result-icon" style={tile(r.slug)}><HelpLineIcon icon={r.icon} className="size-4" /></span>
                    <span className="min-w-0 text-left">
                      <span className="block truncate font-semibold text-fg">{r.title}</span>
                      <span className="block truncate text-xs text-fg-muted">{r.categoryName} · {r.summary}</span>
                    </span>
                  </Link>
                )) : <p className="px-4 py-5 text-sm text-fg-muted">No answer matches “{q}”. Try other words, or <Link href="/login" className="font-semibold text-accent">sign in</Link> and raise a query.</p>}
              </div>
            )}
          </div>
          <div className="hs-in flex flex-wrap justify-center gap-2" style={{ '--d': '320ms' } as CSSProperties}>
            <span className="text-sm text-fg-subtle">Popular:</span>
            {POPULAR.map((p) => <button key={p} type="button" className="hs-chip" onClick={() => setQ(p)}>{p}</button>)}
          </div>
          <dl className="hs-in mt-4 grid w-full max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4" style={{ '--d': '400ms' } as CSSProperties}>
            {[
              [home.counts.feature, 'Features explained'],
              [home.counts.faq, 'Answers to FAQs'],
              [home.counts.article + home.guides.length, 'Articles & guides'],
              ['24×7', 'Raise a query anytime'],
            ].map(([n, l]) => (
              <div key={l} className="hs-stat"><dt className="text-xs text-fg-muted">{l}</dt><dd className="text-2xl font-black tracking-tight">{n}</dd></div>
            ))}
          </dl>
        </div>
      </section>

      <main className="mx-auto grid max-w-6xl gap-20 px-4 pb-20 sm:px-6">
        {home.categories.length > 0 && (
          <section aria-labelledby="hs-topics" className="-mt-6">
            <h2 id="hs-topics" className="sr-only">Topics</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {home.categories.map((c) => (
                <a key={c.key} href={c.key === 'our-features' ? '#features' : c.key === 'about-sampcrew' ? '#offerings' : '#faqs'} onClick={() => { if (faqCats.some(([k]) => k === c.key)) setFaqCat(c.key); }} className="hs-card hs-topic" data-testid="public-help-topic">
                  <span className="hs-icon" style={tile(c.key)}><HelpLineIcon icon={c.icon} className="size-5" /></span>
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-xs text-fg-muted">{c.description}</span>
                  <span className="mt-auto text-xs font-semibold text-accent">{c.count} {c.count === 1 ? 'article' : 'articles'}</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {home.features.length > 0 && (
          <section id="features" aria-labelledby="hs-features" className="scroll-mt-24">
            <SectionHead id="hs-features" kicker="Our features" title="Everything your people need, in one place" text="A short brief on every part of SampCrew: what it does and why it helps." />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="public-help-features">
              {home.features.map((f, i) => <FeatureCard key={f.slug} f={f} i={i} />)}
            </div>
          </section>
        )}

        {home.articles.length > 0 && (
          <section id="offerings" aria-labelledby="hs-offerings" className="scroll-mt-24">
            <SectionHead id="hs-offerings" kicker="What we offer" title="Our offerings, facilities and promises" text="How SampCrew is sold, supported and kept safe." />
            <div className="grid gap-4 lg:grid-cols-2" data-testid="public-help-articles">
              {home.articles.map((a) => (
                <Link key={a.slug} href={`/help-and-support/${a.slug}`} className="hs-card hs-article group">
                  <span className="hs-icon hs-icon-lg" style={tile(a.slug)}><HelpLineIcon icon={a.icon} className="size-6" /></span>
                  <span className="grid gap-1.5">
                    <span className="text-lg font-bold tracking-tight">{a.title}</span>
                    <span className="text-sm text-fg-muted">{a.summary}</span>
                    <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-accent">Read the article <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden /></span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {home.faqs.length > 0 && (
          <section id="faqs" aria-labelledby="hs-faqs" className="scroll-mt-24">
            <SectionHead id="hs-faqs" kicker="FAQs" title="Frequently asked questions" text="Quick answers about signing in, security, plans and SampCrew itself." />
            <div className="mb-5 flex flex-wrap gap-2" role="tablist" aria-label="FAQ topics">
              {[['all', 'All questions'] as [string, string], ...faqCats].map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={faqCat === k} className="hs-chip" data-on={faqCat === k} onClick={() => setFaqCat(k)}>{l}</button>
              ))}
            </div>
            <div className="hs-card divide-y divide-border p-0" data-testid="public-help-faqs">
              {faqs.map((f) => {
                const on = open === f.slug;
                return (
                  <div key={f.slug} className="hs-faq" data-open={on}>
                    <h3>
                      <button type="button" className="flex w-full items-center gap-3 px-5 py-4 text-left font-semibold" aria-expanded={on} aria-controls={`faq-${f.slug}`} onClick={() => setOpen(on ? null : f.slug)}>
                        <span className="flex-1">{f.title}</span>
                        <ChevronDown className="hs-faq-chev size-5 shrink-0 text-fg-subtle" aria-hidden />
                      </button>
                    </h3>
                    <div id={`faq-${f.slug}`} className="hs-faq-body" hidden={!on}>
                      <HelpBody text={f.body} className="px-5 pb-5 text-fg-muted" />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {home.guides.length > 0 && (
          <section id="guides" aria-labelledby="hs-guides" className="scroll-mt-24">
            <SectionHead id="hs-guides" kicker="Guides" title="Step by step" text="Short guides for the things people ask about most." />
            <div className="grid gap-4 md:grid-cols-2">
              {home.guides.map((g) => (
                <Link key={g.slug} href={`/help-and-support/${g.slug}`} className="hs-card hs-article group">
                  <span className="hs-icon" style={tile(g.slug)}><HelpLineIcon icon={g.icon} className="size-5" /></span>
                  <span className="grid gap-1">
                    <span className="font-bold">{g.title}</span>
                    <span className="text-sm text-fg-muted">{g.summary}</span>
                    <span className="text-xs font-semibold text-accent">{g.steps} steps</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="hs-cta" aria-labelledby="hs-cta">
          <Sparkles className="hs-cta-spark size-6" aria-hidden />
          <h2 id="hs-cta" className="text-2xl font-black tracking-tight sm:text-3xl">Still need help?</h2>
          <p className="max-w-xl text-white/85">Sign in and raise a query from Help & Support. You get a ticket ID and a reply from your HR Workspace, your Super Workspace or the SampCrew team.</p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link href="/login" className="hs-btn hs-btn-light"><MessageSquarePlus className="size-4" aria-hidden />Sign in to raise a query</Link>
            <Link href="/forgot-password" className="hs-btn hs-btn-ghost"><KeyRound className="size-4" aria-hidden />Forgot password</Link>
          </div>
        </section>
      </main>
      <footer className="border-t border-border py-8 text-center text-xs text-fg-subtle">© {new Date().getFullYear()} SAMPLEDGE · SampCrew · People, simplified.</footer>
    </div>
  );
}

function tile(key: string): CSSProperties {
  const [a, b] = toneFor(key);
  return { background: `linear-gradient(135deg, ${a}, ${b})`, boxShadow: `0 10px 24px -12px ${a}` };
}

function SectionHead({ id, kicker, title, text }: { id: string; kicker: string; title: string; text: string }) {
  return (
    <div className="mb-7 grid gap-2">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">{kicker}</p>
      <h2 id={id} className="text-3xl font-black tracking-tight sm:text-4xl">{title}</h2>
      <p className="max-w-2xl text-fg-muted">{text}</p>
    </div>
  );
}

function FeatureCard({ f, i }: { f: PublicHelpEntry; i: number }) {
  return (
    <Link href={`/help-and-support/${f.slug}`} className="hs-card hs-feature group" style={{ '--d': `${Math.min(i, 8) * 50}ms` } as CSSProperties} data-testid="public-help-feature">
      <span className="hs-icon" style={tile(f.slug)}><HelpLineIcon icon={f.icon} className="size-5" /></span>
      <span className="text-base font-bold tracking-tight">{f.title}</span>
      <span className="text-sm leading-relaxed text-fg-muted">{firstPara(f.body)}</span>
      <span className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-semibold text-accent">Learn more <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden /></span>
    </Link>
  );
}

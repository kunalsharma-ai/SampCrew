import { HELP_KIND_LABEL, type PublicHelpArticle } from '@crew/contracts';
import { HelpBody } from '@crew/ui';
import { ArrowLeft, ArrowRight, LogIn } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { HelpLineIcon } from '../icons';
import { toneFor } from '../tones';

export const dynamic = 'force-dynamic';

async function loadArticle(slug: string): Promise<PublicHelpArticle> {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) notFound();
  try {
    return await api<PublicHelpArticle>(`/public/help/articles/${slug}`, { auth: false });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = await loadArticle((await params).slug);
  return { title: { absolute: `${a.title} · SampCrew Help & Support` }, description: a.summary };
}

/** One public feature brief, article, FAQ or guide. */
export default async function PublicHelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const a = await loadArticle((await params).slug);
  const [c1, c2] = toneFor(a.slug);
  return (
    <div className="hs min-h-dvh bg-bg text-fg" data-testid="public-help-article">
      <header className="hs-top sticky top-0 z-40 border-b border-border/60">
        <div className="mx-auto flex h-16 max-w-4xl items-center gap-4 px-4 sm:px-6">
          <Link href="/help-and-support" className="inline-flex items-center gap-2 text-sm font-semibold text-fg-muted hover:text-fg"><ArrowLeft className="size-4" aria-hidden />Help & Support</Link>
          <Link href="/login" className="hs-btn ml-auto"><LogIn className="size-4" aria-hidden />Sign in</Link>
        </div>
      </header>
      <article className="mx-auto grid max-w-3xl gap-6 px-4 py-12 sm:px-6">
        <div className="hs-in grid gap-4">
          <span className="hs-icon hs-icon-lg" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})`, boxShadow: `0 12px 28px -12px ${c1}` }}><HelpLineIcon icon={a.icon} className="size-6" /></span>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">{HELP_KIND_LABEL[a.kind]} · {a.categoryName}</p>
          <h1 className="text-3xl font-black tracking-tight sm:text-5xl">{a.title}</h1>
          {a.summary && a.kind !== 'faq' && <p className="text-lg text-fg-muted">{a.summary}</p>}
        </div>
        {a.body && <div className="hs-card hs-in p-6 sm:p-8"><HelpBody text={a.body} className="text-[15px]" /></div>}
        {a.stepList.length > 0 && (
          <ol className="hs-in grid gap-3">
            {a.stepList.map((s, i) => (
              <li key={i} className="hs-card flex gap-4 p-5">
                <span className="grid size-9 shrink-0 place-items-center rounded-full text-sm font-black text-white" style={{ background: `linear-gradient(135deg, ${c1}, ${c2})` }}>{i + 1}</span>
                <span className="grid gap-1">
                  <span className="font-bold">{s.title}</span>
                  {s.body && <span className="text-sm text-fg-muted">{s.body}</span>}
                  {s.href && s.href.startsWith('/') && ['/login', '/forgot-password', '/signup', '/help-and-support'].some((p) => s.href!.startsWith(p)) && (
                    <Link href={s.href} className="inline-flex items-center gap-1 text-sm font-semibold text-accent">Open <ArrowRight className="size-4" aria-hidden /></Link>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
        {a.related.length > 0 && (
          <section className="grid gap-3 pt-4" aria-labelledby="hs-related">
            <h2 id="hs-related" className="text-lg font-bold">Related</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {a.related.map((r) => (
                <Link key={r.slug} href={`/help-and-support/${r.slug}`} className="hs-card hs-article group p-4">
                  <span className="hs-icon" style={{ background: `linear-gradient(135deg, ${toneFor(r.slug)[0]}, ${toneFor(r.slug)[1]})` }}><HelpLineIcon icon={r.icon} className="size-4" /></span>
                  <span className="grid gap-0.5"><span className="font-semibold">{r.title}</span><span className="text-xs text-fg-muted">{HELP_KIND_LABEL[r.kind]}</span></span>
                </Link>
              ))}
            </div>
          </section>
        )}
        <p className="text-sm text-fg-muted">Still stuck? <Link href="/login" className="font-semibold text-accent">Sign in</Link> and raise a query from Help & Support, or ask your HR Workspace.</p>
      </article>
    </div>
  );
}

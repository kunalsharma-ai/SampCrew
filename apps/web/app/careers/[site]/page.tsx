import { Badge, EmptyState } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { PublicJob } from '@/lib/types';
import { publicLoad } from '../public-api';

type Site = { organisation: string; headline: string; intro: string; jobs: PublicJob[] };
const MODE: Record<string, string> = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' };

export async function generateMetadata({ params }: { params: Promise<{ site: string }> }): Promise<Metadata> {
  const { site } = await params;
  const s = await publicLoad<Site>(`/public/careers/${encodeURIComponent(site)}`);
  return { title: { absolute: `Careers at ${s.organisation}` }, description: s.headline };
}

export default async function CareerSitePage({ params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  const s = await publicLoad<Site>(`/public/careers/${encodeURIComponent(site)}`);
  return (
    <div className="grid gap-8">
      <header className="grid gap-3">
        <div className="text-sm font-medium text-fg-muted">{s.organisation}</div>
        <h1 className="text-3xl font-semibold tracking-tight">{s.headline}</h1>
        {s.intro && <p className="whitespace-pre-wrap text-fg-muted">{s.intro}</p>}
      </header>
      <section aria-label="Open jobs" className="grid gap-3">
        <h2 className="text-lg font-semibold">Open jobs</h2>
        {s.jobs.length ? s.jobs.map((j) => (
          <Link key={j.slug} href={`/careers/${site}/${j.slug}`} className="grid gap-1 rounded-lg border border-border bg-surface p-4 shadow-card transition-colors hover:border-accent">
            <span className="font-medium text-accent">{j.title}</span>
            {j.summary && <span className="text-[0.8125rem] text-fg-muted">{j.summary}</span>}
            <span className="flex flex-wrap gap-1.5 pt-1">
              <Badge>{j.department}</Badge>
              <Badge>{MODE[j.workMode] ?? j.workMode}</Badge>
              {j.locationText && <Badge>{j.locationText}</Badge>}
            </span>
          </Link>
        )) : <EmptyState title="No open jobs right now" description="Check back soon." />}
      </section>
    </div>
  );
}

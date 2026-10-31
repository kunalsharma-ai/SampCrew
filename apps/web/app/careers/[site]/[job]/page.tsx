import { Badge } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { PublicJob } from '@/lib/types';
import { publicLoad } from '../../public-api';
import { ApplyForm } from './apply-form';

type Job = { organisation: string; job: PublicJob & { description: string }; privacyNotice: string };
const MODE: Record<string, string> = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' };
const TYPE: Record<string, string> = { full_time: 'Full time', part_time: 'Part time', contract: 'Contract', intern: 'Internship', temporary: 'Temporary' };

function salary(j: PublicJob) {
  if (!j.salaryMin && !j.salaryMax) return null;
  const fmt = (v: string) => {
    const [whole] = v.split('.');
    return j.currency === 'INR' ? whole!.replace(/(\d)(?=(\d\d)+\d$)/g, '$1,') : whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };
  return `${j.currency} ${[j.salaryMin, j.salaryMax].filter(Boolean).map((v) => fmt(v!)).join(' to ')} a year`;
}

export async function generateMetadata({ params }: { params: Promise<{ site: string; job: string }> }): Promise<Metadata> {
  const { site, job } = await params;
  const d = await publicLoad<Job>(`/public/careers/${encodeURIComponent(site)}/jobs/${encodeURIComponent(job)}`);
  return { title: { absolute: `${d.job.title} at ${d.organisation}` }, description: d.job.summary || undefined };
}

export default async function JobPage({ params }: { params: Promise<{ site: string; job: string }> }) {
  const { site, job } = await params;
  const d = await publicLoad<Job>(`/public/careers/${encodeURIComponent(site)}/jobs/${encodeURIComponent(job)}`);
  const pay = salary(d.job);
  return (
    <div className="grid gap-8">
      <Link href={`/careers/${site}`} className="text-sm font-medium text-accent hover:underline">All jobs at {d.organisation}</Link>
      <header className="grid gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{d.job.title}</h1>
        <div className="flex flex-wrap gap-1.5">
          <Badge>{d.job.department}</Badge>
          <Badge>{TYPE[d.job.employmentType] ?? d.job.employmentType}</Badge>
          <Badge>{MODE[d.job.workMode] ?? d.job.workMode}</Badge>
          {d.job.locationText && <Badge>{d.job.locationText}</Badge>}
          {pay && <Badge tone="accent">{pay}</Badge>}
        </div>
        {d.job.summary && <p className="text-fg-muted">{d.job.summary}</p>}
      </header>
      <article className="whitespace-pre-wrap text-[15px] leading-relaxed">{d.job.description}</article>
      <ApplyForm site={site} job={job} privacyNotice={d.privacyNotice} organisation={d.organisation} />
    </div>
  );
}

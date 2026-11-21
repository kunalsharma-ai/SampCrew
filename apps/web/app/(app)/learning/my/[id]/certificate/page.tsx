import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { creatorLabel, dateLabel, minutesLabel } from '../../../labels';
import type { Certificate } from '../../../types';
import { PrintButton } from './print-button';

export const metadata: Metadata = { title: 'Certificate' };

export default async function CertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const c = await load<Certificate>(`/learning/my/${id}/certificate`);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href={`/learning/my/${id}`} className="text-sm text-fg-muted hover:underline">Back to the module</Link>
        <PrintButton />
      </div>
      <article className="mx-auto grid w-full max-w-3xl gap-6 rounded-2xl border-4 border-double border-accent/50 bg-bg-elevated p-10 text-center shadow-sm print:border-black print:shadow-none" data-testid="certificate">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">{c.certificateNo ? 'Certificate of completion' : 'Completion record'}</p>
        <div className="grid gap-1">
          <p className="text-sm text-fg-muted">This is to certify that</p>
          <h1 className="text-3xl font-semibold">{c.employeeName}</h1>
          {c.employeeCode && <p className="text-xs text-fg-subtle">Employee ID {c.employeeCode}</p>}
        </div>
        <div className="grid gap-1">
          <p className="text-sm text-fg-muted">has completed the learning module</p>
          <h2 className="text-xl font-semibold">{c.moduleTitle}</h2>
          <p className="text-xs text-fg-subtle">Version {c.version}{minutesLabel(c.durationMinutes) ? ` · ${minutesLabel(c.durationMinutes)}` : ''}</p>
        </div>
        <dl className="mx-auto grid gap-4 text-sm sm:grid-cols-3">
          <div><dt className="text-xs text-fg-subtle">Completed on</dt><dd className="font-medium">{dateLabel(c.completedOn)}</dd></div>
          <div><dt className="text-xs text-fg-subtle">Score</dt><dd className="font-medium">{c.scorePercent !== null ? `${c.scorePercent}%` : 'Not scored'}</dd></div>
          <div><dt className="text-xs text-fg-subtle">Certificate number</dt><dd className="font-mono font-medium">{c.certificateNo ?? '—'}</dd></div>
        </dl>
        <footer className="grid gap-1 border-t border-border pt-4 text-xs text-fg-muted">
          <span>Issued by {c.issuedBy}</span>
          <span>Module by {creatorLabel(c.creator)}</span>
        </footer>
      </article>
    </div>
  );
}

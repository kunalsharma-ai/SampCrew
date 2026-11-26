import { EmptyState, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { LiveDocuments } from '../../documents/ui';
import { ChecklistView } from '../checklist-view';
import type { Checklist } from '../types';
import { fmtDay, ProgressBar } from '../ui';

export const metadata: Metadata = { title: 'My onboarding documents' };

export default async function MyOnboardingDocumentsPage() {
  const { active, history } = await load<{ active: Checklist | null; history: Checklist[] }>('/onboarding-documents/mine');
  return (
    <>
      <LiveDocuments />
      <PageHeader title="My onboarding documents" description="The documents HR asked for when you joined. Upload each one here; HR approves it or tells you what to change. A document is done only once HR approves it." />
      {active ? <ChecklistView c={active} /> : <EmptyState title="Nothing to upload" description={history.length ? 'Your onboarding documents are complete.' : 'HR has not asked you for onboarding documents.'} />}
      {history.length > 0 && (
        <section className="mt-6 grid gap-3">
          <h2 className="text-sm font-semibold">Onboarding history</h2>
          {history.map((h) => (
            <details key={h.id} className="rounded-xl border border-border p-4">
              <summary className="cursor-pointer text-sm font-medium">{h.templateName ?? 'Onboarding documents'} · {h.status === 'completed' ? `completed ${fmtDay(h.completedAt)}` : h.status}</summary>
              <div className="mt-3 grid gap-3">
                <ProgressBar percent={h.progress.percent} />
                <ul className="grid gap-1 text-sm">{h.items.map((i) => <li key={i.requestId}><Link className="text-accent hover:underline" href={`/documents/requests/${i.requestId}`}>{i.title}</Link> <span className="text-fg-subtle">· {i.statusLabel}</span></li>)}</ul>
              </div>
            </details>
          ))}
        </section>
      )}
    </>
  );
}

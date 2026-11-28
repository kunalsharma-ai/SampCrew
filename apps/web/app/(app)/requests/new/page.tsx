import { PageHeader } from '@crew/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load } from '@/lib/api';
import { todayIn } from '@/lib/time';
import type { Me } from '@/lib/types';
import type { RequestOptions } from '../types';
import { RequestForm } from './request-form';

export const metadata: Metadata = { title: 'Create request' };

/** Create Request: any category the Super Workspace switched on for the person's level (leave has its own form). */
export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const sp = await searchParams;
  if (sp.kind === 'leave') redirect('/leave/apply');
  const [options, me] = await Promise.all([load<RequestOptions>('/requests/options'), load<Me>('/me')]);
  const categories = options.categories.filter((c) => c.kind !== 'leave');
  const initial = categories.find((c) => c.key === sp.kind)?.key ?? categories[0]?.key ?? 'other';
  return (
    <>
      <Link href="/requests" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Requests</Link>
      <PageHeader title="Create request" eyebrow={options.me.levelLabel} description="Choose the type, say when and why, attach any documents, and choose your approvers and the people to keep in CC." />
      {categories.length ? <RequestForm options={options} categories={categories} initial={initial} today={todayIn(me.tenant.timezone)} /> : <p className="text-sm text-fg-muted">No request types are switched on for you. Ask your Super Workspace.</p>}
    </>
  );
}

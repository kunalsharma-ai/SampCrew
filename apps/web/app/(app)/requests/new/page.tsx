import { REQUEST_KINDS, type RequestKind } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { todayIn } from '@/lib/time';
import type { Me } from '@/lib/types';
import type { RequestOptions } from '../types';
import { RaiseRequestForm } from './raise-form';

export const metadata: Metadata = { title: 'Raise a request' };

export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const sp = await searchParams;
  const [options, me] = await Promise.all([load<RequestOptions>('/requests/options'), load<Me>('/me')]);
  const kind = (REQUEST_KINDS as readonly string[]).includes(sp.kind ?? '') ? (sp.kind as RequestKind) : 'wfh';
  return (
    <>
      <Link href="/requests" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Requests</Link>
      <PageHeader title="Raise a request" eyebrow={options.me.levelLabel} description="Choose the type, say when and why, and loop in the people who should approve. Everyone you loop in gets it in their Approvals at the same time." />
      <RaiseRequestForm options={options} initialKind={kind} today={todayIn(me.tenant.timezone)} />
    </>
  );
}

import type { HelpQueryDetail } from '@crew/contracts';
import { HelpQueryDetailView } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ConsoleHelp } from '@/components/help-centre';
import { ApiError, load } from '@/lib/api';

export const metadata: Metadata = { title: 'Help query' };

export default async function HelpQueryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const d = await load<HelpQueryDetail>(`/platform/help/queries/${id}`).catch((e) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; });
  // Console replies carry no attachments (files arrive from the companies' side).
  return <ConsoleHelp><HelpQueryDetailView d={d} mode="console" settings={{ attachments: false }} /></ConsoleHelp>;
}

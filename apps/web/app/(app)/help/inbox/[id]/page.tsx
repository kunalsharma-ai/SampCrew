import type { HelpHome, HelpQueryDetail } from '@crew/contracts';
import { HelpQueryDetailView } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, api, load } from '@/lib/api';
import { WebHelp } from '../../help-centre';

export const metadata: Metadata = { title: 'Query' };

export default async function InboxQueryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const d = await api<HelpQueryDetail>(`/help/inbox/${id}`).catch((e) => { if (e instanceof ApiError && (e.status === 404 || e.status === 403)) notFound(); throw e; });
  const home = await load<HelpHome>('/help');
  return <WebHelp mode="inbox"><HelpQueryDetailView d={d} mode="inbox" settings={home.settings} /></WebHelp>;
}

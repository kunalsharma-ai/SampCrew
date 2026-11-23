import type { HelpHome, HelpQueryDetail } from '@crew/contracts';
import { HelpQueryDetailView } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, api, load } from '@/lib/api';
import { WebHelp } from '../../help-centre';

export const metadata: Metadata = { title: 'Query' };

export default async function MyQueryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const d = await api<HelpQueryDetail>(`/help/queries/${id}`).catch((e) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; });
  const home = await load<HelpHome>('/help');
  // Someone who handles this query (it reached their inbox) answers it from the inbox view.
  const handler = d.can.handle;
  return <WebHelp mode={handler ? 'inbox' : 'mine'}><HelpQueryDetailView d={d} mode={handler ? 'inbox' : 'mine'} settings={home.settings} /></WebHelp>;
}

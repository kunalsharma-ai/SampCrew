import type { HelpQueryList } from '@crew/contracts';
import { HelpQueryListView } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { WebHelp } from '../help-centre';

export const metadata: Metadata = { title: 'Queries inbox' };

type Search = { q?: string; status?: string; assigned?: string };

export default async function QueriesInboxPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const p = new URLSearchParams();
  if (sp.q) p.set('q', sp.q);
  if (sp.status) p.set('status', sp.status);
  if (sp.assigned) p.set('assigned', sp.assigned);
  const list = await load<HelpQueryList>(`/help/inbox?${p}`);
  return <WebHelp mode="inbox"><HelpQueryListView list={list} mode="inbox" search={sp} /></WebHelp>;
}

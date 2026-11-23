import type { HelpQueryList } from '@crew/contracts';
import { HelpQueryListView } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { WebHelp } from '../help-centre';

export const metadata: Metadata = { title: 'My queries' };

type Search = { q?: string; status?: string };

export default async function MyQueriesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const p = new URLSearchParams();
  if (sp.q) p.set('q', sp.q);
  if (sp.status) p.set('status', sp.status);
  const list = await load<HelpQueryList>(`/help/queries?${p}`);
  return <WebHelp><HelpQueryListView list={list} mode="mine" search={sp} raise /></WebHelp>;
}

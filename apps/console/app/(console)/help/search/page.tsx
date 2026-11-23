import type { HelpHome, HelpSearchResult } from '@crew/contracts';
import { HelpSearchView } from '@crew/ui';
import type { Metadata } from 'next';
import { ConsoleHelp } from '@/components/help-centre';
import { load } from '@/lib/api';

export const metadata: Metadata = { title: 'Search help' };

type Search = { q?: string; kind?: string; category?: string };

export default async function ConsoleHelpSearch({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const p = new URLSearchParams(Object.entries(sp).filter(([, v]) => typeof v === 'string' && v) as [string, string][]);
  const result = await load<HelpSearchResult>(`/platform/help/search?${p}`);
  const home = await load<HelpHome>('/platform/help');
  return <ConsoleHelp><HelpSearchView result={result} query={sp} categories={home.categories} raise={false} /></ConsoleHelp>;
}

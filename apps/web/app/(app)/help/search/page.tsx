import type { HelpHome, HelpSearchResult } from '@crew/contracts';
import { HelpSearchView } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { WebHelp } from '../help-centre';

export const metadata: Metadata = { title: 'Search help' };

type Search = { q?: string; kind?: string; category?: string };

export default async function HelpSearchPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const p = new URLSearchParams(Object.entries(sp).filter(([, v]) => typeof v === 'string' && v) as [string, string][]);
  const result = await load<HelpSearchResult>(`/help/search?${p}`);
  const home = await load<HelpHome>('/help');
  return <WebHelp><HelpSearchView result={result} query={sp} categories={home.categories} raise={home.queries.raise} /></WebHelp>;
}

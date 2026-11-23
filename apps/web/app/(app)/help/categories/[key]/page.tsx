import type { HelpArticleSummary, HelpCategoryView, HelpHome } from '@crew/contracts';
import { HelpCategoryPageView } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, api, load } from '@/lib/api';
import { WebHelp } from '../../help-centre';

export const metadata: Metadata = { title: 'Help category' };

type Data = { category: HelpCategoryView; parent: HelpCategoryView | null; subcategories: HelpCategoryView[]; articles: HelpArticleSummary[] };

export default async function HelpCategoryPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // A category hidden from this person (another level, a feature that is off) is simply not found.
  const data = await api<Data>(`/help/categories/${encodeURIComponent(key)}`).catch((e) => { if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound(); throw e; });
  const home = await load<HelpHome>('/help');
  return <WebHelp><HelpCategoryPageView data={data} raise={home.queries.raise} /></WebHelp>;
}

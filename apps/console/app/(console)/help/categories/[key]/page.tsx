import type { HelpArticleSummary, HelpCategoryView } from '@crew/contracts';
import { HelpCategoryPageView } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ConsoleHelp } from '@/components/help-centre';
import { ApiError, load } from '@/lib/api';

export const metadata: Metadata = { title: 'Help category' };

type Data = { category: HelpCategoryView; parent: HelpCategoryView | null; subcategories: HelpCategoryView[]; articles: HelpArticleSummary[] };

export default async function ConsoleHelpCategory({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const data = await load<Data>(`/platform/help/categories/${encodeURIComponent(key)}`).catch((e) => { if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound(); throw e; });
  return <ConsoleHelp><HelpCategoryPageView data={data} raise={false} /></ConsoleHelp>;
}

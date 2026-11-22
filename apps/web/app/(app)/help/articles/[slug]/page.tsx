import type { HelpArticleView, HelpHome } from '@crew/contracts';
import { HelpArticlePageView } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, api, load } from '@/lib/api';
import { WebHelp } from '../../help-centre';

export const metadata: Metadata = { title: 'Help article' };

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await api<HelpArticleView>(`/help/articles/${encodeURIComponent(slug)}`).catch((e) => { if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound(); throw e; });
  const home = await load<HelpHome>('/help');
  return <WebHelp><HelpArticlePageView article={article} raise={home.queries.raise} /></WebHelp>;
}

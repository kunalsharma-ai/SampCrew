import type { HelpArticleView } from '@crew/contracts';
import { HelpArticlePageView } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ConsoleHelp } from '@/components/help-centre';
import { ApiError, load } from '@/lib/api';

export const metadata: Metadata = { title: 'Help article' };

export default async function ConsoleHelpArticle({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await load<HelpArticleView>(`/platform/help/articles/${encodeURIComponent(slug)}`).catch((e) => { if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound(); throw e; });
  return <ConsoleHelp><HelpArticlePageView article={article} raise={false} /></ConsoleHelp>;
}

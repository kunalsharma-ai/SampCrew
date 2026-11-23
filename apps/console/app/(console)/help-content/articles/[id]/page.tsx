import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, load } from '@/lib/api';
import type { ManageData } from '../../manager';
import { ArticleEditor, type EditableArticle } from './editor';

export const metadata: Metadata = { title: 'Edit help article' };

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const isNew = id === 'new';
  if (!isNew && !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await load<ManageData>('/platform/help/manage');
  const article = isNew ? null : await load<EditableArticle>(`/platform/help/manage/articles/${id}`).catch((e) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; });
  return (
    <>
      <PageHeader title={article ? `Edit: ${article.title}` : 'New help article'} description="Write the answer or the steps, choose its category, who sees it and what it is linked to. Drafts are only visible here." />
      <ArticleEditor article={article} categories={data.categories} slugs={data.articles.map((a) => ({ slug: a.slug, title: a.title }))} />
    </>
  );
}

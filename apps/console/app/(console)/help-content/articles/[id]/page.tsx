import { HELP_ARTICLE_KINDS, type HelpArticleKind } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, load } from '@/lib/api';
import type { ManageData } from '../../manager';
import { ArticleEditor, type EditableArticle } from './editor';

export const metadata: Metadata = { title: 'Edit help article' };

export default async function ArticlePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ kind?: string; audience?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  // "New feature brief" and "New public FAQ" open the editor with the kind and the public audience chosen.
  const startKind = HELP_ARTICLE_KINDS.includes(sp.kind as HelpArticleKind) ? (sp.kind as HelpArticleKind) : undefined;
  const startPublic = sp.audience === 'public';
  const isNew = id === 'new';
  if (!isNew && !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const data = await load<ManageData>('/platform/help/manage');
  const article = isNew ? null : await load<EditableArticle>(`/platform/help/manage/articles/${id}`).catch((e) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; });
  return (
    <>
      <PageHeader title={article ? `Edit: ${article.title}` : 'New help article'} description="Write the answer or the steps, choose its category, who sees it and what it is linked to. Drafts are only visible here." />
      <ArticleEditor article={article} startKind={startKind} startPublic={startPublic} categories={data.categories} slugs={data.articles.map((a) => ({ slug: a.slug, title: a.title }))} />
    </>
  );
}

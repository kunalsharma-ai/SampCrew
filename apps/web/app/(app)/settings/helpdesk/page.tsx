import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Article, Category, Handler } from '../../helpdesk/types';
import { HelpdeskSettings } from './helpdesk-settings';

export const metadata: Metadata = { title: 'Helpdesk settings' };

export default async function HelpdeskSettingsPage() {
  const [categories, handlers, articles] = await Promise.all([
    load<Category[]>('/helpdesk/categories?manage=true'),
    load<Handler[]>('/helpdesk/handlers'),
    load<Article[]>('/helpdesk/articles?all=true'),
  ]);
  return (
    <>
      <PageHeader title="Helpdesk settings" description="Categories people choose when they ask HR, who handles each one, response targets, and help articles." />
      <HelpdeskSettings categories={categories} handlers={handlers} articles={articles} />
    </>
  );
}

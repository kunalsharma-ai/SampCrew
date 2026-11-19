import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Category } from '../types';
import { CategoriesView } from './categories-view';

export const metadata: Metadata = { title: 'Asset categories' };

export default async function AssetCategoriesPage() {
  const categories = await load<Category[]>('/assets/categories');
  return (
    <>
      <PageHeader title="Asset categories" description="The kinds of property you track. Each has a short code used to number its assets (LAP-0001). Archived categories keep their assets." />
      <CategoriesView categories={categories} />
    </>
  );
}

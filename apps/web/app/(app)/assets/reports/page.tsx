import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Category } from '../types';
import { ReportsView } from './reports-view';

export const metadata: Metadata = { title: 'Asset reports' };

export default async function AssetReportsPage() {
  const categories = await load<Category[]>('/assets/categories');
  return (
    <>
      <PageHeader title="Asset reports" description="Download any report as Excel (full detail) or PDF (to print or share). Each download is recorded in the audit trail." />
      <ReportsView categories={categories} />
    </>
  );
}

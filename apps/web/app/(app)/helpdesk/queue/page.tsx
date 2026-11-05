import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { CaseRow, Category } from '../types';
import { QueueView } from './queue-view';

export const metadata: Metadata = { title: 'HR helpdesk queue' };

export default async function QueuePage({ searchParams }: { searchParams: Promise<{ status?: string; assigned?: string; q?: string }> }) {
  const sp = await searchParams;
  const status = sp.status ?? 'active';
  const assigned = sp.assigned ?? 'all';
  const q = sp.q ?? '';
  const params = new URLSearchParams({ view: 'queue', status, assigned, ...(q ? { q } : {}) });
  const [cases, categories] = await Promise.all([load<CaseRow[]>(`/helpdesk/cases?${params}`), load<Category[]>('/helpdesk/categories')]);
  return (
    <>
      <PageHeader title="HR helpdesk queue" description="Cases you can handle, most urgent first. Response targets count calendar hours from when the case was raised." />
      <QueueView cases={cases} categories={categories} filters={{ status, assigned, q }} />
    </>
  );
}

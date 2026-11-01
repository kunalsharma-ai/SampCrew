import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { CaseDetail, Category, Handler } from '../types';
import { CaseView } from './case-view';

export const metadata: Metadata = { title: 'HR case' };

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await load<CaseDetail>(`/helpdesk/cases/${id}`);
  const handler = c.role === 'handler';
  const [handlers, categories] = handler ? await Promise.all([load<Handler[]>('/helpdesk/handlers'), load<Category[]>('/helpdesk/categories')]) : [[], []];
  return (
    <>
      <PageHeader
        eyebrow={c.ref}
        title={c.subject}
        description={handler ? `${c.employeeName} · ${c.categoryName}` : c.categoryName}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href={handler ? '/helpdesk/queue' : '/helpdesk'}>{handler ? 'Back to queue' : 'All my cases'}</Link>}
      />
      <CaseView c={c} handlers={handlers} categories={categories} />
    </>
  );
}

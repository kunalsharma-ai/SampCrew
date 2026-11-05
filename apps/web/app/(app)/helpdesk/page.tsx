import { PageHeader, buttonClass } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import type { Article, CaseRow, Category } from './types';
import { HelpdeskHome } from './helpdesk-home';

export const metadata: Metadata = { title: 'Ask HR' };

export default async function HelpdeskPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const all = show === 'all';
  const me = await load<Me>('/me');
  const [categories, cases, articles] = await Promise.all([
    load<Category[]>('/helpdesk/categories'),
    load<CaseRow[]>(`/helpdesk/cases?view=mine${all ? '' : '&status=active'}`),
    load<Article[]>('/helpdesk/articles'),
  ]);
  return (
    <>
      <PageHeader
        title="Ask HR"
        description="Questions about pay, leave, documents or anything else. Only you and the HR team handling it can see your case; your manager cannot."
        actions={can(me, 'helpdesk:manage') ? <Link className={buttonClass('secondary', 'sm')} href="/helpdesk/queue">HR queue</Link> : undefined}
      />
      <HelpdeskHome categories={categories} cases={cases} articles={articles} showAll={all} />
    </>
  );
}

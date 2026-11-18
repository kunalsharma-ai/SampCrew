import { PageHeader, buttonClass } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { load, loadOptional } from '@/lib/api';
import { AssistantPanel } from '../ai/assistant-panel';
import type { AiStatus } from '../ai/types';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import type { Article, CaseRow, Category } from './types';
import { HelpdeskHome } from './helpdesk-home';

export const metadata: Metadata = { title: 'Ask HR' };

export default async function HelpdeskPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const all = show === 'all';
  const me = await load<Me>('/me');
  // The HR team answers questions rather than asking them: their helpdesk is the queue of employees' cases.
  if (can(me, 'helpdesk:manage')) redirect('/helpdesk/queue');
  const [categories, cases, articles, ai] = await Promise.all([
    load<Category[]>('/helpdesk/categories'),
    load<CaseRow[]>(`/helpdesk/cases?view=mine&status=${all ? 'all' : 'active'}`),
    load<Article[]>('/helpdesk/articles'),
    loadOptional<AiStatus>('/ai/status'),
  ]);
  return (
    <>
      <PageHeader
        title="Ask HR"
        description="Questions about pay, leave, documents or anything else. Only you and the HR team handling it can see your case; your manager cannot."
      />
      {ai?.features.assistant.available && <div className="mb-6"><AssistantPanel /></div>}
      <HelpdeskHome categories={categories} cases={cases} articles={articles} showAll={all} />
    </>
  );
}

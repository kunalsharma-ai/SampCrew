import { ModuleNotices } from '@/components/module-notices';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { InboxItem } from '@/lib/types';
import { ApprovalsBoard } from './approvals-board';
import type { ApprovalOverview, ApprovalRow } from './types';

export const metadata: Metadata = { title: 'Approvals' };

const VIEWS = ['waiting', 'mine', 'decided'] as const;

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const view = (VIEWS as readonly string[]).includes(sp.view ?? '') ? (sp.view as (typeof VIEWS)[number]) : 'waiting';
  const category = sp.category && /^[a-z][a-z0-9_]{1,39}$/.test(sp.category) ? sp.category : null;
  const status = sp.status && ['pending', 'approved', 'rejected', 'cancelled'].includes(sp.status) ? sp.status : null;
  const listQuery = new URLSearchParams({ view, limit: '100' });
  if (category) listQuery.set('category', category);
  if (status) listQuery.set('status', status);
  const [overview, waitingCounts, mineCounts, inbox, rows] = await Promise.all([
    load<ApprovalOverview>(`/approvals/overview?view=${view}`),
    view === 'waiting' ? null : load<ApprovalOverview>('/approvals/overview?view=waiting'),
    view === 'mine' ? null : load<ApprovalOverview>('/approvals/overview?view=mine'),
    view === 'waiting' ? load<InboxItem[]>('/approvals/inbox') : Promise.resolve(null),
    view === 'waiting' ? Promise.resolve(null) : load<ApprovalRow[]>(`/approvals/requests?${listQuery}`),
  ]);
  const counts = {
    waiting: (view === 'waiting' ? overview : waitingCounts)!.pending,
    mine: (view === 'mine' ? overview : mineCounts)!.pending,
  };
  return (
    <>
      <PageHeader title="Approvals" description="Requests by category: those waiting for your decision, your own requests and their status, and what you decided. Every decision is recorded in the audit trail." />
      <ModuleNotices category="approvals" label="Approval" />
      <ApprovalsBoard view={view} overview={overview} counts={counts} inbox={inbox} rows={rows} category={category} status={status} />
    </>
  );
}

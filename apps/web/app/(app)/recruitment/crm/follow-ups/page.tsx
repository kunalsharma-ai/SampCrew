import { FOLLOW_UP_PRIORITIES } from '@crew/contracts';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { CrmShell } from '../crm-shell';
import type { CrmContext, FollowUp } from '../crm-types';
import { FollowUpBoard } from './follow-up-board';

export const metadata: Metadata = { title: 'Follow-ups · Candidate CRM' };
const BUCKETS = ['overdue', 'today', 'upcoming', 'completed', 'missed', 'open', 'all'];

export default async function CrmFollowUpsPage({ searchParams }: { searchParams: Promise<{ bucket?: string; assigned?: string; type?: string; priority?: string }> }) {
  const sp = await searchParams;
  const bucket = BUCKETS.includes(sp.bucket ?? '') ? sp.bucket! : 'open';
  const assigned = sp.assigned && /^(me|all|[0-9a-f-]{36})$/.test(sp.assigned) ? sp.assigned : 'me';
  const qs = new URLSearchParams({ bucket, assigned });
  if (sp.type && /^[a-z_]{2,40}$/.test(sp.type)) qs.set('type', sp.type);
  if (sp.priority && (FOLLOW_UP_PRIORITIES as readonly string[]).includes(sp.priority)) qs.set('priority', sp.priority);
  const [ctx, data] = await Promise.all([
    load<CrmContext>('/recruitment/crm/context'),
    load<{ counts: Record<string, number>; rows: FollowUp[] }>(`/recruitment/crm/follow-ups?${qs}`),
  ]);
  return (
    <CrmShell ctx={ctx} current="/recruitment/crm/follow-ups" title="Follow-ups" description="Calls and tasks to do, with reminders in your notifications. Overdue ones come first." overdue={data.counts.overdue}>
      <FollowUpBoard ctx={ctx} counts={data.counts} rows={data.rows} bucket={bucket} assigned={assigned} type={qs.get('type') ?? ''} priority={qs.get('priority') ?? ''} />
    </CrmShell>
  );
}

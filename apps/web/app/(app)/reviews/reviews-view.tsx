'use client';
import { Badge, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { CYCLE_STATUS, CYCLE_TONE, FEEDBACK_STATUS, FEEDBACK_TONE, PART_STATUS } from '../talent/labels';
import type { FeedbackListItem, ReviewListItem } from '../talent/types';

const TABS = [{ v: 'mine', l: 'My reviews' }, { v: 'team', l: 'Reviews I write' }, { v: 'feedback', l: 'Feedback asked of me' }];

export function ReviewsView({ view, items }: { view: 'mine' | 'team' | 'feedback'; items: (ReviewListItem | FeedbackListItem)[] }) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link key={t.v} href={t.v === 'mine' ? '/reviews' : `/reviews?view=${t.v}`} className={`rounded-full px-3 py-1 text-[13px] font-medium ${view === t.v ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg'}`}>{t.l}</Link>
        ))}
      </div>
      <Card>
        <CardHeader title={TABS.find((t) => t.v === view)!.l} />
        {!items.length ? (
          <EmptyState icon={<MessagesSquare className="size-5" />} title="Nothing here yet" description={view === 'feedback' ? 'When a manager asks for your view of a colleague, it appears here.' : 'Reviews appear when HR launches a review cycle.'} />
        ) : view === 'feedback' ? (
          <Table>
            <THead><tr><TH>About</TH><TH>Cycle</TH><TH>Status</TH><TH /></tr></THead>
            <TBody>
              {(items as FeedbackListItem[]).map((f) => (
                <TR key={f.id}>
                  <TD className="font-medium">{f.employeeName}</TD>
                  <TD className="text-fg-muted">{f.cycleName}</TD>
                  <TD><Badge tone={FEEDBACK_TONE[f.status] ?? 'neutral'} dot>{FEEDBACK_STATUS[f.status] ?? f.status}</Badge></TD>
                  <TD className="text-right"><Link className="text-[13px] font-medium text-accent hover:underline" href={`/reviews/feedback/${f.id}`}>{f.status === 'requested' && f.cycleStatus === 'active' ? 'Give feedback' : 'Open'}</Link></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <Table>
            <THead><tr>{view === 'team' && <TH>Person</TH>}<TH>Cycle</TH><TH>Stage</TH><TH>Self review</TH><TH>Manager review</TH><TH /></tr></THead>
            <TBody>
              {(items as ReviewListItem[]).map((r) => (
                <TR key={r.id}>
                  {view === 'team' && <TD className="font-medium">{r.employeeName}{r.excluded && <span className="ml-1 text-xs text-fg-muted">(left out)</span>}</TD>}
                  <TD>{r.cycleName}</TD>
                  <TD><Badge tone={CYCLE_TONE[r.cycleStatus] ?? 'neutral'} dot>{CYCLE_STATUS[r.cycleStatus] ?? r.cycleStatus}</Badge></TD>
                  <TD className="text-fg-muted">{r.selfReview ? PART_STATUS[r.selfStatus] : 'Not needed'}{r.selfStatus === 'pending' && r.selfDue ? ` · due ${r.selfDue}` : ''}</TD>
                  <TD className="text-fg-muted">{PART_STATUS[r.managerStatus]}{r.managerStatus === 'pending' && r.managerDue ? ` · due ${r.managerDue}` : ''}</TD>
                  <TD className="text-right">
                    <Link className="text-[13px] font-medium text-accent hover:underline" href={`/reviews/${r.id}`}>
                      {view === 'mine' && r.releasedAt && !r.acknowledgedAt ? 'Read your results' : view === 'mine' && r.selfStatus === 'pending' && r.cycleStatus === 'active' ? 'Write self review' : view === 'team' && r.managerStatus === 'pending' && r.cycleStatus === 'active' ? 'Write review' : 'Open'}
                    </Link>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

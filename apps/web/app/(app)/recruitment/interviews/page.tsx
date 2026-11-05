import { Badge, Card, CardHeader, EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { MyInterview } from '@/lib/types';
import { MODE, when } from '../labels';

export const metadata: Metadata = { title: 'My interviews' };

export default async function MyInterviewsPage() {
  const items = await load<MyInterview[]>('/recruitment/interviews/mine');
  const now = Date.now();
  return (
    <>
      <PageHeader title="My interviews" description="Interviews you are on the panel for. Submit your scorecard after each one; you see others' scorecards once yours is in." />
      <Card>
        <CardHeader title="Interviews" />
        {items.length ? (
          <Table>
            <THead><tr><TH>Candidate</TH><TH>Interview</TH><TH>When</TH><TH>Your scorecard</TH></tr></THead>
            <TBody>
              {items.map((i) => {
                const started = Date.parse(i.startsAt) <= now;
                return (
                  <TR key={i.id}>
                    <TD><Link className="font-medium text-accent hover:underline" href={`/recruitment/interviews/${i.id}`}>{i.candidateName}</Link><div className="text-xs text-fg-muted">{i.requisitionTitle}</div></TD>
                    <TD>{i.title}<div className="text-xs text-fg-muted">{MODE[i.mode]} · {i.durationMinutes} min</div></TD>
                    <TD className="tabular-nums">{when(i.startsAt)}</TD>
                    <TD>
                      {i.status === 'cancelled' ? <Badge tone="neutral">Cancelled</Badge>
                        : i.submitted ? <Badge tone="success" dot>Submitted</Badge>
                        : started ? <Badge tone="warning" dot>Due</Badge>
                        : <Badge tone="info">Upcoming</Badge>}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        ) : <EmptyState title="No interviews" description="When a recruiter adds you to an interview panel, it appears here and you get a notification." />}
      </Card>
    </>
  );
}

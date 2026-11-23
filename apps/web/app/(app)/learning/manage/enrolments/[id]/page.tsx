import { BLOCK_LABEL, type BlockKind } from '@crew/contracts';
import { Badge, Card, CardHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { dateLabel, DueLabel, LearnerStatusBadge, ProgressBar, SubmissionBadge } from '../../../labels';
import type { EnrolmentDetail } from '../../../types';

export const metadata: Metadata = { title: 'Learning progress' };

export default async function EnrolmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const d = await load<EnrolmentDetail>(`/learning/enrolments/${id}`);
  return (
    <div className="grid gap-4">
      <Card>
        <div className="grid gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold"><Link href={`/learning/manage/learners/${d.employeeId}`} className="hover:underline">{d.employeeName}</Link> · {d.moduleTitle}</h2>
              <p className="text-xs text-fg-muted">{[d.employeeCode, d.hrWorkspace ?? 'Central group', d.department, `Version ${d.version}`].filter(Boolean).join(' · ')}</p>
            </div>
            <div className="flex items-center gap-2"><LearnerStatusBadge status={d.status} />{d.scorePercent !== null && <Badge tone="neutral">Score {d.scorePercent}%</Badge>}</div>
          </div>
          <ProgressBar value={d.progressPercent} />
          <p className="text-xs text-fg-muted">Assigned {dateLabel(d.assignedOn)} · {d.status === 'completed' ? `completed ${dateLabel(d.completedOn)}${d.certificateNo ? ` · certificate ${d.certificateNo}` : ''}` : <DueLabel dueOn={d.dueOn} due={d.due} />} · {d.timeSpentMinutes} min spent</p>
        </div>
      </Card>
      <Card>
        <CardHeader title="Each item" />
        <Table aria-label="Items">
          <THead><TR><TH>Item</TH><TH>Done</TH><TH>Details</TH></TR></THead>
          <TBody>
            {d.items.map((i) => (
              <TR key={i.id}>
                <TD><span className="font-medium">{i.title}</span><span className="block text-xs text-fg-muted">{BLOCK_LABEL[i.kind as BlockKind] ?? i.kind}{i.required ? '' : ' · optional'}</span></TD>
                <TD>{i.state.done ? <Badge tone="success" dot>Done{i.state.doneAt ? ` ${dateLabel(i.state.doneAt)}` : ''}</Badge> : i.state.openedAt ? <Badge tone="info">Opened</Badge> : <Badge>Not opened</Badge>}</TD>
                <TD className="text-xs text-fg-muted">
                  {i.state.percent !== undefined && i.kind !== 'quiz' && <span className="block">Reached {i.state.percent}%</span>}
                  {i.attempts.map((a) => <span key={a.id} className="block">Attempt {a.attemptNo}: {a.status === 'pending_review' ? 'waiting for marks' : a.percent !== null ? `${a.percent}% (${a.passed ? 'passed' : 'not passed'})` : a.status}</span>)}
                  {i.submissions.map((s, k) => <span key={s.id} className="flex items-center gap-1">Submission {k + 1}: <SubmissionBadge status={s.status as never} />{s.score !== null ? ` ${s.score}` : ''}</span>)}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

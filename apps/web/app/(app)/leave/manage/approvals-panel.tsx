'use client';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { LeaveRequest } from '@/lib/types';
import { AuthorityStatus } from '../authority-status';
import { decideLeaveAction } from './actions';

const dates = (r: LeaveRequest) => (r.startDate === r.endDate ? r.startDate : `${r.startDate} to ${r.endDate}`);

/** Applications waiting on the signed-in HR Workspace or Super Workspace, decided here or on the request page. */
export function ApprovalsPanel({ waiting, recent }: { waiting: LeaveRequest[]; recent: LeaveRequest[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [comments, setComments] = useState<Record<string, string>>({});
  const decide = (r: LeaveRequest, d: 'approve' | 'reject') => start(async () => {
    const c = comments[r.id]?.trim();
    if (d === 'reject' && !c) { setNotice({ tone: 'danger', text: 'Add a remark so the employee knows why it was rejected.' }); return; }
    const res = await decideLeaveAction(r.approvalId!, d, c || undefined);
    setNotice(res.ok
      ? { tone: 'success', text: res.data!.status === 'pending' ? `${r.employeeName}’s application is approved by you; it now waits for the other authority.` : `${r.employeeName}’s application is ${res.data!.status}.` }
      : { tone: 'danger', text: res.message });
    if (res.ok) router.refresh();
  });
  return (
    <div className="grid gap-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <Card>
        <CardHeader title="Waiting for your approval" description="Each application shows where it was sent and every authority’s decision. It is approved only when all of them approved it." />
        {waiting.length ? (
          <Table aria-label="Waiting for your approval">
            <THead><tr><TH>Employee</TH><TH>Leave</TH><TH>Sent to</TH><TH>Status</TH><TH>Remark</TH><TH /></tr></THead>
            <TBody>
              {waiting.map((r) => (
                <TR key={r.id} data-testid="leave-review-row">
                  <TD className="min-w-40"><span className="font-medium">{r.employeeName}</span><span className="block text-xs text-fg-subtle">{r.employeeCode}{r.hrWorkspaceName ? ` · ${r.hrWorkspaceName}` : ''}</span></TD>
                  <TD className="min-w-48">
                    <Link href={`/leave/requests/${r.id}`} className="font-medium hover:underline">{r.leaveTypeName}</Link> <Badge>{r.reference}</Badge>
                    <span className="block text-xs text-fg-muted">{dates(r)} · {r.days} days{r.documentCount ? ` · ${r.documentCount} document${r.documentCount === 1 ? '' : 's'}` : ''}</span>
                    {r.reason && <span className="block max-w-xs truncate text-xs text-fg-subtle">“{r.reason}”</span>}
                  </TD>
                  <TD className="text-xs">{r.approvalRouteLabel}</TD>
                  <TD className="min-w-44"><AuthorityStatus authorities={r.authorities} /></TD>
                  <TD className="min-w-40"><Input aria-label={`Remark for ${r.employeeName}`} placeholder="Remark" value={comments[r.id] ?? ''} onChange={(e) => setComments({ ...comments, [r.id]: e.target.value })} /></TD>
                  <TD>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" disabled={pending} onClick={() => decide(r, 'approve')} data-testid="leave-approve">Approve</Button>
                      <Button size="sm" variant="secondary" disabled={pending} onClick={() => decide(r, 'reject')}>Reject</Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="Nothing waiting for you" description="New applications sent to you appear here, and you are notified." />}
      </Card>
      <Card>
        <CardHeader title="Recent applications" description="Applications in your scope, newest first." />
        {recent.length ? (
          <Table aria-label="Recent applications">
            <THead><tr><TH>Employee</TH><TH>Leave</TH><TH>Sent to</TH><TH>Status</TH></tr></THead>
            <TBody>
              {recent.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.employeeName}</TD>
                  <TD><Link href={`/leave/requests/${r.id}`} className="hover:underline">{r.leaveTypeName}</Link><span className="block text-xs text-fg-muted">{dates(r)} · {r.days} days</span></TD>
                  <TD className="text-xs">{r.approvalRouteLabel}</TD>
                  <TD><Badge tone={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : r.status === 'pending' ? 'warning' : 'neutral'}>{r.status}</Badge><AuthorityStatus authorities={r.authorities} className="mt-1" /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No applications yet" />}
      </Card>
    </div>
  );
}

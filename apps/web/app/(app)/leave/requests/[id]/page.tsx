import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, StatusPill, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { FileText } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { LeaveRequest, Me } from '@/lib/types';
import { AuthorityStatus } from '../../authority-status';
import { policyLines } from '../../manage/policy-text';
import { CancelRequest } from './cancel';

export const metadata: Metadata = { title: 'Leave application' };

const AUTH: Record<string, string> = { manager: 'Reporting manager', hr: 'HR Workspace', super: 'Super Workspace', other: 'Approver' };
const when = (v: string | null) => (v ? new Date(v).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

/** One leave application: where it went, each authority’s decision, the rules it was made under and its documents. */
export default async function LeaveRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, r] = await Promise.all([load<Me>('/me'), load<LeaveRequest>(`/leave/requests/${id}`)]);
  const today = new Date().toISOString().slice(0, 10);
  const mine = me.employee?.id === r.employeeId;
  const canCancel = mine && (r.status === 'pending' || (r.status === 'approved' && r.startDate > today));
  const snap = r.policySnapshot;
  const dates = r.startDate === r.endDate ? r.startDate : `${r.startDate} to ${r.endDate}`;
  return (
    <>
      <PageHeader
        eyebrow={r.reference}
        title={`${r.leaveTypeName}: ${dates}`}
        description={`${mine ? 'Your application' : `${r.employeeName}’s application`} for ${r.days} days, sent to ${r.approvalRouteLabel ?? 'approval'}${r.reviewerHrWorkspaceName ? ` (${r.reviewerHrWorkspaceName})` : ''}.`}
        actions={<div className="flex items-center gap-2"><StatusPill status={r.status} />{canCancel && <CancelRequest id={r.id} />}</div>}
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid gap-6 lg:col-span-2">
          <Card>
            <CardHeader title="Approval status" description="The application is approved only when every authority it went to approved it." />
            <CardBody className="grid gap-4">
              <AuthorityStatus authorities={r.authorities} className="text-sm" />
              <Table aria-label="Approval trail">
                <THead><tr><TH>Step</TH><TH>Who</TH><TH>Status</TH><TH>Decided</TH><TH>Remarks</TH></tr></THead>
                <TBody>
                  {(r.approvalTrail ?? []).map((s) => (
                    <TR key={s.seq}>
                      <TD className="whitespace-nowrap">{s.stage ?? s.seq}. {AUTH[s.authority ?? ''] ?? s.kind}</TD>
                      <TD className="text-sm">{s.hrWorkspaceName ?? s.approver ?? (s.authority === 'hr' ? 'Company HR team' : s.authority === 'super' ? 'Any Super Workspace administrator' : '—')}{s.escalatedAt && <Badge tone="warning" className="ml-1">Escalated</Badge>}</TD>
                      <TD><StatusPill status={s.status} /></TD>
                      <TD className="whitespace-nowrap text-xs">{s.decidedBy ? `${s.decidedBy}, ${when(s.decidedAt)}` : '—'}</TD>
                      <TD className="text-xs text-fg-muted">{s.comment ?? ''}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Application" />
            <CardBody className="grid gap-2 text-sm sm:grid-cols-2">
              <div><span className="text-fg-muted">Employee:</span> {r.employeeName} ({r.employeeCode}){r.hrWorkspaceName ? ` · ${r.hrWorkspaceName}` : ''}</div>
              <div><span className="text-fg-muted">Leave type:</span> {r.leaveTypeName} <Badge>{r.leaveTypeCode}</Badge>{r.leaveTypeActive === false && <Badge tone="warning" className="ml-1">Now inactive</Badge>}</div>
              <div><span className="text-fg-muted">Dates:</span> {dates}{r.startHalf === 'second_half' ? ', from the second half' : ''}{r.endHalf === 'first_half' ? ', until the first half' : ''}</div>
              <div><span className="text-fg-muted">Days:</span> {r.days}</div>
              <div><span className="text-fg-muted">Applied:</span> {when(r.createdAt)}{r.requestedBy && r.requestedBy !== r.employeeName ? ` by ${r.requestedBy}` : ''}</div>
              <div><span className="text-fg-muted">Sent to:</span> {r.approvalRouteLabel}{r.approvalOrder ? ` (${r.approvalOrder === 'sequential' ? 'one after the other' : 'at the same time'})` : ''}</div>
              {r.reason && <div className="sm:col-span-2"><span className="text-fg-muted">Reason:</span> {r.reason}</div>}
              {r.cancelReason && <div className="sm:col-span-2"><span className="text-fg-muted">Cancelled:</span> {r.cancelReason}</div>}
              {!!r.modifications?.length && <div className="sm:col-span-2"><span className="text-fg-muted">Changed:</span> {r.modifications.map((m) => `was ${m.leaveTypeName ?? ''} ${m.startDate} to ${m.endDate} (${m.days})`).join('; ')}</div>}
            </CardBody>
          </Card>
        </div>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader title="Supporting documents" />
            <CardBody>
              {r.documents?.length ? (
                <ul className="grid gap-2 text-sm">{r.documents.map((d) => <li key={d.id}><a className="inline-flex items-center gap-2 text-accent hover:underline" href={d.href}><FileText className="size-4" />{d.name}</a></li>)}</ul>
              ) : <EmptyState title="No documents attached" />}
            </CardBody>
          </Card>
          {snap && (
            <Card>
              <CardHeader title="Rules it was made under" description={`Version ${r.policyVersion ?? 1} of ${snap.name}. Later changes to the leave type do not change this application.`} />
              <CardBody>
                <ul className="list-disc pl-5 text-xs text-fg-muted">{policyLines({ policy: snap.policy, allowHalfDay: true, countsCalendarDays: false, paid: true }).filter((l) => !/^(Paid|Unpaid|Half days|Full days|Counts)/.test(l)).map((l) => <li key={l}>{l}</li>)}</ul>
                {snap.reviewers?.length > 0 && <p className="mt-2 text-xs">Reviewed by: {snap.reviewers.join(' and ')}</p>}
              </CardBody>
            </Card>
          )}
          <Link href={mine ? '/leave' : '/leave/manage?tab=approvals'} className="text-sm text-accent hover:underline">{mine ? 'Back to my leave' : 'Back to leave approvals'}</Link>
        </div>
      </div>
    </>
  );
}

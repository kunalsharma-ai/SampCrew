import { BGV_CHECK_LABEL, BGV_STATUS_LABEL } from '@crew/contracts';
import { Badge, Card, CardBody, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR, buttonClass } from '@crew/ui';
import Link from 'next/link';
import type { CaseRow } from '../../verification/types';
import { STATUS_TONE, day } from '../../verification/labels';

export interface EmployeeAsset {
  assignmentId: string;
  assetId: string;
  assetCode: string;
  name: string;
  status: string;
  assignedOn: string;
  returnedOn: string | null;
  acknowledged: boolean;
  requiresAcknowledgement: boolean;
}

/** The employee's background verification cases, newest first, each opening the full case. */
export function VerificationTab({ employeeId, cases, canCreate }: { employeeId: string; cases: CaseRow[]; canCreate: boolean }) {
  const start = canCreate ? <Link href={`/verification?create=${employeeId}`} className={buttonClass('secondary', 'sm')}>Start verification</Link> : undefined;
  return (
    <Card>
      <CardHeader title="Verification cases" description="Background checks for this person, done by HR or sent to an agency." action={start} />
      {cases.length === 0 ? (
        <CardBody><EmptyState title="No verification yet" description="No background verification has been started for this person." /></CardBody>
      ) : (
        <Table>
          <THead><TR><TH>Case</TH><TH>Checks</TH><TH>Done by</TH><TH>Status</TH><TH>Due</TH></TR></THead>
          <TBody>
            {cases.map((c) => (
              <TR key={c.id}>
                <TD><Link href={`/verification/${c.id}`} className="font-medium text-fg hover:underline">{c.reference}</Link><div className="text-xs text-fg-muted">Started {day(c.createdAt)}</div></TD>
                <TD>{c.checks.done} of {c.checks.total}{c.checks.failed ? <span className="text-danger"> · {c.checks.failed} failed</span> : null}<div className="text-xs text-fg-muted">{c.checks.types.map((t) => BGV_CHECK_LABEL[t as keyof typeof BGV_CHECK_LABEL] ?? t).join(', ')}</div></TD>
                <TD>{c.method === 'external' ? c.agencyName ?? 'Agency' : 'HR team'}</TD>
                <TD><Badge tone={STATUS_TONE[c.status]}>{BGV_STATUS_LABEL[c.status as keyof typeof BGV_STATUS_LABEL] ?? c.status}</Badge></TD>
                <TD>{c.completedOn ? `Completed ${day(c.completedOn)}` : c.dueDate ? <span className={c.overdue ? 'text-danger' : undefined}>{day(c.dueDate)}{c.overdue ? ' (overdue)' : ''}</span> : 'None'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

/** Assets this employee holds now and has returned, with whether they acknowledged each one. */
export function AssetsTab({ assets, canAssign }: { assets: EmployeeAsset[]; canAssign: boolean }) {
  const held = assets.filter((a) => a.status === 'active');
  const returned = assets.filter((a) => a.status !== 'active');
  const assign = canAssign ? <Link href="/assets?status=available" className={buttonClass('secondary', 'sm')}>Assign an asset</Link> : undefined;
  const rows = (list: EmployeeAsset[], current: boolean) => (
    <Table>
      <THead><TR><TH>Asset</TH><TH>Given on</TH><TH>{current ? 'Acknowledgement' : 'Returned on'}</TH></TR></THead>
      <TBody>
        {list.map((a) => (
          <TR key={a.assignmentId}>
            <TD><Link href={`/assets/${a.assetId}`} className="font-medium text-fg hover:underline">{a.assetCode}</Link><div className="text-xs text-fg-muted">{a.name}</div></TD>
            <TD>{day(a.assignedOn)}</TD>
            <TD>{current ? (a.acknowledged ? <Badge tone="success">Acknowledged</Badge> : a.requiresAcknowledgement ? <Badge tone="warning">Waiting for them</Badge> : <Badge>Not needed</Badge>) : day(a.returnedOn)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader title="Assets held" description="Company assets this person has now." action={assign} />
        {held.length ? rows(held, true) : <CardBody><EmptyState title="No assets held" description="Nothing is assigned to this person at the moment." /></CardBody>}
      </Card>
      {returned.length > 0 && (
        <Card>
          <CardHeader title="Assets returned" description="What they held before and when it came back." />
          {rows(returned, false)}
        </Card>
      )}
    </div>
  );
}

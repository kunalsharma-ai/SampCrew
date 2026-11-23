import { Badge, Card, CardHeader, EmptyState, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import Link from 'next/link';
import type { LeaveDashboard, LeaveHistoryRow, LeaveReport } from '@/lib/types';
import { AuthorityStatus } from '../authority-status';

const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

/** The Super Workspace or HR Workspace leave dashboard. */
export function DashboardPanel({ d }: { d: LeaveDashboard }) {
  const c = d.counts;
  return (
    <div className="grid gap-6" data-testid="leave-dashboard">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Leave types" value={c.activeTypes} hint={c.inactiveTypes ? `${c.inactiveTypes} inactive` : 'All active'} />
        <Stat label="Waiting for you" value={<Link href="/leave/manage?tab=approvals" className="hover:underline">{c.waitingForMe}</Link>} hint={`${c.pending} pending in all`} />
        <Stat label="On leave today" value={c.onLeaveToday} hint={`${c.employees} people in scope`} />
        <Stat label={`Decided in ${d.year}`} value={c.approved + c.rejected} hint={`${c.approved} approved · ${c.rejected} rejected · ${c.cancelled} cancelled`} />
      </div>
      <Card>
        <CardHeader title="Leave types in use" description={`Credited and taken days for ${d.year}, and applications by status.`} />
        {d.byType.length ? (
          <Table aria-label="Leave types in use">
            <THead><tr><TH>Leave type</TH><TH>People</TH><TH>Credited</TH><TH>Taken</TH><TH>Used</TH><TH>Pending</TH><TH>Approved</TH><TH>Rejected</TH></tr></THead>
            <TBody>
              {d.byType.map((t) => (
                <TR key={t.id}>
                  <TD><span className="flex items-center gap-2 font-medium"><span className="size-2 rounded-full" style={{ background: t.color }} />{t.name}{!t.active && <Badge tone="warning">Inactive</Badge>}</span></TD>
                  <TD className="tabular-nums">{t.holders}</TD>
                  <TD className="tabular-nums">{t.credited}</TD>
                  <TD className="tabular-nums">{t.taken}</TD>
                  <TD className="tabular-nums">{pct(t.utilisation)}</TD>
                  <TD className="tabular-nums">{t.pending}</TD>
                  <TD className="tabular-nums">{t.approved}</TD>
                  <TD className="tabular-nums">{t.rejected}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="No leave types yet" />}
      </Card>
      {d.byHrWorkspace.length > 0 && (
        <Card>
          <CardHeader title={d.level === 'super' ? 'By HR Workspace' : 'Your HR Workspaces'} description="The leave types each HR Workspace runs and its people’s applications." />
          <Table aria-label="By HR Workspace">
            <THead><tr><TH>HR Workspace</TH><TH>People</TH><TH>Leave types it runs</TH><TH>Pending</TH><TH>Approved</TH><TH>Days taken</TH></tr></THead>
            <TBody>
              {d.byHrWorkspace.map((w) => (
                <TR key={w.id ?? 'central'}>
                  <TD className="font-medium">{w.name}</TD>
                  <TD className="tabular-nums">{w.employees}</TD>
                  <TD className="text-xs text-fg-muted">{w.types.join(', ') || 'None yet'}</TD>
                  <TD className="tabular-nums">{w.pending}</TD>
                  <TD className="tabular-nums">{w.approved}</TD>
                  <TD className="tabular-nums">{w.takenDays}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
      <Card>
        <CardHeader title="Upcoming leave" description="Approved leave in the next 30 days." />
        {d.upcoming.length ? (
          <Table aria-label="Upcoming leave">
            <THead><tr><TH>Employee</TH><TH>Leave</TH><TH>Dates</TH><TH>Days</TH><TH>Approved by</TH></tr></THead>
            <TBody>
              {d.upcoming.map((r) => (
                <TR key={r.id}>
                  <TD className="font-medium">{r.employeeName}</TD>
                  <TD><Link className="hover:underline" href={`/leave/requests/${r.id}`}>{r.leaveTypeName}</Link></TD>
                  <TD className="whitespace-nowrap">{r.startDate === r.endDate ? r.startDate : `${r.startDate} to ${r.endDate}`}</TD>
                  <TD className="tabular-nums">{r.days}</TD>
                  <TD><AuthorityStatus authorities={r.authorities} /></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="Nobody is away in the next 30 days" />}
      </Card>
    </div>
  );
}

/** Leave reports: by type, department and person. */
export function ReportsPanel({ r }: { r: LeaveReport }) {
  return (
    <div className="grid gap-6" data-testid="leave-reports">
      <Card>
        <CardHeader title="By leave type" description={`Allocation and use in ${r.year}.`} />
        <Table aria-label="By leave type">
          <THead><tr><TH>Leave type</TH><TH>People</TH><TH>Allocations</TH><TH>Credited</TH><TH>Taken</TH><TH>Used</TH><TH>Pending</TH><TH>Approved</TH><TH>Rejected</TH><TH>Cancelled</TH></tr></THead>
          <TBody>
            {r.byType.map((t) => (
              <TR key={t.id}>
                <TD className="font-medium">{t.name} <Badge>{t.code}</Badge></TD>
                <TD className="tabular-nums">{t.holders}</TD><TD className="tabular-nums">{t.allocations}</TD><TD className="tabular-nums">{t.credited}</TD>
                <TD className="tabular-nums">{t.taken}</TD><TD className="tabular-nums">{pct(t.utilisation)}</TD><TD className="tabular-nums">{t.pending}</TD>
                <TD className="tabular-nums">{t.approved}</TD><TD className="tabular-nums">{t.rejected}</TD><TD className="tabular-nums">{t.cancelled}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="By department" />
        <Table aria-label="By department">
          <THead><tr><TH>Department</TH><TH>People</TH><TH>Credited</TH><TH>Taken</TH><TH>Used</TH></tr></THead>
          <TBody>
            {r.byDepartment.map((x) => (
              <TR key={x.departmentId ?? 'none'}><TD className="font-medium">{x.name}</TD><TD className="tabular-nums">{x.employees}</TD><TD className="tabular-nums">{x.credited}</TD><TD className="tabular-nums">{x.taken}</TD><TD className="tabular-nums">{pct(x.utilisation)}</TD></TR>
            ))}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="By employee" description="Entitlement, used, pending and balance for each leave type." />
        {r.employees.length ? (
          <Table aria-label="By employee">
            <THead><tr><TH>Employee</TH>{r.types.map((t) => <TH key={t.id}>{t.code}</TH>)}</tr></THead>
            <TBody>
              {r.employees.map((e) => (
                <TR key={e.employeeId}>
                  <TD className="min-w-44"><span className="font-medium">{e.name}</span><span className="block text-xs text-fg-subtle">{[e.code, e.departmentName, e.hrWorkspaceName].filter(Boolean).join(' · ')}</span></TD>
                  {r.types.map((t) => {
                    const c = e.cells[t.id];
                    return <TD key={t.id} className="whitespace-nowrap text-xs tabular-nums">{c ? <><strong>{c.balance}</strong> left<span className="block text-fg-subtle">{c.used} used of {c.entitlement}{Number(c.pending) ? ` · ${c.pending} pending` : ''}</span></> : <span className="text-fg-subtle">—</span>}</TD>;
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title="Nobody in scope" />}
      </Card>
    </div>
  );
}

const KIND: Record<string, string> = {
  type_created: 'Leave type created', type_updated: 'Leave type changed', type_deactivated: 'Leave type deactivated', type_activated: 'Leave type activated',
  allocated: 'Allocated', made_available: 'Made available to HR', allocation_revoked: 'Allocation withdrawn',
};

/** Who created, changed or allocated what, and when. */
export function HistoryPanel({ rows }: { rows: LeaveHistoryRow[] }) {
  return (
    <Card>
      <CardHeader title="Leave history" description="Every creation, change, deactivation and allocation, newest first. Approvals are in each application’s trail and in the audit log." />
      {rows.length ? (
        <Table aria-label="Leave history">
          <THead><tr><TH>When</TH><TH>What</TH><TH>Leave type</TH><TH>By</TH><TH>Details</TH></tr></THead>
          <TBody>
            {rows.map((h) => (
              <TR key={h.id}>
                <TD className="whitespace-nowrap text-xs">{new Date(h.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</TD>
                <TD>{KIND[h.kind] ?? h.kind}{h.version ? ` (v${h.version})` : ''}</TD>
                <TD className="font-medium">{h.leaveTypeName}</TD>
                <TD className="text-xs">{h.byName ?? '—'}{h.byLevel === 'super' ? ' – Super Workspace' : h.byLevel === 'hr' ? ' – HR Workspace' : h.byLevel === 'system' ? ' (carried over)' : ''}</TD>
                <TD className="text-xs text-fg-muted">{[h.changes.length ? `Changed: ${h.changes.join(', ')}` : null, h.note].filter(Boolean).join(' · ')}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="Nothing recorded yet" />}
    </Card>
  );
}

'use client';
import { Alert, Badge, Button, buttonClass, Card, CardBody, CardHeader, EmptyState, Stat, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Download, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import { useRunner } from '../../../recruitment/use-runner';
import { addAdjustmentAction, cancelRunAction, computeRunAction, removeAdjustmentAction, submitRunAction, withdrawRunAction } from '../../actions';
import { amount, days, RUN_STATUS, RUN_TONE } from '../../labels';
import type { PayrollRunDetail } from '../../types';

export function RunView({ run, people }: { run: PayrollRunDetail; people: { id: string; code: string; name: string }[] }) {
  const { pending, notice, run: go } = useRunner();
  const [adjusting, setAdjusting] = useState(false);
  const [allWarnings, setAllWarnings] = useState(false);
  const s = run.status;
  const editable = run.can.compute;
  const money = (v: string) => amount(v, run.currency);
  const computed = s !== 'draft' && s !== 'cancelled';
  const warnings = allWarnings ? run.warnings : run.warnings.slice(0, 6);

  return (
    <div className="grid gap-6">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {run.statusNote && <Alert tone={s === 'cancelled' ? 'info' : 'warning'}>{run.statusNote}</Alert>}
      {s === 'pending_approval' && <Alert tone="warning" title="Waiting for approval">A finance approver reviews the totals in Approvals. Approving finalises the run, locks attendance for the month and publishes payslips.</Alert>}
      {s === 'finalised' && <Alert tone="success" title="Finalised">Payslips are published to employees, attendance for the month is locked and the included expense claims are marked paid. This run can no longer change; correct anything in next month’s run with an adjustment.</Alert>}

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2">Run <Badge tone={RUN_TONE[s] ?? 'neutral'} dot>{RUN_STATUS[s] ?? s}</Badge></span>}
          description={run.computedAt ? `Last computed ${new Date(run.computedAt).toLocaleString()}${run.createdBy ? ` · prepared by ${run.createdBy}` : ''}` : 'Not computed yet'}
          action={
            <div className="flex flex-wrap gap-2">
              {computed && <a className={buttonClass('secondary', 'sm')} href={`/payroll-files/${run.id}/register`}><Download className="size-3.5" /> Register (CSV)</a>}
              {run.can.exportBankFile && <a className={buttonClass('secondary', 'sm')} href={`/payroll-files/${run.id}/bank-file`}><Download className="size-3.5" /> Bank file (CSV)</a>}
              {editable && <Button size="sm" variant={s === 'draft' ? 'primary' : 'secondary'} loading={pending} onClick={() => go(() => computeRunAction(run.id))}>{s === 'draft' ? 'Compute payroll' : 'Recompute'}</Button>}
              {run.can.submit && <Button size="sm" loading={pending} onClick={() => confirm(`Send payroll for approval? Net pay ${money(run.net)} for ${run.employeeCount} employee(s).`) && go(() => submitRunAction(run.id))}>Send for approval</Button>}
              {s === 'pending_approval' && run.can.cancel && <Button size="sm" variant="secondary" loading={pending} onClick={() => go(() => withdrawRunAction(run.id))}>Withdraw</Button>}
              {run.can.cancel && (
                <Button size="sm" variant="ghost" loading={pending} onClick={() => {
                  const reason = prompt('Cancel this payroll run? Reason:');
                  if (reason && reason.trim().length >= 3) go(() => cancelRunAction(run.id, reason.trim()));
                }}>Cancel run</Button>
              )}
            </div>
          }
        />
        {computed && (
          <CardBody className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Stat label="Employees" value={run.employeeCount} />
            <Stat label="Gross pay" value={money(run.gross)} />
            <Stat label="Deductions" value={money(run.deductions)} />
            <Stat label="Reimbursements" value={money(run.reimbursements)} />
            <Stat label="Net pay" value={money(run.net)} />
            <Stat label="Employer contributions" value={money(run.employerContributions)} hint="PF and ESI on top of pay" />
          </CardBody>
        )}
      </Card>

      {run.warnings.length > 0 && (
        <Alert tone="warning" title={`${run.warnings.length} thing(s) to check`}>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          {run.warnings.length > 6 && <button className="mt-1 text-[0.8125rem] font-medium underline" onClick={() => setAllWarnings((v) => !v)}>{allWarnings ? 'Show fewer' : `Show all ${run.warnings.length}`}</button>}
        </Alert>
      )}

      <Card>
        <CardHeader title="Payslips in this run" description={computed ? 'Open a row to see every line with its calculation, override loss-of-pay days or hold pay.' : undefined} />
        {run.items.length ? (
          <Table>
            <THead><tr><TH>Employee</TH><TH className="text-right">Paid days</TH><TH className="text-right">Gross</TH><TH className="text-right">Deductions</TH><TH className="text-right">Reimbursed</TH><TH className="text-right">Net pay</TH><TH /></tr></THead>
            <TBody>
              {run.items.map((i) => (
                <TR key={i.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/payroll/runs/${run.id}/items/${i.id}`}>{i.name}</Link>
                    <div className="text-xs text-fg-muted"><span className="font-mono">{i.code}</span>{i.departmentName ? ` · ${i.departmentName}` : ''}</div>
                  </TD>
                  <TD className="whitespace-nowrap text-right tabular-nums">
                    {days(i.paidDays)} / {i.daysInPeriod}
                    {(i.lopOverride ?? i.lopDays) !== '0.00' && <div className="text-xs text-fg-muted">{days(i.lopOverride ?? i.lopDays)} loss of pay{i.lopOverride !== null ? ' (set by hand)' : ''}</div>}
                  </TD>
                  <TD className="whitespace-nowrap text-right tabular-nums">{money(i.gross)}</TD>
                  <TD className="whitespace-nowrap text-right tabular-nums">{money(i.deductions)}</TD>
                  <TD className="whitespace-nowrap text-right tabular-nums">{i.reimbursements !== '0.00' ? money(i.reimbursements) : '–'}</TD>
                  <TD className="whitespace-nowrap text-right font-medium tabular-nums">{i.status === 'on_hold' ? <span className="text-fg-muted line-through">{money(i.net)}</span> : money(i.net)}</TD>
                  <TD className="whitespace-nowrap">
                    {i.status === 'on_hold' && <Badge tone="warning">On hold</Badge>}{' '}
                    {i.warningCount > 0 && <Badge tone="warning">{i.warningCount} to check</Badge>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<Users className="size-5" />} title={s === 'draft' ? 'Not computed yet' : 'Nobody in this run'} description={s === 'draft' ? 'Compute the run to work out pay for everyone in this legal entity with a salary.' : 'Assign salaries to employees of this legal entity and compute again.'} />
        )}
      </Card>

      <Card>
        <CardHeader
          title="One-off adjustments"
          description="Bonuses, arrears, recoveries and other one-off amounts for this month, each with a reason."
          action={editable && people.length > 0 && <Button size="sm" variant="secondary" onClick={() => setAdjusting(true)}><Plus className="size-3.5" /> Add adjustment</Button>}
        />
        {run.adjustments.length ? (
          <Table>
            <THead><tr><TH>Employee</TH><TH>Adjustment</TH><TH className="text-right">Amount</TH><TH>Reason</TH><TH /></tr></THead>
            <TBody>
              {run.adjustments.map((a) => (
                <TR key={a.id}>
                  <TD>{a.employeeName}</TD>
                  <TD>{a.label} <span className="text-xs text-fg-muted">{a.kind === 'earning' ? (a.taxable ? 'earning, taxable' : 'earning, not taxable') : 'deduction'}</span></TD>
                  <TD className="whitespace-nowrap text-right tabular-nums">{a.kind === 'deduction' ? '-' : ''}{money(a.amount)}</TD>
                  <TD className="text-fg-muted">{a.reason}</TD>
                  <TD className="text-right">{editable && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Remove this adjustment?') && go(() => removeAdjustmentAction(run.id, a.id))}>Remove</Button>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <CardBody className="text-[0.8125rem] text-fg-muted">No adjustments.</CardBody>
        )}
      </Card>

      <ResourceDialog
        open={adjusting}
        onClose={() => setAdjusting(false)}
        title="Add an adjustment"
        submitLabel="Add and recompute"
        initial={{ kind: 'earning', taxable: 'yes' }}
        fields={[
          { name: 'employeeId', label: 'Employee', type: 'select', required: true, options: people.map((p) => ({ value: p.id, label: `${p.name} (${p.code})` })) },
          { name: 'kind', label: 'Type', type: 'select', required: true, half: true, options: [{ value: 'earning', label: 'Earning (adds to pay)' }, { value: 'deduction', label: 'Deduction (reduces pay)' }] },
          { name: 'taxable', label: 'Taxable', type: 'select', half: true, options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], hint: 'Earnings only' },
          { name: 'label', label: 'Shown on the payslip as', required: true, placeholder: 'Spot award', half: true },
          { name: 'amount', label: `Amount (${run.currency})`, required: true, placeholder: '5000', half: true },
          { name: 'reason', label: 'Reason', type: 'textarea', required: true, hint: 'Kept in the audit trail' },
        ]}
        onSubmit={(v) => addAdjustmentAction(run.id, v)}
      />
    </div>
  );
}

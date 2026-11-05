'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Field, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';
import { useRunner } from '../../../../../recruitment/use-runner';
import { overrideItemAction } from '../../../../actions';
import { amount, days, LINE_KIND } from '../../../../labels';
import type { PayrollItemDetail } from '../../../../types';

export function ItemView({ runId, currency, item, editable }: { runId: string; currency: string; item: PayrollItemDetail; editable: boolean }) {
  const router = useRouter();
  const { pending, notice, run } = useRunner();
  const [lop, setLop] = useState(item.lopOverride ? days(item.lopOverride) : '');
  const [reason, setReason] = useState('');
  const money = (v: string) => amount(v, currency);
  const after = (data: unknown) => {
    const id = (data as { id?: string } | undefined)?.id;
    if (id && id !== item.id) router.replace(`/payroll/runs/${runId}/items/${id}`);
  };
  const groups = (['earning', 'deduction', 'reimbursement', 'employer'] as const).map((k) => ({ kind: k, lines: item.lines.filter((l) => l.kind === k) })).filter((g) => g.lines.length);

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid gap-6 lg:col-span-2">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {item.status === 'on_hold' && <Alert tone="warning" title="Pay on hold">{item.holdReason} This person is left out of the totals, the bank file and payslips for this run.</Alert>}
        {item.warnings.length > 0 && <Alert tone="warning" title="To check"><ul className="list-disc pl-5">{item.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></Alert>}
        <Card>
          <CardHeader title="Calculation" description="Every amount with how it was worked out. Amounts are exact to the paisa; statutory amounts are rounded to the rupee." />
          <Table>
            <THead><tr><TH>Line</TH><TH>How</TH><TH className="text-right">Amount</TH></tr></THead>
            <TBody>
              {groups.map((g) => (
                <Fragment key={g.kind}>
                  <tr><td colSpan={3} className="bg-bg-subtle/60 px-5 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">{LINE_KIND[g.kind]}</td></tr>
                  {g.lines.map((l) => (
                    <TR key={`${g.kind}-${l.code}`}>
                      <TD className="font-medium">{l.name}{l.kind === 'earning' && l.taxable === false && <span className="ml-1 text-xs text-fg-muted">(not taxable)</span>}</TD>
                      <TD className="text-[0.8125rem] text-fg-muted">{l.explanation}</TD>
                      <TD className="whitespace-nowrap text-right tabular-nums">{l.kind === 'deduction' ? '-' : ''}{money(l.amount)}</TD>
                    </TR>
                  ))}
                </Fragment>
              ))}
              <TR><TD className="font-semibold">Net pay</TD><TD className="text-[0.8125rem] text-fg-muted">Earnings + reimbursements - deductions</TD><TD className="whitespace-nowrap text-right font-semibold tabular-nums">{money(item.net)}</TD></TR>
            </TBody>
          </Table>
        </Card>
        <Card>
          <CardHeader title="Why these numbers" />
          <CardBody><ul className="list-disc space-y-1 pl-5 text-[0.8125rem]">{item.explanation.map((e, i) => <li key={i}>{e}</li>)}</ul></CardBody>
        </Card>
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader title="Days" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-3 text-[0.8125rem]">
              <div><dt className="text-fg-muted">Days in month</dt><dd className="font-medium tabular-nums">{item.daysInPeriod}</dd></div>
              <div><dt className="text-fg-muted">Employed</dt><dd className="font-medium tabular-nums">{item.employedDays}</dd></div>
              <div><dt className="text-fg-muted">Loss of pay</dt><dd className="font-medium tabular-nums">{days(item.lopOverride ?? item.lopDays)}{item.lopOverride !== null && <Badge tone="info" className="ml-1">set by hand</Badge>}</dd></div>
              <div><dt className="text-fg-muted">Paid days</dt><dd className="font-medium tabular-nums">{days(item.paidDays)}</dd></div>
              <div><dt className="text-fg-muted">Taxable this month</dt><dd className="font-medium tabular-nums">{money(item.taxable)}</dd></div>
              <div><dt className="text-fg-muted">Income tax (TDS)</dt><dd className="font-medium tabular-nums">{money(item.tds)}</dd></div>
            </dl>
          </CardBody>
        </Card>
        {editable && (
          <Card>
            <CardHeader title="Change" description="Each change needs a reason and is kept in the audit trail. The run recomputes straight away." />
            <CardBody className="grid gap-4">
              <Field label="Reason" required>
                {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Approved by the plant head" />}
              </Field>
              <Field label="Loss-of-pay days" hint={`Calculated: ${days(item.lopDays)}. Whole or half days. Leave empty to use the calculated value.`}>
                {(p) => <Input {...p} value={lop} onChange={(e) => setLop(e.target.value)} inputMode="decimal" placeholder={days(item.lopDays)} />}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={pending} disabled={reason.trim().length < 3} onClick={() => run(() => overrideItemAction(runId, item.id, { lopDays: lop.trim() === '' ? null : lop.trim(), reason: reason.trim() }), after)}>Save loss-of-pay days</Button>
                <Button size="sm" variant="secondary" loading={pending} disabled={reason.trim().length < 3} onClick={() => run(() => overrideItemAction(runId, item.id, { hold: item.status !== 'on_hold', reason: reason.trim() }), after)}>
                  {item.status === 'on_hold' ? 'Release hold' : 'Hold pay'}
                </Button>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

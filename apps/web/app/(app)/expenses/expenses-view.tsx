'use client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Paperclip, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { decideAction } from '../leave/actions';
import { cancelClaimAction, submitClaimAction } from '../payroll/actions';
import { amount, CLAIM_STATUS, CLAIM_TONE, monthLabel } from '../payroll/labels';
import type { ExpenseCategory, ExpenseClaim } from '../payroll/types';
import { useRunner } from '../recruitment/use-runner';

export function ExpensesView({ view, claims, categories, canApprove, canSubmit, currency }: {
  view: 'mine' | 'approvals' | 'all'; claims: ExpenseClaim[]; categories: ExpenseCategory[]; canApprove: boolean; canSubmit: boolean; currency: string;
}) {
  const { pending, notice, run } = useRunner();
  const formRef = useRef<HTMLFormElement>(null);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [fe, setFe] = useState<Record<string, string>>({});
  const cat = categories.find((c) => c.id === categoryId);
  const tabs = [{ v: 'mine', l: 'My claims' }, ...(canApprove ? [{ v: 'approvals', l: 'Waiting for me' }, { v: 'all', l: 'All I can approve' }] : [])];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="grid content-start gap-4 lg:col-span-2">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {tabs.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {tabs.map((t) => (
              <Link key={t.v} href={t.v === 'mine' ? '/expenses' : `/expenses?view=${t.v}`} className={`rounded-full px-3 py-1 text-[0.8125rem] font-medium ${view === t.v ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg'}`}>{t.l}</Link>
            ))}
          </div>
        )}
        <Card>
          <CardHeader title={tabs.find((t) => t.v === view)!.l} />
          {claims.length ? (
            <Table>
              <THead><tr>{view !== 'mine' && <TH>Employee</TH>}<TH>Expense</TH><TH>Date</TH><TH className="text-right">Amount</TH><TH>Status</TH><TH /></tr></THead>
              <TBody>
                {claims.map((c) => (
                  <TR key={c.id}>
                    {view !== 'mine' && <TD>{c.employeeName} <span className="font-mono text-xs text-fg-muted">{c.employeeCode}</span></TD>}
                    <TD>
                      <div className="font-medium">{c.categoryName}</div>
                      <div className="text-xs text-fg-muted">{c.description}</div>
                    </TD>
                    <TD className="text-fg-muted">{c.spentOn}</TD>
                    <TD className="text-right tabular-nums">{amount(c.amount, c.currency)}</TD>
                    <TD>
                      <Badge tone={CLAIM_TONE[c.status] ?? 'neutral'} dot>{CLAIM_STATUS[c.status] ?? c.status}</Badge>
                      {c.paidInMonth && <div className="mt-0.5 text-xs text-fg-muted">with {monthLabel(c.paidInMonth)} pay</div>}
                    </TD>
                    <TD className="whitespace-nowrap text-right">
                      {c.receiptName && <a className="mr-2 inline-flex items-center gap-1 text-[0.8125rem] text-accent hover:underline" href={`/expense-receipts/${c.id}`}><Paperclip className="size-3" /> Receipt</a>}
                      {view === 'mine' && c.status === 'pending' && <Button size="sm" variant="ghost" loading={pending} onClick={() => confirm('Withdraw this claim?') && run(() => cancelClaimAction(c.id))}>Withdraw</Button>}
                      {view === 'approvals' && c.approvalRequestId && (
                        <span className="inline-flex gap-1">
                          <Button size="sm" variant="secondary" loading={pending} onClick={() => { const why = prompt('Reason for rejecting (shared with the employee):'); if (why !== null) run(() => decideAction(c.approvalRequestId!, 'reject', why.trim() || undefined)); }}>Reject</Button>
                          <Button size="sm" loading={pending} onClick={() => run(() => decideAction(c.approvalRequestId!, 'approve'))}>Approve</Button>
                        </span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <EmptyState icon={<Receipt className="size-5" />} title={view === 'approvals' ? 'Nothing waiting for you' : 'No claims yet'} description={view === 'mine' ? 'Submit a claim with its receipt; approved claims are paid with your next salary.' : undefined} />
          )}
        </Card>
      </div>

      {canSubmit && view === 'mine' && (
        <Card className="h-fit">
          <CardHeader title="New claim" description="Your manager approves it." />
          <CardBody>
            <form
              ref={formRef}
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                const form = new FormData(e.currentTarget);
                setFe({});
                run(async () => {
                  const r = await submitClaimAction(form);
                  if (!r.ok) setFe(r.fieldErrors ?? {});
                  return r;
                }, () => formRef.current?.reset());
              }}
            >
              <Field label="Category" required>
                {(p) => <Select {...p} name="categoryId" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>}
              </Field>
              <Field label="Date spent" required error={fe.spentOn}>{(p) => <Input {...p} type="date" name="spentOn" required max={new Date().toISOString().slice(0, 10)} />}</Field>
              <Field label={`Amount (${currency})`} required error={fe.amount} hint={cat?.maxPerClaim ? `Up to ${amount(cat.maxPerClaim, currency)} per claim` : undefined}>{(p) => <Input {...p} name="amount" inputMode="decimal" required placeholder="1200" />}</Field>
              <Field label="What was it for" required error={fe.description}>{(p) => <Textarea {...p} name="description" required rows={2} placeholder="Cab to the client site" />}</Field>
              <Field label="Receipt" required={cat?.receiptRequired} hint="PDF, JPEG or PNG up to 5 MB">{(p) => <Input {...p} type="file" name="receipt" accept="application/pdf,image/jpeg,image/png" />}</Field>
              <Button type="submit" loading={pending} disabled={!categories.length}>Submit claim</Button>
            </form>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

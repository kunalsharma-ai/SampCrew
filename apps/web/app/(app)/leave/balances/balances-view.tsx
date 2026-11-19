'use client';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Department, LeaveAdjustment, LeaveOverview, LeaveType } from '@/lib/types';
import { adjustLeaveAction } from './actions';

type Row = LeaveOverview['rows'][number];

/** One row per person, one column per leave type: what is available now (or taken, for types with no balance). */
export function BalanceOverview({ data, departments, types, filters }: { data: LeaveOverview; departments: Department[]; types: LeaveType[]; filters: { departmentId: string; q: string } }) {
  const [adjusting, setAdjusting] = useState<Row | null>(null);
  return (
    <div className="grid gap-4">
      <form className="flex flex-wrap items-end gap-3" action="/leave/balances">
        <Field label="Year">{(p) => <Select {...p} name="year" defaultValue={String(data.year)} onChange={(e) => e.currentTarget.form?.requestSubmit()}>{[data.year - 1, data.year, data.year + 1].map((y) => <option key={y} value={y}>{y}</option>)}</Select>}</Field>
        {departments.length > 0 && (
          <Field label="Department">{(p) => <Select {...p} name="departmentId" defaultValue={filters.departmentId} onChange={(e) => e.currentTarget.form?.requestSubmit()}><option value="">All</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>
        )}
        <Field label="Search">{(p) => <Input {...p} name="q" defaultValue={filters.q} placeholder="Name or employee code" />}</Field>
        <Button type="submit" variant="secondary">Show</Button>
      </form>
      {data.truncated && <Alert tone="info">Showing the first 500 people. Choose a department or search to see others.</Alert>}
      <Card>
        <CardHeader title={`Balances in ${data.year}`} description="Available days (balance less requests waiting for approval). Types without a balance, such as work from home, show the days taken." />
        {data.rows.length ? (
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <tr>
                  <TH>Person</TH>
                  {data.types.map((t) => <TH key={t.id} className="text-right" title={t.name}><span className="inline-flex items-center gap-1"><span className="size-2 rounded-full" style={{ background: t.color }} />{t.code}</span></TH>)}
                  <TH />
                </tr>
              </THead>
              <TBody>
                {data.rows.map((r) => (
                  <TR key={r.employeeId} data-testid="balance-row">
                    <TD>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-fg-muted">{r.code}{r.departmentName ? ` · ${r.departmentName}` : ''}</div>
                    </TD>
                    {data.types.map((t) => {
                      const b = r.balances[t.id];
                      if (!b) return <TD key={t.id} className="text-right text-fg-subtle">–</TD>;
                      return (
                        <TD key={t.id} className="text-right tabular-nums" data-type={t.code}>
                          {b.available !== null ? <span className={Number(b.available) < 0 ? 'text-danger' : ''}>{b.available}</span> : <span className="text-fg-muted">{b.taken} taken</span>}
                          {Number(b.pending) > 0 && <div className="text-[0.6875rem] text-warning">{b.pending} pending</div>}
                        </TD>
                      );
                    })}
                    <TD className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" onClick={() => setAdjusting(r)}><SlidersHorizontal className="size-3.5" /> Adjust</Button>
                      <Link className="text-xs text-accent hover:underline" href={`/leave/balances?tab=history&year=${data.year}&employeeId=${r.employeeId}`}>History</Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        ) : <EmptyState title="Nobody to show" description="No one you can see matches these filters." />}
      </Card>
      {adjusting && <AdjustDialog row={adjusting} types={types.filter((t) => adjusting.balances[t.id])} onClose={() => setAdjusting(null)} />}
    </div>
  );
}

/** Add or deduct days with a remark; the remark is required, shown to the person and kept in the history. */
function AdjustDialog({ row, types, onClose }: { row: Row; types: LeaveType[]; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ leaveTypeId: types[0]?.id ?? '', direction: 'add', days: '1', note: '' });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Adjust ${row.name}'s balance`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="adjust-form" loading={pending} disabled={form.note.trim().length < 3}>Save adjustment</Button></>}
    >
      <form
        id="adjust-form"
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          setFe({});
          start(async () => {
            const quantity = `${form.direction === 'deduct' ? '-' : ''}${form.days.trim()}`;
            const r = await adjustLeaveAction({ employeeId: row.employeeId, leaveTypeId: form.leaveTypeId, quantity, note: form.note.trim() });
            if (r.ok) { onClose(); router.refresh(); } else { setError(r.message); setFe(r.fieldErrors ?? {}); }
          });
        }}
      >
        {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
        <Field label="Leave type" className="sm:col-span-2">{(p) => <Select {...p} value={form.leaveTypeId} onChange={(e) => setForm({ ...form, leaveTypeId: e.target.value })}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>}</Field>
        <Field label="Change">{(p) => <Select {...p} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option value="add">Add days</option><option value="deduct">Deduct days</option></Select>}</Field>
        <Field label="Days" required error={fe.quantity}>{(p) => <Input {...p} type="number" min="0.5" step="0.5" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} required />}</Field>
        <Field label="Remark" required className="sm:col-span-2" hint="Required. The person sees it, and it stays in the adjustment history." error={fe.note}>
          {(p) => <Textarea {...p} value={form.note} maxLength={500} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="For example: worked on the 15 November holiday" required />}
        </Field>
      </form>
    </Dialog>
  );
}

/** Every manual change to a balance, newest first, with its remark and who made it. */
export function AdjustmentHistory({ rows, year }: { rows: LeaveAdjustment[]; year: number }) {
  return (
    <Card>
      <CardHeader title={`Adjustments in ${year}`} description="Days added or deducted by hand, including opening balances set when a record was added. Ledger lines are never edited: a mistake is corrected with another adjustment." />
      {rows.length ? (
        <Table>
          <THead><tr><TH>When</TH><TH>Person</TH><TH>Type</TH><TH className="text-right">Days</TH><TH>Remark</TH><TH>By</TH></tr></THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.id} data-testid="adjustment-row">
                <TD className="whitespace-nowrap text-fg-muted" suppressHydrationWarning>{new Date(r.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</TD>
                <TD><div className="font-medium">{r.employeeName}</div><div className="text-xs text-fg-muted">{r.employeeCode}</div></TD>
                <TD>{r.leaveTypeName ?? '—'}{r.opening && <Badge className="ml-1.5">Opening balance</Badge>}</TD>
                <TD className={`text-right tabular-nums ${Number(r.quantity) < 0 ? 'text-danger' : 'text-success'}`}>{Number(r.quantity) > 0 ? '+' : ''}{r.quantity}</TD>
                <TD className="max-w-md text-fg-muted">{r.note ?? '—'}</TD>
                <TD className="text-fg-muted">{r.by ?? 'SampCrew'}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : <EmptyState title="No adjustments" description="Nobody's balance has been changed by hand this year." />}
    </Card>
  );
}

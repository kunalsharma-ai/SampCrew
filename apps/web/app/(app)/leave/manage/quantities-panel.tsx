'use client';
import { Alert, Badge, Card, CardHeader, EmptyState, Input, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { LeaveQuantities } from '@/lib/types';
import { assignQuantityAction } from './actions';

/**
 * Assign Leave Quantities: one row per person the caller assigns for, one column per leave type they can apply for.
 * A cell holds the days typed by hand for the year; an empty cell is Not Assigned (people still apply, and HR sees
 * the application). Nothing here is calculated, and changing a number keeps the old one in the history.
 */
export function QuantitiesPanel({ data, q }: { data: LeaveQuantities; q: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const key = (e: string, t: string) => `${e}:${t}`;
  const save = (employeeId: string, leaveTypeId: string, name: string, typeName: string, before: string | null) => {
    const k = key(employeeId, leaveTypeId);
    const v = (draft[k] ?? '').trim();
    if (draft[k] === undefined || v === '' || (before !== null && Number(v) === Number(before))) return;
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) { setNotice({ tone: 'danger', text: 'Type a number of days, such as 5 or 2.5' }); return; }
    start(async () => {
      const r = await assignQuantityAction({ employeeId, leaveTypeId, year: data.year, quantity: v });
      setNotice(r.ok ? { tone: 'success', text: `${name}: ${v} days of ${typeName} for ${data.year}` } : { tone: 'danger', text: r.message ?? 'Could not save' });
      if (r.ok) { setDraft((d) => { const n = { ...d }; delete n[k]; return n; }); router.refresh(); }
    });
  };
  return (
    <div className="grid gap-4">
      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      <form className="flex flex-wrap items-end gap-3" action="/leave/manage">
        <input type="hidden" name="tab" value="quantities" />
        <input type="hidden" name="year" value={data.year} />
        <label className="grid gap-1 text-xs font-medium">Find a person<Input name="q" defaultValue={q} placeholder="Name or employee code" className="w-64" /></label>
        <button className="h-9 rounded-md border border-border px-3 text-sm" type="submit">Search</button>
      </form>
      <Card>
        <CardHeader title={`Leave quantities for ${data.year}`}
          description="Type the days each person has; press Enter or leave the box to save. Empty means Not Assigned. Nobody gets days automatically, and nobody can assign days to themselves." />
        {data.rows.length && data.types.length ? (
          <Table aria-label="Leave quantities">
            <THead>
              <tr>
                <TH>Employee</TH>
                {data.types.map((t) => <TH key={t.id}><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full" style={{ background: t.color }} aria-hidden />{t.name}</span></TH>)}
              </tr>
            </THead>
            <TBody>
              {data.rows.map((r) => (
                <TR key={r.employeeId} data-testid="quantity-row">
                  <TD className="min-w-48"><div className="font-medium">{r.name}</div><div className="text-xs text-fg-subtle">{[r.code, r.departmentName, r.hrWorkspaceName].filter(Boolean).join(' · ')}</div></TD>
                  {data.types.map((t) => {
                    const c = r.cells[t.id];
                    if (!c) return <TD key={t.id} className="text-xs text-fg-subtle">Not visible</TD>;
                    const k = key(r.employeeId, t.id);
                    return (
                      <TD key={t.id} className="min-w-36">
                        <Input aria-label={`${t.name} days for ${r.name}`} inputMode="decimal" className="h-8 w-24 text-sm tabular-nums" disabled={pending}
                          placeholder="Not Assigned" value={draft[k] ?? c.assigned ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                          onBlur={() => save(r.employeeId, t.id, r.name, t.name, c.assigned)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(r.employeeId, t.id, r.name, t.name, c.assigned); } }} />
                        <div className="mt-1 text-[0.6875rem] text-fg-subtle tabular-nums">
                          {c.assigned === null ? <Badge>Not Assigned</Badge> : <>{c.used} used · <strong className={Number(c.remaining) < 0 ? 'text-danger' : ''}>{c.remaining}</strong> left</>}
                          {c.assigned === null && Number(c.used) > 0 && <span className="ml-1">{c.used} used</span>}
                        </div>
                      </TD>
                    );
                  })}
                </TR>
              ))}
            </TBody>
          </Table>
        ) : <EmptyState title={data.types.length ? 'Nobody to show' : 'No leave types yet'} description={data.types.length ? 'Nobody in your scope matches.' : 'Create a leave type first, on the Leave types tab.'} />}
        {data.truncated && <p className="px-5 py-3 text-xs text-fg-muted">Showing the first 500 people. Search to find someone else.</p>}
      </Card>
    </div>
  );
}

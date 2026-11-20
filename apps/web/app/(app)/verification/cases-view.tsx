'use client';
import { BGV_CHECK_LABEL, BGV_CHECK_TYPES, BGV_STATUS_LABEL } from '@crew/contracts';
import { Alert, Badge, Button, buttonClass, Card, CardBody, Checkbox, DatePicker, Dialog, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Download, Search, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createCaseAction, searchEmployeesAction } from './actions';
import { day, STATUS_TONE } from './labels';
import type { Agency, CaseRow, Verifier } from './types';

type Filters = { status: string; q: string; method: string };

export function CasesView({ cases, agencies, verifiers, filters, can, startFor = null }: { cases: CaseRow[]; agencies: Agency[]; verifiers: Verifier[]; filters: Filters; can: { create: boolean; export: boolean; manage: boolean }; startFor?: { id: string; name: string } | null }) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q);
  const [starting, setStarting] = useState(Boolean(startFor));
  const go = (next: Partial<Filters>) => {
    const p = new URLSearchParams({ ...filters, ...next });
    for (const [k, v] of [...p.entries()]) if (!v || (k === 'status' && v === 'open')) p.delete(k);
    router.push(`/verification${p.size ? `?${p}` : ''}`);
  };
  const exportQs = new URLSearchParams({ ...(filters.status !== 'all' ? { status: filters.status } : {}), ...(filters.q ? { q: filters.q } : {}), ...(filters.method ? { method: filters.method } : {}) });

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Shown" value={cases.length} />
        <Stat label="Overdue" value={cases.filter((c) => c.overdue).length} hint="Past the due date and not finished" />
        <Stat label="With an agency" value={cases.filter((c) => c.method === 'external').length} />
        <Stat label="Failed checks" value={cases.reduce((n, c) => n + c.checks.failed, 0)} />
      </div>
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status" className="w-44">
            {(p) => (
              <Select {...p} value={filters.status} onChange={(e) => go({ status: e.target.value })}>
                <option value="open">Not finished</option>
                <option value="all">All</option>
                {Object.entries(BGV_STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Done by" className="w-40">
            {(p) => <Select {...p} value={filters.method} onChange={(e) => go({ method: e.target.value })}><option value="">HR or agency</option><option value="internal">HR</option><option value="external">Agency</option></Select>}
          </Field>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); go({ q }); }}>
            <Field label="Search">{(p) => <Input {...p} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, employee ID or BGV-2026-0001" />}</Field>
            <Button type="submit" variant="secondary" aria-label="Search cases"><Search className="size-3.5" aria-hidden /></Button>
          </form>
          <div className="ml-auto flex flex-wrap gap-2">
            {can.manage && <Link className={buttonClass('secondary')} href="/verification/agencies">Agencies</Link>}
            {can.export && <a className={buttonClass('secondary')} href={`/bgv-export?${exportQs}`} data-feature="background_verification.export"><Download className="size-3.5" aria-hidden /> Excel</a>}
            {can.create && <Button onClick={() => setStarting(true)}><ShieldCheck className="size-4" aria-hidden /> Start verification</Button>}
          </div>
        </CardBody>
        {cases.length ? (
          <Table aria-label="Verification cases">
            <THead><tr><TH>Case</TH><TH>Employee</TH><TH>Status</TH><TH>Checks</TH><TH>Done by</TH><TH>Due</TH><TH>Verifier</TH></tr></THead>
            <TBody>
              {cases.map((c) => (
                <TR key={c.id}>
                  <TD><Link className="font-mono font-medium text-accent hover:underline" href={`/verification/${c.id}`}>{c.reference}</Link></TD>
                  <TD>{c.employeeName}<div className="text-xs text-fg-muted">{[c.employeeCode, c.department].filter(Boolean).join(' · ')}</div></TD>
                  <TD><Badge tone={STATUS_TONE[c.status]}>{BGV_STATUS_LABEL[c.status as keyof typeof BGV_STATUS_LABEL] ?? c.status}</Badge></TD>
                  <TD>{c.checks.done} of {c.checks.total}{c.checks.failed ? <span className="text-danger"> · {c.checks.failed} failed</span> : null}<div className="text-xs text-fg-muted">{c.checks.types.map((t) => BGV_CHECK_LABEL[t as keyof typeof BGV_CHECK_LABEL]).join(', ')}</div></TD>
                  <TD>{c.method === 'external' ? c.agencyName ?? 'Agency' : 'HR'}</TD>
                  <TD className={c.overdue ? 'text-danger' : ''}>{c.completedOn ? `Done ${day(c.completedOn)}` : day(c.dueDate) || 'No date'}{c.overdue ? ' · overdue' : ''}</TD>
                  <TD className="text-fg-muted">{c.assignee ?? 'Nobody'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <CardBody><EmptyState icon={<ShieldCheck className="size-5" />} title="No verification cases" description={can.create ? 'Start one for a new joiner or an existing employee.' : 'No cases match these filters.'} /></CardBody>
        )}
      </Card>
      {can.create && <StartDialog open={starting} onClose={() => setStarting(false)} initialWho={startFor} agencies={agencies.filter((a) => a.active)} verifiers={verifiers} />}
    </div>
  );
}

function StartDialog({ open, onClose, agencies, verifiers, initialWho = null }: { open: boolean; onClose: () => void; agencies: Agency[]; verifiers: Verifier[]; initialWho?: { id: string; name: string } | null }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; departmentName: string | null }[]>([]);
  const [who, setWho] = useState<{ id: string; name: string } | null>(initialWho);
  const [method, setMethod] = useState<'internal' | 'external'>('internal');
  const [types, setTypes] = useState<string[]>(['identity', 'address', 'education', 'employment']);
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const find = () => start(async () => { const r = await searchEmployeesAction(search); setFound(r.ok ? r.data ?? [] : []); });
  const toggle = (t: string) => setTypes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Start background verification" description="Choose the checks now; HR fills in the details and documents on the case."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="start-bgv" loading={pending} disabled={!who || !types.length}>Start verification</Button></>}>
      <form id="start-bgv" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await createCaseAction({
            employeeId: who?.id, method, ...(method === 'external' ? { agencyId: f.get('agencyId') || undefined } : {}),
            checks: types.map((type) => ({ type })), ...(dueDate ? { dueDate } : {}),
            ...(f.get('assigneeMembershipId') ? { assigneeMembershipId: f.get('assigneeMembershipId') } : {}), notes: String(f.get('notes') ?? ''),
          });
          if (r.ok && r.data) { onClose(); router.push(`/verification/${r.data.id}`); } else if (!r.ok) { setError(r.message); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        {who ? (
          <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.8125rem]"><span className="font-medium">{who.name}</span><Button size="sm" variant="ghost" type="button" className="ml-auto" onClick={() => setWho(null)}>Change</Button></div>
        ) : (
          <div className="grid gap-2">
            <div className="flex gap-2">
              <Input aria-label="Find the employee" placeholder="Find the employee by name or ID" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } }} />
              <Button type="button" variant="secondary" onClick={find} aria-label="Find"><Search className="size-3.5" aria-hidden /></Button>
            </div>
            {found.map((x) => <button key={x.id} type="button" className="rounded-md px-2 py-1 text-left text-[0.8125rem] hover:bg-bg-subtle" onClick={() => setWho(x)}>{x.name} <span className="text-xs text-fg-muted">{x.departmentName}</span></button>)}
            {fe.employeeId && <p className="text-xs text-danger">{fe.employeeId}</p>}
          </div>
        )}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[0.8125rem] font-medium">Checks</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {BGV_CHECK_TYPES.map((t) => <Checkbox key={t} label={BGV_CHECK_LABEL[t]} checked={types.includes(t)} onChange={() => toggle(t)} />)}
          </div>
          {fe.checks && <p className="text-xs text-danger">{fe.checks}</p>}
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Done by">
            {(p) => <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'internal' | 'external')}><option value="internal">HR (internal)</option><option value="external" disabled={!agencies.length}>An agency{agencies.length ? '' : ' (add one first)'}</option></Select>}
          </Field>
          {method === 'external' ? (
            <Field label="Agency" required error={fe.agencyId}>{(p) => <Select {...p} name="agencyId" required><option value="">Choose…</option>{agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
          ) : (
            <Field label="Verifier" hint="Someone who may edit checks" error={fe.assigneeMembershipId}>{(p) => <Select {...p} name="assigneeMembershipId"><option value="">Not yet</option>{verifiers.map((v) => <option key={v.membershipId} value={v.membershipId}>{v.name}</option>)}</Select>}</Field>
          )}
          <Field label="Due date" error={fe.dueDate}>{(p) => <DatePicker {...p} value={dueDate} onChange={setDueDate} />}</Field>
        </div>
        <Field label="Notes" error={fe.notes}>{(p) => <Textarea {...p} name="notes" rows={3} maxLength={2000} />}</Field>
        {method === 'external' && <p className="text-xs text-fg-muted">After the case is created, share the documents the agency needs and send it the private link from the case page.</p>}
      </form>
    </Dialog>
  );
}

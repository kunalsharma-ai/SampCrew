'use client';
import { Alert, Badge, Button, Card, CardBody, Dialog, EmptyState, Field, Input, Select, Stat, Table, TBody, TD, TH, THead, TR, Textarea } from '@crew/ui';
import { Inbox, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { createCaseAction, searchEmployeesAction } from '../actions';
import { dateTime, PRIORITY, PRIORITY_TONE, STATUS, STATUS_TONE, TARGET, TARGET_TONE } from '../labels';
import type { CaseRow, Category } from '../types';

export function QueueView({ cases, categories, filters }: { cases: CaseRow[]; categories: Category[]; filters: { status: string; assigned: string; q: string } }) {
  const router = useRouter();
  const [q, setQ] = useState(filters.q);
  const [logging, setLogging] = useState(false);
  const go = (next: Partial<typeof filters>) => {
    const p = new URLSearchParams({ ...filters, ...next });
    for (const [k, v] of [...p.entries()]) if (!v || (k === 'status' && v === 'active') || (k === 'assigned' && v === 'all')) p.delete(k);
    router.push(`/helpdesk/queue${p.size ? `?${p}` : ''}`);
  };
  const overdue = cases.filter((c) => c.firstResponse === 'overdue' || c.resolution === 'overdue').length;
  const unassigned = cases.filter((c) => !c.assigneeMembershipId).length;

  return (
    <div className="grid gap-6">
      {filters.status === 'active' && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Open cases" value={cases.length} />
          <Stat label="Overdue" value={overdue} hint="First reply or resolution past its target" />
          <Stat label="Unassigned" value={unassigned} />
          <Stat label="Waiting on employee" value={cases.filter((c) => c.status === 'waiting_on_employee').length} />
        </div>
      )}
      <Card>
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Status" className="w-44">
            {(p) => <Select {...p} value={filters.status} onChange={(e) => go({ status: e.target.value })}><option value="active">All not closed</option>{Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}
          </Field>
          <Field label="Assigned" className="w-44">
            {(p) => <Select {...p} value={filters.assigned} onChange={(e) => go({ assigned: e.target.value })}><option value="all">Anyone</option><option value="me">To me</option><option value="unassigned">Nobody</option></Select>}
          </Field>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); go({ q }); }}>
            <Field label="Search">{(p) => <Input {...p} value={q} onChange={(e) => setQ(e.target.value)} placeholder="HR-0042, subject or name" />}</Field>
            <Button type="submit" variant="secondary"><Search className="size-3.5" /></Button>
          </form>
          <Button className="ml-auto" variant="secondary" onClick={() => setLogging(true)}>Log a case for someone</Button>
        </CardBody>
        {cases.length ? (
          <Table>
            <THead><tr><TH>Case</TH><TH>Employee</TH><TH>Status</TH><TH>Priority</TH><TH>First reply</TH><TH>Resolution</TH><TH>Handled by</TH></tr></THead>
            <TBody>
              {cases.map((c) => (
                <TR key={c.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/helpdesk/${c.id}`}>{c.ref}</Link> {c.subject}
                    <div className="text-xs text-fg-muted">{c.categoryName}{c.confidential ? ' · confidential' : ''} · {dateTime(c.createdAt)}</div>
                  </TD>
                  <TD>{c.employeeName}</TD>
                  <TD><Badge tone={STATUS_TONE[c.status]}>{STATUS[c.status]}</Badge></TD>
                  <TD><Badge tone={PRIORITY_TONE[c.priority]}>{PRIORITY[c.priority]}</Badge></TD>
                  <TD><Badge tone={TARGET_TONE[c.firstResponse]}>{TARGET[c.firstResponse]}</Badge></TD>
                  <TD><Badge tone={TARGET_TONE[c.resolution]}>{TARGET[c.resolution]}</Badge></TD>
                  <TD className="text-fg-muted">{c.assigneeName ?? 'Nobody'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <CardBody><EmptyState icon={<Inbox className="size-5" />} title="Nothing here" description="No cases match these filters." /></CardBody>
        )}
      </Card>
      <LogCaseDialog open={logging} onClose={() => setLogging(false)} categories={categories} />
    </div>
  );
}

/** HR logs a case for someone who called or walked in; the person is notified and can follow it. */
function LogCaseDialog({ open, onClose, categories }: { open: boolean; onClose: () => void; categories: Category[] }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<{ id: string; name: string; departmentName: string | null }[]>([]);
  const [who, setWho] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const key = useRef(crypto.randomUUID());
  const find = () => start(async () => { const r = await searchEmployeesAction(search); setFound(r.ok ? r.data ?? [] : []); });
  return (
    <Dialog open={open} onClose={onClose} title="Log a case for someone" description="For a question that came by phone or in person. The person is told and can follow the case."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="log-case" loading={pending} disabled={!who}>Log case</Button></>}>
      <form id="log-case" className="grid gap-4" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setError(null);
        start(async () => {
          const r = await createCaseAction({ employeeId: who?.id, categoryId: f.get('categoryId'), subject: f.get('subject'), description: f.get('description'), priority: f.get('priority') }, key.current);
          if (r.ok && r.data) { key.current = crypto.randomUUID(); onClose(); router.push(`/helpdesk/${r.data.id}`); } else if (!r.ok) { setError(r.message); setFe(r.fieldErrors ?? {}); }
        });
      }}>
        {error && <Alert tone="danger">{error}</Alert>}
        {who ? (
          <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[0.8125rem]"><span className="font-medium">{who.name}</span><Button size="sm" variant="ghost" type="button" className="ml-auto" onClick={() => setWho(null)}>Change</Button></div>
        ) : (
          <div className="grid gap-2">
            <div className="flex gap-2">
              <Input aria-label="Find the employee" placeholder="Find the employee" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); find(); } }} />
              <Button type="button" variant="secondary" onClick={find}><Search className="size-3.5" /></Button>
            </div>
            {found.map((x) => <button key={x.id} type="button" className="rounded-md px-2 py-1 text-left text-[0.8125rem] hover:bg-bg-subtle" onClick={() => setWho(x)}>{x.name} <span className="text-xs text-fg-muted">{x.departmentName}</span></button>)}
          </div>
        )}
        <Field label="Category" required error={fe.categoryId}>{(p) => <Select {...p} name="categoryId" required><option value="">Choose…</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label="Subject" required error={fe.subject}>{(p) => <Input {...p} name="subject" required minLength={3} maxLength={200} />}</Field>
        <Field label="What they asked" required error={fe.description}>{(p) => <Textarea {...p} name="description" rows={4} required minLength={10} maxLength={5000} />}</Field>
        <Field label="Priority">{(p) => <Select {...p} name="priority" defaultValue="normal">{Object.entries(PRIORITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
      </form>
    </Dialog>
  );
}

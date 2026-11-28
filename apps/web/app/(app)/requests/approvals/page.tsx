import { RAISABLE_KINDS, REQUEST_KIND_DEFS, requestDateLabel, type RequestView } from '@crew/contracts';
import { Button, EmptyState, Input, PageHeader, Select, cn } from '@crew/ui';
import { ArrowRight, Inbox } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { LiveRefresh } from '../[id]/request-actions';
import { KindTile, StatusChip } from '../kind-visual';
import type { ApprovalsList } from '../types';
import { RowActions } from './row-actions';

export const metadata: Metadata = { title: 'My Approvals' };

const VIEWS = [
  { key: 'all', label: 'All' }, { key: 'pending', label: 'Pending my approval' }, { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' }, { key: 'changes_requested', label: 'Changes requested' }, { key: 'cancelled', label: 'Cancelled' },
] as const;
const date = (iso: string) => requestDateLabel(iso.slice(0, 10));
const ok = (v: string | undefined, re: RegExp) => (v && re.test(v) ? v : undefined);

/**
 * My Approvals, the unified approval dashboard: every request and leave application the person approves, with the
 * employee's details, the approvers and where it stands, filters, and approve / reject / request changes in place.
 * The Super Workspace and HR who look after leave see everyone's under "All".
 */
export default async function MyApprovalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const view = VIEWS.some((v) => v.key === sp.view) ? sp.view! : 'pending';
  const q = new URLSearchParams({ view, limit: '200' });
  const kind = (RAISABLE_KINDS as readonly string[]).includes(sp.kind ?? '') || sp.kind === 'leave_cancellation' ? sp.kind : undefined;
  const filters = { kind, employee: sp.employee?.trim().slice(0, 80) || undefined, from: ok(sp.from, /^\d{4}-\d{2}-\d{2}$/), to: ok(sp.to, /^\d{4}-\d{2}-\d{2}$/), workspace: ok(sp.workspace, /^(super|hr|employee)$/) };
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  const list = await load<ApprovalsList>(`/requests/approvals?${q}`);
  const href = (v: string) => { const n = new URLSearchParams(q); n.set('view', v); n.delete('limit'); return `/requests/approvals?${n}`; };
  return (
    <>
      <LiveRefresh />
      <PageHeader title="My Approvals" description="Requests and leave applications for your decision. Approve, reject or ask for changes here, or open one for its full history."
        actions={<Link href="/approvals" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[0.8125rem] font-medium text-fg hover:bg-bg-subtle">Other approvals (expenses, documents …) <ArrowRight className="size-3.5" /></Link>} />

      <nav aria-label="Approval status" className="mb-4 flex flex-wrap gap-1 rounded-xl border border-border bg-surface p-1 shadow-card" data-testid="approval-views">
        {VIEWS.map((v) => (
          <Link key={v.key} href={href(v.key)} aria-current={view === v.key ? 'page' : undefined}
            className={cn('rounded-lg px-3 py-1.5 text-[0.8125rem] font-medium', view === v.key ? 'bg-accent text-accent-fg shadow-card' : 'text-fg-muted hover:bg-bg-subtle hover:text-fg')}>
            {v.label} <span className="tabular opacity-80">{list.counts[v.key as keyof typeof list.counts]}</span>
          </Link>
        ))}
      </nav>

      <form method="get" className="mb-4 grid gap-2 rounded-xl border border-border bg-surface p-3 shadow-card sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]" aria-label="Filters">
        <input type="hidden" name="view" value={view} />
        <Select name="kind" defaultValue={kind ?? ''} aria-label="Request type">
          <option value="">Every type</option>
          {[...RAISABLE_KINDS, 'leave_cancellation' as const].map((k) => <option key={k} value={k}>{REQUEST_KIND_DEFS[k].label}</option>)}
        </Select>
        <Input name="employee" defaultValue={filters.employee ?? ''} placeholder="Employee name or code" aria-label="Employee" />
        <Input name="from" type="date" defaultValue={filters.from ?? ''} aria-label="From date" />
        <Input name="to" type="date" defaultValue={filters.to ?? ''} aria-label="To date" />
        <Select name="workspace" defaultValue={filters.workspace ?? ''} aria-label="Workspace">
          <option value="">Every workspace</option><option value="employee">Employee Workspace</option><option value="hr">HR Workspace</option><option value="super">Super Workspace</option>
        </Select>
        <Button type="submit" variant="secondary">Filter</Button>
      </form>

      {list.items.length ? (
        <div className="overflow-x-auto rounded-2xl border border-border bg-surface shadow-card">
          <table className="w-full min-w-[72rem] text-left text-[0.8125rem]" data-testid="approvals-table">
            <thead className="bg-bg-subtle/60 text-xs text-fg-muted">
              <tr>{['Request ID', 'Employee', 'Designation', 'Department', 'Type', 'Requested', 'Dates', 'Reason', 'Primary approver', 'Additional approvers', 'Status', 'Pending action'].map((h) => <th key={h} className="whitespace-nowrap border-b border-border px-3 py-2.5 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.items.map((r: RequestView) => {
                const primary = r.approvers.find((a) => a.part === 'primary');
                const extra = r.approvers.filter((a) => a.part === 'additional');
                return (
                  <tr key={r.id} className="align-top hover:bg-bg-subtle/50" data-testid="approval-row" data-request-id={r.id}>
                    <td className="px-3 py-3"><Link href={`/requests/${r.id}`} className="font-mono text-xs font-semibold text-accent hover:underline">{r.ref}</Link></td>
                    <td className="px-3 py-3"><div className="font-semibold text-fg">{r.requester.name}</div><div className="font-mono text-[0.6875rem] text-fg-subtle">{r.requester.employeeCode ?? '—'}</div><div className="text-[0.6875rem] text-fg-muted">{r.requester.levelLabel}</div></td>
                    <td className="px-3 py-3 text-fg-muted">{r.requester.designation ?? '—'}</td>
                    <td className="px-3 py-3 text-fg-muted">{r.requester.department ?? '—'}</td>
                    <td className="px-3 py-3"><span className="inline-flex items-center gap-2"><KindTile kind={r.kind} size="sm" /><span className="font-medium">{r.kindLabel}</span></span></td>
                    <td className="whitespace-nowrap px-3 py-3 text-fg-muted">{date(r.createdAt)}</td>
                    <td className="px-3 py-3">{r.when}</td>
                    <td className="max-w-56 px-3 py-3"><span className="line-clamp-2 break-words">{r.reason}</span></td>
                    <td className="px-3 py-3">{primary ? <><div className="font-medium">{primary.name}</div><StatusChip status={primary.status} /></> : '—'}</td>
                    <td className="px-3 py-3">{extra.length ? <ul className="grid gap-1">{extra.map((a) => <li key={a.membershipId} className="flex flex-wrap items-center gap-1"><span>{a.name}</span><StatusChip status={a.status} /></li>)}</ul> : '—'}</td>
                    <td className="px-3 py-3"><StatusChip status={r.status} /></td>
                    <td className="px-3 py-3">{r.can.decide ? <RowActions id={r.id} subject={`${r.ref}, ${r.requester.name}`} /> : <span className="text-xs text-fg-muted">{r.pendingWith ? `Waiting for ${r.pendingWith}` : 'None'}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={<Inbox className="size-5" />} title={view === 'pending' ? 'Nothing waiting for your approval' : 'No requests here'} description="Requests and leave applications that name you as an approver appear here." />
      )}
    </>
  );
}

'use client';
import { useCreateParam } from '@/lib/use-create-param';
import { Badge, Button, Card, CardHeader, EmptyState, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ResourceDialog } from '@/components/resource-form';
import type { Requisition } from '@/lib/types';
import { saveRequisitionAction } from './actions';
import { range, REQ_STATUS, REQ_TONE, WORK_MODE } from './labels';
import { requisitionFields, type RequisitionRefs } from './requisition-form';

/** Starting values another page may pass, such as a draft from CREW IQ. */
const PREFILL = ['title', 'description'] as const;

const FILTERS = [
  { status: '', label: 'All' }, { status: 'open', label: 'Open' }, { status: 'pending_approval', label: 'Awaiting approval' },
  { status: 'draft', label: 'Drafts' }, { status: 'on_hold', label: 'On hold' }, { status: 'filled', label: 'Filled' }, { status: 'closed', label: 'Closed' },
];

export function JobsView({ reqs, filter, canCreate, refs, defaults }: {
  reqs: Requisition[]; filter: { status: string; scope: 'all' | 'mine' }; canCreate: boolean; refs: RequisitionRefs; defaults: { currency: string; membershipId: string };
}) {
  const router = useRouter();
  const [open, setOpen, prefill] = useCreateParam('requisition', PREFILL);
  const href = (status: string, scope = filter.scope) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (scope === 'mine') q.set('scope', 'mine');
    return `/recruitment${q.size ? `?${q}` : ''}`;
  };
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link key={f.status} href={href(f.status)} className={`rounded-full px-3 py-1 text-[0.8125rem] font-medium ${filter.status === f.status ? 'bg-accent text-accent-fg' : 'bg-bg-subtle text-fg-muted hover:text-fg'}`}>{f.label}</Link>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <Link href={href(filter.status, filter.scope === 'mine' ? 'all' : 'mine')} className="text-[0.8125rem] font-medium text-accent hover:underline">
          {filter.scope === 'mine' ? 'Show all jobs I can see' : 'Only jobs I manage or raised'}
        </Link>
      </div>
      <Card>
        <CardHeader title="Job requisitions" action={canCreate && refs.departments.length > 0 && <Button size="sm" onClick={() => setOpen(true)}><Plus className="size-3.5" /> New requisition</Button>} />
        {reqs.length ? (
          <Table>
            <THead><tr><TH>Job</TH><TH>Department</TH><TH>Hiring manager</TH><TH>Status</TH><TH>Openings</TH><TH>Candidates</TH><TH>Budget</TH></tr></THead>
            <TBody>
              {reqs.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/recruitment/jobs/${r.id}`}>{r.title}</Link>
                    <div className="text-xs text-fg-muted"><span className="font-mono">{r.code}</span> · {WORK_MODE[r.workMode]}{r.locationName ? ` · ${r.locationName}` : ''}{r.published ? ' · On career site' : ''}</div>
                  </TD>
                  <TD>{r.departmentName}</TD>
                  <TD>{r.hiringManagerName}</TD>
                  <TD><Badge tone={REQ_TONE[r.status] ?? 'neutral'} dot>{REQ_STATUS[r.status] ?? r.status}</Badge></TD>
                  <TD className="tabular-nums">{r.hiredCount} of {r.headcount} filled</TD>
                  <TD className="tabular-nums">{r.activeApplications} active<span className="text-xs text-fg-muted"> / {r.totalApplications}</span></TD>
                  <TD className="text-fg-muted">{range(r.salaryMin, r.salaryMax, r.currency)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState title={filter.status ? 'No jobs with this status' : 'No requisitions yet'} description={canCreate ? 'Raise a requisition for a role you need. HR approves it, then you can open it, post it and start adding candidates.' : 'Requisitions you are involved in appear here.'} />
        )}
      </Card>
      <ResourceDialog
        open={open}
        onClose={() => setOpen(false)}
        title="New requisition"
        description="Saved as a draft. Submit it for approval from the job page."
        fields={requisitionFields(refs)}
        initial={{
          currency: defaults.currency, headcount: 1, employmentType: 'full_time', workMode: 'onsite', legalEntityId: refs.entities[0]?.id, departmentId: refs.departments[0]?.id,
          hiringManagerMembershipId: refs.people.some((p) => p.membershipId === defaults.membershipId) ? defaults.membershipId : refs.people[0]?.membershipId,
          scorecard: 'Role skills\nProblem solving\nCommunication\nTeam fit',
          ...prefill,
        }}
        submitLabel="Save draft"
        onSubmit={async (v) => {
          const r = await saveRequisitionAction(null, v);
          if (r.ok && r.data) router.push(`/recruitment/jobs/${(r.data as { id: string }).id}`);
          return r;
        }}
      />
    </div>
  );
}

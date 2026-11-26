import { EmptyState, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { Targets } from '../documents/types';
import { LiveDocuments } from '../documents/ui';
import { AssignToSomeone, ListFilters } from './list-ui';
import type { ChecklistRow } from './types';
import { ProgressBar } from './ui';

export const metadata: Metadata = { title: 'Onboarding documents' };

export default async function OnboardingDocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const status = sp.status === 'completed' ? 'completed' : 'active';
  const q = new URLSearchParams({ status });
  if (sp.q) q.set('q', sp.q);
  if (sp.pending === 'true') q.set('pending', 'true');
  const [data, targets] = await Promise.all([
    load<{ rows: ChecklistRow[]; totals: { active: number; pendingApproval: number } }>(`/onboarding-documents/checklists?${q}`),
    load<Targets>('/document-requests/targets').catch(() => ({ employees: [], hrWorkspaces: [] }) as Targets),
  ]);
  return (
    <>
      <LiveDocuments />
      <PageHeader
        title="Onboarding documents"
        description={`Every new joiner's onboarding documents and how far they are. ${data.totals.active} active, ${data.totals.pendingApproval} document${data.totals.pendingApproval === 1 ? '' : 's'} waiting for HR approval.`}
        actions={<div className="flex flex-wrap items-center gap-3"><Link className="text-sm font-medium text-accent hover:underline" href="/settings/onboarding-documents">Library and templates</Link><AssignToSomeone employees={targets.employees} /></div>}
      />
      <ListFilters status={status} q={sp.q ?? ''} pending={sp.pending === 'true'} />
      {data.rows.length === 0 ? (
        <EmptyState title={status === 'completed' ? 'No completed onboarding yet' : 'No onboarding documents in progress'} description="Onboarding documents are assigned in the Add Employee form, or with Assign onboarding documents above." />
      ) : (
        <Table aria-label="Onboarding checklists">
          <THead><TR><TH>Employee</TH><TH>Template</TH><TH>Joined</TH><TH>Approved</TH><TH>Waiting for HR</TH><TH className="w-56">Progress</TH></TR></THead>
          <TBody>
            {data.rows.map((r) => (
              <TR key={r.id} data-testid="onboarding-row">
                <TD>
                  <Link className="font-medium text-accent hover:underline" href={`/onboarding-documents/${r.id}`}>{r.employee.name}</Link>
                  <span className="block text-xs text-fg-subtle">{[r.employee.code, r.employee.department, r.hrWorkspace].filter(Boolean).join(' · ')}</span>
                </TD>
                <TD>{r.templateName ?? 'Chosen documents'}</TD>
                <TD>{r.employee.dateOfJoining}</TD>
                <TD>{r.approved} of {r.total}</TD>
                <TD>{r.pendingApproval ? <span className="font-medium text-info">{r.pendingApproval}</span> : '0'}</TD>
                <TD><ProgressBar percent={r.percent} label="approved" /></TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </>
  );
}

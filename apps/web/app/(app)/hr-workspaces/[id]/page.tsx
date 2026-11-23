import { HR_WORKSPACE_KIND_LABEL, type ConfigVersionRow, type HierarchyMemberRow, type HrWorkspaceDetail, type HrWorkspaceSummary, type TransferRow } from '@crew/contracts';
import { Card, CardHeader, EmptyState, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { Member, Page } from '@/lib/types';
import type { Catalogue, DocRow, MyDocAccess, RequestRow, Targets } from '../../documents/types';
import { DocumentTable, RequestDocumentButton, RequestTable } from '../../documents/ui';
import { WorkspaceDetail } from './workspace-detail';

export const metadata: Metadata = { title: 'HR Workspace' };

const TABS = ['modules', 'people', 'admins', 'documents', 'history'] as const;

export default async function HrWorkspacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; q?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? sp.tab! : 'modules';
  const w = await load<HrWorkspaceDetail>(`/hr-workspaces/${id}`);
  const qs = new URLSearchParams({ limit: '500' });
  if (sp.q) qs.set('q', sp.q.slice(0, 100));
  const [people, history, transfers, members, others, central] = await Promise.all([
    tab === 'people' ? load<{ items: HierarchyMemberRow[] }>(`/hr-workspaces/${id}/members?${qs}`) : null,
    tab === 'history' ? loadOptional<{ items: ConfigVersionRow[] }>(`/hr-workspaces/history?hrWorkspaceId=${id}&limit=200`) : null,
    tab === 'history' ? loadOptional<{ items: TransferRow[] }>(`/hr-workspaces/transfers?hrWorkspaceId=${id}`) : null,
    tab === 'admins' && w.can.manage ? loadOptional<Page<Member>>('/members?status=active&limit=200') : null,
    tab === 'people' && w.can.transfer ? loadOptional<{ items: HrWorkspaceSummary[] }>('/hr-workspaces?status=active') : null,
    tab === 'people' && w.can.transfer ? loadOptional<{ items: HierarchyMemberRow[] }>('/hr-workspaces/central/members?limit=500') : null,
  ]);
  const documents = tab === 'documents' ? await documentsPanel(id, w.name) : null;
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/hr-workspaces" className="hover:underline">HR Workspaces</Link>}
        title={w.name}
        description={`${HR_WORKSPACE_KIND_LABEL[w.kind]}${w.code ? ` · ${w.code}` : ''}${w.description ? ` · ${w.description}` : ''}`}
      />
      <WorkspaceDetail
        w={w}
        tab={tab}
        query={sp.q ?? ''}
        people={people?.items ?? null}
        history={history?.items ?? null}
        transfers={transfers?.items ?? null}
        members={(members?.items ?? []).map((m) => ({ id: m.id, name: m.fullName, email: m.email }))}
        others={(others?.items ?? []).filter((o) => o.id !== id).map((o) => ({ id: o.id, name: o.name }))}
        central={central?.items ?? null}
        documents={documents}
      />
    </>
  );
}

/** The HR Workspace's own documents (registrations, policies, compliance) and the requests sent to it. */
async function documentsPanel(id: string, name: string) {
  const [data, mine] = await Promise.all([
    loadOptional<{ documents: DocRow[]; requests: RequestRow[] }>(`/hr-workspaces/${id}/documents`),
    loadOptional<MyDocAccess>('/documents/access/mine'),
  ]);
  if (!data) return <Card><EmptyState title="Documents are not available" description="Super Workspace has not given your HR Workspace access to these documents." /></Card>;
  const mayRequest = mine?.level === 'super_workspace' || (mine?.level === 'hr_workspace' && !!mine.access?.request_other_hr && !mine.hrWorkspaces.some((h) => h.id === id));
  const [catalogue, targets] = mayRequest ? await Promise.all([loadOptional<Catalogue>('/documents/catalogue'), loadOptional<Targets>('/document-requests/targets')]) : [null, null];
  const admins = targets?.hrWorkspaces.find((h) => h.id === id)?.admins ?? [];
  const open = data.requests.filter((r) => !['completed', 'cancelled'].includes(r.status));
  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader title="Requests to this HR Workspace" description="Documents asked of this HR Workspace, with the deadline and where each stands."
          action={catalogue && targets?.hrWorkspaces.some((h) => h.id === id) ? <RequestDocumentButton catalogue={catalogue} targets={targets} preset={{ target: 'hr_workspace', hrWorkspaceId: id, hrWorkspaceName: name, admins }} /> : undefined} />
        <RequestTable rows={open} empty="Nothing is open. Use Request document to ask this HR Workspace for a registration, policy or report." />
      </Card>
      <Card>
        <CardHeader title="HR Workspace documents" description="Documents this HR Workspace submitted or keeps, with their status and history." />
        <DocumentTable rows={data.documents} filterable empty="Documents this HR Workspace submits appear here." />
      </Card>
    </div>
  );
}

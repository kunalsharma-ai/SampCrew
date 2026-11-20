import { HR_WORKSPACE_KIND_LABEL, type ConfigVersionRow, type HierarchyMemberRow, type HrWorkspaceDetail, type HrWorkspaceSummary, type TransferRow } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { Member, Page } from '@/lib/types';
import { WorkspaceDetail } from './workspace-detail';

export const metadata: Metadata = { title: 'HR Workspace' };

const TABS = ['modules', 'people', 'admins', 'history'] as const;

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
      />
    </>
  );
}

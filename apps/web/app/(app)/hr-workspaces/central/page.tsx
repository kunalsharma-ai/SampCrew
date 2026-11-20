import type { HierarchyMemberRow, HrWorkspaceSummary } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { CentralView } from './central-view';

export const metadata: Metadata = { title: 'Central group' };

export default async function CentralGroupPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const qs = new URLSearchParams({ limit: '500' });
  if (sp.q) qs.set('q', sp.q.slice(0, 100));
  const [rows, spaces] = await Promise.all([
    load<{ items: HierarchyMemberRow[] }>(`/hr-workspaces/central/members?${qs}`),
    loadOptional<{ items: HrWorkspaceSummary[] }>('/hr-workspaces?status=active'),
  ]);
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/hr-workspaces" className="hover:underline">HR Workspaces</Link>}
        title="Central group"
        description="Employees the company runs itself, outside any HR Workspace. Everyone who was here before HR Workspaces existed stays here until you move them."
      />
      <CentralView rows={rows.items} query={sp.q ?? ''} spaces={(spaces?.items ?? []).map((w) => ({ id: w.id, name: w.name }))} canTransfer={can(me, 'employees:transfer')} />
    </>
  );
}

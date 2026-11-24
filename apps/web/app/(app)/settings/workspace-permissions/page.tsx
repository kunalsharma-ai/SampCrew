import { PageHeader } from '@crew/ui';
import type { WorkspacePermissionsView } from '@crew/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { PermissionsEditor } from './permissions-editor';

export const metadata: Metadata = { title: 'Workspace Permissions' };

/**
 * Settings > Workspace Permissions. The Super Workspace decides, per HR Workspace and for all Employee Workspaces,
 * what each may do, by category, with templates. An HR Workspace sees its own switches read-only. The API enforces
 * every switch on every request, so nothing here is only cosmetic.
 */
export default async function WorkspacePermissionsPage({ searchParams }: { searchParams: Promise<{ level?: string; groupId?: string }> }) {
  const sp = await searchParams;
  const level = sp.level === 'employee' ? 'employee' : 'hr';
  const [me, view] = await Promise.all([
    load<Me>('/me'),
    load<WorkspacePermissionsView>(`/workspace-permissions?${new URLSearchParams({ level, ...(sp.groupId ? { groupId: sp.groupId } : {}) })}`),
  ]);
  return (
    <>
      <PageHeader
        eyebrow={<Link href="/settings" className="hover:underline">Settings</Link>}
        title="Workspace Permissions"
        description="Choose what each HR Workspace and the Employee Workspaces may do. A workspace never gets more than its parent allows: a module switched off above stays off here, whatever the switch says."
      />
      <PermissionsEditor key={`${view.level}:${view.groupId}:${view.updatedAt ?? ''}`} view={view} canEdit={can(me, 'hierarchy:manage')} />
    </>
  );
}

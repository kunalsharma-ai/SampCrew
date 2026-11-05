import { PLATFORM_ROLE_CAPABILITIES, type WorkspaceUserRow } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { WorkspaceTabs } from '@/components/neon';
import { UsersView } from '@/components/users-view';
import { load } from '@/lib/api';
import type { Admin, TenantDetail } from '@/lib/types';

export const metadata: Metadata = { title: 'Workspace users' };
const PAGE_SIZE = 50;

export default async function TenantUsersPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; status?: string; page?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const q = (sp.q ?? '').slice(0, 100);
  const status = ['active', 'invited', 'suspended'].includes(sp.status ?? '') ? sp.status! : '';
  const page = Math.max(1, Number(sp.page) || 1);
  const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String((page - 1) * PAGE_SIZE), ...(q ? { q } : {}), ...(status ? { status } : {}) });
  const [me, t, data] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<{ items: WorkspaceUserRow[]; total: number; summary: Record<string, number> }>(`/platform/tenants/${id}/users?${qs}`),
  ]);
  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/tenants" className="hover:underline">Workspaces</Link> / <Link href={`/tenants/${id}`} className="hover:underline">{t.name}</Link></>}
        title="Users"
        description="Everyone this workspace's admins have added, with their roles, sign-ins and open sessions. Sign people out, suspend or reactivate them, reset two-step verification or resend an invitation; each action needs a reason and is recorded in both audit trails."
      />
      <WorkspaceTabs tenantId={id} current="users" caps={[...(PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])]} />
      <UsersView data={data} query={{ q, status, page }} basePath={`/tenants/${id}/users`} showWorkspace={false} pageSize={PAGE_SIZE} />
    </>
  );
}

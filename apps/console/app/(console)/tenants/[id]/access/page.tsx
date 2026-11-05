import { PLATFORM_ROLE_CAPABILITIES, type MemberAccessRow, type WorkspaceAccess } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { WorkspaceTabs } from '@/components/neon';
import { hasCap } from '@/lib/caps';
import type { Admin, TenantDetail } from '@/lib/types';
import { AccessView, type AccessTab } from './access-view';

export const metadata: Metadata = { title: 'Features & permissions' };

const PAGE_SIZE = 25;

export default async function AccessPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; q?: string; page?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tab: AccessTab = sp.tab === 'permissions' || sp.tab === 'people' || sp.tab === 'apps' ? sp.tab : 'modules';
  const [me, t, access] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<WorkspaceAccess>(`/platform/tenants/${id}/access`),
  ]);
  const canManage = hasCap(me, 'access:manage');
  const page = Math.max(1, Number(sp.page) || 1);
  const q = (sp.q ?? '').slice(0, 100);
  const members = tab === 'people' && canManage
    ? await load<{ items: MemberAccessRow[]; total: number }>(`/platform/tenants/${id}/access/members?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}${q ? `&q=${encodeURIComponent(q)}` : ''}`)
    : null;
  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/tenants" className="hover:underline">Workspaces</Link> / <Link href={`/tenants/${id}`} className="hover:underline">{t.name}</Link></>}
        title="Features & permissions"
        description="Switch CREW modules, the Web Portal and the mobile app, and permissions active or inactive for this workspace, and choose which modules each person may use. The API enforces every switch, and the web and mobile apps hide what is off."
      />
      <WorkspaceTabs tenantId={id} current="access" caps={[...(PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])]} />
      <AccessView tenantId={id} tab={tab} access={access} members={members} page={page} pageSize={PAGE_SIZE} q={q} canManage={canManage} />
    </>
  );
}

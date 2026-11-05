import { PLATFORM_ROLE_CAPABILITIES } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { DevicesTable, IntegrationsPanel, type ConsoleDevice, type ConsoleIntegration } from '@/components/devices-view';
import { WorkspaceTabs } from '@/components/neon';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin, TenantDetail } from '@/lib/types';

export const metadata: Metadata = { title: 'Workspace attendance machines' };

export default async function TenantDevicesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, t, data] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<{ items: ConsoleDevice[]; integrations: ConsoleIntegration[] }>(`/platform/tenants/${id}/devices`),
  ]);
  const canManage = hasCap(me, 'access:manage');
  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/tenants" className="hover:underline">Workspaces</Link> / <Link href={`/tenants/${id}`} className="hover:underline">{t.name}</Link></>}
        title="Attendance machines"
        description="The machine integrations this workspace may use, and every machine its admins have connected."
      />
      <WorkspaceTabs tenantId={id} current="devices" caps={[...(PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])]} />
      <div className="grid gap-6">
        <IntegrationsPanel tenantId={id} integrations={data.integrations} canManage={canManage} />
        <DevicesTable devices={data.items} showWorkspace={false} canManage={canManage} />
      </div>
    </>
  );
}

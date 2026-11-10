import { PLATFORM_ROLE_CAPABILITIES } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { WorkspaceTabs } from '@/components/neon';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin, TenantDetail } from '@/lib/types';
import { TenantBillingView, type TenantBilling } from './tenant-billing-view';

export const metadata: Metadata = { title: 'Workspace billing' };

export default async function TenantBillingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, t, billing] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<TenantBilling>(`/platform/billing/tenants/${id}`),
  ]);
  return (
    <>
      <PageHeader
        eyebrow={<><Link href="/tenants" className="hover:underline">Workspaces</Link> / <Link href={`/tenants/${id}`} className="hover:underline">{t.name}</Link></>}
        title="Billing"
        description="This workspace's subscription, contract terms, add-ons, usage, invoices and online payments. Record a bank transfer, issue an invoice by hand or lift the read-only lock."
      />
      <WorkspaceTabs tenantId={id} current="billing" caps={[...(PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])]} />
      <TenantBillingView tenantId={id} b={billing} canManage={hasCap(me, 'billing:manage')} />
    </>
  );
}

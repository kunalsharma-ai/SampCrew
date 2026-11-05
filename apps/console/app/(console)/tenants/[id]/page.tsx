import { PLATFORM_ROLE_CAPABILITIES } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { api, ApiError, load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import { WorkspaceTabs } from '@/components/neon';
import type { Admin, HistoryRow, PlanSummary, TenantDetail } from '@/lib/types';
import { TenantView, type SupportSnapshot } from './tenant-view';

export const metadata: Metadata = { title: 'Workspace' };

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, t, plans] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<PlanSummary[]>('/platform/plans').catch(() => []),
  ]);
  const history = hasCap(me, 'billing:read') ? await load<HistoryRow[]>(`/platform/tenants/${id}/subscription/history`) : [];
  // The support snapshot exists only while the customer has an approved, unexpired grant for this admin.
  const hasActiveGrant = t.supportAccess.some((g) => g.status === 'approved' && g.expiresAt && new Date(g.expiresAt) > new Date());
  let snapshot: SupportSnapshot | null = null;
  if (hasActiveGrant && hasCap(me, 'support:request')) {
    snapshot = await api<SupportSnapshot>(`/platform/tenants/${id}/support-view`).catch((e) => (e instanceof ApiError ? null : Promise.reject(e)));
  }
  return (
    <>
      <PageHeader eyebrow={<Link href="/tenants" className="hover:underline">Workspaces</Link>} title={t.name} description={`${t.slug} · ${t.region} · ${t.countryCode} · created ${new Date(t.createdAt).toLocaleDateString()}`} />
      <WorkspaceTabs tenantId={id} current="overview" caps={[...(PLATFORM_ROLE_CAPABILITIES[me.role] ?? [])]} />
      <TenantView
        t={t}
        plans={plans}
        history={history}
        snapshot={snapshot}
        caps={{ manage: hasCap(me, 'tenants:manage'), billing: hasCap(me, 'billing:manage'), support: hasCap(me, 'support:request') }}
      />
    </>
  );
}

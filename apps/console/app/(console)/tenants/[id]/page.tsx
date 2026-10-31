import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { api, ApiError, load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin, TenantDetail } from '@/lib/types';
import { TenantView, type SupportSnapshot } from './tenant-view';

export const metadata: Metadata = { title: 'Tenant' };

export default async function TenantPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, t, plans] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<TenantDetail>(`/platform/tenants/${id}`),
    load<{ key: string; name: string; features: { key: string; limitValue: number | null }[] }[]>('/platform/plans').catch(() => []),
  ]);
  // The support snapshot exists only while the customer has an approved, unexpired grant for this admin.
  const hasActiveGrant = t.supportAccess.some((g) => g.status === 'approved' && g.expiresAt && new Date(g.expiresAt) > new Date());
  let snapshot: SupportSnapshot | null = null;
  if (hasActiveGrant && hasCap(me, 'support:request')) {
    snapshot = await api<SupportSnapshot>(`/platform/tenants/${id}/support-view`).catch((e) => (e instanceof ApiError ? null : Promise.reject(e)));
  }
  return (
    <>
      <PageHeader eyebrow={<Link href="/tenants" className="hover:underline">Tenants</Link>} title={t.name} description={`${t.slug} · ${t.region} · ${t.countryCode} · created ${new Date(t.createdAt).toLocaleDateString()}`} />
      <TenantView
        t={t}
        plans={plans.map((p) => ({ key: p.key, name: p.name }))}
        snapshot={snapshot}
        caps={{ manage: hasCap(me, 'tenants:manage'), billing: hasCap(me, 'billing:manage'), support: hasCap(me, 'support:request') }}
      />
    </>
  );
}

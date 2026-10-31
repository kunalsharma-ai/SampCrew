import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin, Page, TenantRow } from '@/lib/types';
import { TenantsView } from './tenants-view';

export const metadata: Metadata = { title: 'Tenants' };

export default async function TenantsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ limit: '50' });
  if (sp.q) qs.set('q', sp.q);
  if (sp.status && ['active', 'suspended', 'closed'].includes(sp.status)) qs.set('status', sp.status);
  if (sp.cursor) qs.set('cursor', sp.cursor);
  const [me, page] = await Promise.all([load<Admin>('/platform/auth/me'), load<Page<TenantRow>>(`/platform/tenants?${qs}`)]);
  return (
    <>
      <PageHeader title="Tenants" description="Customer workspaces. Opening a tenant shows account details only; its HR data needs an approved support request." />
      <TenantsView page={page} query={{ q: sp.q ?? '', status: sp.status ?? '' }} canCreate={hasCap(me, 'tenants:manage')} />
    </>
  );
}

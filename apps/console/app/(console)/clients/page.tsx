import { CLIENT_INDUSTRIES, CLIENT_SIZES, CLIENT_STATUSES, type ClientRow } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { ClientsView, type ClientFilters } from './clients-view';

export const metadata: Metadata = { title: 'Clients' };

const KEYS = ['q', 'status', 'plan', 'industry', 'size', 'paid', 'createdFrom', 'createdTo', 'renewalWithinDays', 'sort', 'dir', 'offset', 'demo'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every client company: one row per company, however many Super Workspaces it holds. Filters live in the address. */
export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const f: ClientFilters = {};
  for (const k of KEYS) if (sp[k]) f[k] = String(sp[k]).slice(0, 120);
  if (f.status && !(CLIENT_STATUSES as readonly string[]).includes(f.status)) delete f.status;
  if (f.industry && !(CLIENT_INDUSTRIES as readonly string[]).includes(f.industry)) delete f.industry;
  if (f.size && !(CLIENT_SIZES as readonly string[]).includes(f.size)) delete f.size;
  if (f.paid && !['paid', 'free', 'enterprise'].includes(f.paid)) delete f.paid;
  if (f.sort && !['name', 'created', 'revenue', 'users', 'renewal', 'activity'].includes(f.sort)) delete f.sort;
  if (f.dir && !['asc', 'desc'].includes(f.dir)) delete f.dir;
  if (f.demo && !['include', 'exclude', 'only'].includes(f.demo)) delete f.demo;
  for (const k of ['createdFrom', 'createdTo'] as const) if (f[k] && !DATE.test(f[k]!)) delete f[k];
  for (const k of ['renewalWithinDays', 'offset'] as const) if (f[k] && !/^\d{1,7}$/.test(f[k]!)) delete f[k];
  const qs = new URLSearchParams({ ...f, limit: '25' } as Record<string, string>);
  const [me, data] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<{ items: ClientRow[]; total: number; counts: Record<string, number>; plans: { key: string; name: string }[] }>(`/platform/clients?${qs}`),
  ]);
  const canManage = hasCap(me, 'tenants:manage');
  const managers = canManage ? await load<{ id: string; name: string }[]>('/platform/clients/managers').catch(() => []) : [];
  return (
    <>
      <PageHeader
        title="Clients"
        description="Every client company with its Super Workspaces, plan, people and payments. Statuses are worked out from their workspaces and subscriptions."
        actions={canManage ? <Link href="/clients/new" data-testid="new-client" className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"><Plus className="size-4" aria-hidden />New company</Link> : undefined}
      />
      <ClientsView data={data} filters={f} canManage={canManage} canExport={hasCap(me, 'reports:export')} money={hasCap(me, 'billing:read')} managers={managers} />
    </>
  );
}

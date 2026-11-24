import { ModuleNotices } from '@/components/module-notices';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { AssetList, Category } from './types';
import { InventoryView } from './inventory-view';

export const metadata: Metadata = { title: 'Assets' };

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ status?: string; categoryId?: string; q?: string }> }) {
  const sp = await searchParams;
  const params = new URLSearchParams(Object.entries({ status: sp.status, categoryId: sp.categoryId, q: sp.q }).filter((e): e is [string, string] => Boolean(e[1])));
  const [list, categories, me] = await Promise.all([load<AssetList>(`/assets?${params}`), load<Category[]>('/assets/categories'), load<Me>('/me')]);
  return (
    <>
      <PageHeader title="Assets" description="Company property and who holds it: laptops, phones, SIM and ID cards and everything else, from purchase to retirement." />
      <ModuleNotices category="assets" label="Asset" />
      <InventoryView list={list} categories={categories} filters={{ status: sp.status ?? '', categoryId: sp.categoryId ?? '', q: sp.q ?? '' }} currency={me.tenant.currency}
        canManage={Boolean(me.permissions['assets:manage'])} />
    </>
  );
}

import { MASTER_LISTS, type MasterList, type MasterListSummary, type MasterValue } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { MasterDataView } from './master-data-view';

export const metadata: Metadata = { title: 'Master data' };

export default async function MasterDataPage({ searchParams }: { searchParams: Promise<{ list?: string; q?: string; category?: string; disabled?: string }> }) {
  const sp = await searchParams;
  const list: MasterList = (MASTER_LISTS as readonly string[]).includes(sp.list ?? '') ? (sp.list as MasterList) : 'industry';
  const disabled = sp.disabled === 'true' || sp.disabled === 'all' ? sp.disabled : 'false';
  const qs = new URLSearchParams({ disabled });
  if (sp.q) qs.set('q', sp.q);
  if (sp.category) qs.set('category', sp.category);
  const [lists, values] = await Promise.all([
    load<MasterListSummary[]>('/master-data'),
    load<{ list: MasterListSummary; categories: string[]; items: MasterValue[] }>(`/master-data/${list}?${qs}`),
  ]);
  return (
    <>
      <PageHeader title="Master data" description="The ready-made choices behind SampCrew’s dropdowns, so people pick instead of type. Add your own values, rename and group them, or disable the ones you do not use: a value in use is disabled, never deleted." />
      <MasterDataView lists={lists} list={list} data={values} q={sp.q ?? ''} category={sp.category ?? ''} disabled={disabled} />
    </>
  );
}

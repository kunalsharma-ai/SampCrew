import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { MyAsset } from '../types';
import { MineView } from './mine-view';

export const metadata: Metadata = { title: 'My assets' };

export default async function MyAssetsPage() {
  const mine = await load<{ employeeName: string | null; items: MyAsset[] }>('/assets/mine');
  return (
    <>
      <PageHeader title="My assets" description="Company property assigned to you. Acknowledge each new item so there is a record that you received it." />
      <MineView employeeName={mine.employeeName} items={mine.items} />
    </>
  );
}

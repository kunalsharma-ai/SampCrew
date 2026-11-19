import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import type { Agency } from '../types';
import { AgenciesView } from './agencies-view';

export const metadata: Metadata = { title: 'Verification agencies' };

export default async function AgenciesPage() {
  const [agencies, me] = await Promise.all([load<Agency[]>('/bgv/agencies'), load<Me>('/me')]);
  return (
    <>
      <PageHeader title="Verification agencies" description="Outside agencies that run background checks for you. A case assigned to one sends it a private link to the shared files and a findings form." />
      <AgenciesView agencies={agencies} canManage={Boolean(me.permissions['bgv:manage'])} />
    </>
  );
}

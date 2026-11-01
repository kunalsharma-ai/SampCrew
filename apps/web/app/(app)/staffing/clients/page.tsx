import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import type { Client } from '../types';
import { ClientsView } from './clients-view';

export const metadata: Metadata = { title: 'Clients' };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const sp = await searchParams;
  const archived = sp.archived === 'true';
  const [me, clients] = await Promise.all([load<Me>('/me'), load<Client[]>(`/staffing/clients${archived ? '?archived=true' : ''}`)]);
  return (
    <>
      <PageHeader title="Clients" description="The companies you make staffing bids to. Archiving a client keeps their bids and history." />
      <ClientsView clients={clients} archived={archived} canManage={can(me, 'bids:manage')} />
    </>
  );
}

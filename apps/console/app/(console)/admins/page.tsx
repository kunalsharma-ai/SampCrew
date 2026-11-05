import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { AdminsView, type AdminRow } from './admins-view';

export const metadata: Metadata = { title: 'Console admins' };

export default async function AdminsPage() {
  const rows = await load<AdminRow[]>('/platform/admins');
  return (
    <>
      <PageHeader title="Console admins" description="SAMPLEDGE staff with console access. Everyone must use two-step verification; roles limit what each person can do." />
      <AdminsView rows={rows} />
    </>
  );
}

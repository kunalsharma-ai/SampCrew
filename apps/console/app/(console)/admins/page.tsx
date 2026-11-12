import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Admin } from '@/lib/types';
import { AdminsView, type AdminRow } from './admins-view';

export const metadata: Metadata = { title: 'Console admins' };

export default async function AdminsPage() {
  const [rows, me] = await Promise.all([load<AdminRow[]>('/platform/admins'), load<Admin>('/platform/auth/me')]);
  return (
    <>
      <PageHeader title="Console admins" description="SAMPLEDGE staff with console access. Everyone must use two-step verification; roles limit what each person can do." />
      <AdminsView rows={rows} meId={me.id} />
    </>
  );
}

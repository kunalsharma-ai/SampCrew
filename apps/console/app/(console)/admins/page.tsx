import type { ConsoleRole } from '@crew/contracts';
import { buttonClass, PageHeader } from '@crew/ui';
import Link from 'next/link';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Admin } from '@/lib/types';
import { AdminsView, type AdminRow } from './admins-view';

export const metadata: Metadata = { title: 'Console admins' };

export default async function AdminsPage() {
  const [rows, me, roles] = await Promise.all([load<AdminRow[]>('/platform/admins'), load<Admin>('/platform/auth/me'), load<ConsoleRole[]>('/platform/roles')]);
  return (
    <>
      <PageHeader title="Console admins" description="SAMPLEDGE staff with console access. Everyone must use two-step verification; roles limit what each person can do." actions={<Link href="/roles" className={buttonClass('secondary', 'sm')}>Roles and permissions</Link>} />
      <AdminsView rows={rows} meId={me.id} roles={roles} />
    </>
  );
}

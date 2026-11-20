import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import type { Me, Role } from '@/lib/types';
import { RolesView } from './roles-view';

export const metadata: Metadata = { title: 'Workspace access levels' };

export default async function RolesPage() {
  const [me, roles] = await Promise.all([load<Me>('/me'), load<Role[]>('/roles')]);
  return (
    <>
      <PageHeader title="Workspace access levels" description="What Super Workspace, HR Workspace and Employee Workspace may do, and at which scope: the person themself, their team, their department, their legal entity, or the whole company. Designations and departments never give access." />
      <RolesView roles={roles} disabledPermissions={me.disabledPermissions ?? []} />
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me, Role } from '@/lib/types';
import { RolesView } from './roles-view';

export const metadata: Metadata = { title: 'Roles & permissions' };

export default async function RolesPage() {
  const [me, roles] = await Promise.all([load<Me>('/me'), load<Role[]>('/roles')]);
  return (
    <>
      <PageHeader title="Roles & permissions" description="Each permission is granted at a scope: the person themself, their team, their department, their legal entity, or the whole organization." />
      <RolesView roles={roles} canManage={can(me, 'roles:manage')} customRolesInPlan={me.features.includes('custom_roles')} />
    </>
  );
}

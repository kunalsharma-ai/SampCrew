import type { ConsoleRole } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';
import { RolesView } from './roles-view';

export const metadata: Metadata = { title: 'Roles & permissions' };

/** Console roles and what each may do. The API checks the same permissions on every request. */
export default async function RolesPage() {
  const [me, roles] = await Promise.all([load<Admin>('/platform/auth/me'), load<ConsoleRole[]>('/platform/roles')]);
  return (
    <>
      <PageHeader title="Roles & permissions" description="What each Console role may see and do. A change applies on each admin's next click; the API enforces the same permissions, so hiding a menu entry is never the only protection." />
      <RolesView roles={roles} canManage={hasCap(me, 'roles:manage')} />
    </>
  );
}

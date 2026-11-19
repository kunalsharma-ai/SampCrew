import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Me } from '@/lib/types';
import { AdminHub } from './admin-hub';
import type { Matrix, ModuleRow } from './types';

export const metadata: Metadata = { title: 'HR Workspace Admin' };

export default async function HrAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string; role?: string }> }) {
  const sp = await searchParams;
  const [me, modules, matrix] = await Promise.all([load<Me>('/me'), loadOptional<ModuleRow[]>('/hr-admin/modules'), loadOptional<Matrix>('/hr-admin/permissions')]);
  return (
    <>
      <PageHeader title="HR Workspace Admin" description="One place to decide which modules your workspace uses, what each role may do, your custom fields, and every module's settings. Nobody gets access until an administrator grants it." />
      <AdminHub me={me} modules={modules} matrix={matrix} tab={sp.tab ?? 'modules'} roleId={sp.role} />
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Me } from '@/lib/types';
import { AdminHub } from './admin-hub';
import type { FeatureLevelRow } from '@crew/contracts';
import type { Matrix, ModuleRow } from './types';

export const metadata: Metadata = { title: 'Super Workspace Admin' };

export default async function HrAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string; role?: string }> }) {
  const sp = await searchParams;
  const [me, modules, matrix, features] = await Promise.all([load<Me>('/me'), loadOptional<ModuleRow[]>('/hr-admin/modules'), loadOptional<Matrix>('/hr-admin/permissions'), loadOptional<{ items: FeatureLevelRow[] }>('/hr-admin/features')]);
  return (
    <>
      <PageHeader title="Super Workspace Admin" description="One place to decide which modules and pages your company, its HR Workspace level and its Employee Workspace level get, what each access level may do, and every module's settings." />
      <AdminHub me={me} modules={modules} matrix={matrix} features={features?.items ?? null} tab={sp.tab ?? (features ? 'features' : 'modules')} roleId={sp.role} />
    </>
  );
}

import type { EmployeeFeatureRow, EmployeeFeatureScope } from '@crew/contracts';
import { EmptyState, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { loadOptional } from '@/lib/api';
import { EmployeeFeaturesView } from './employee-features-view';

export const metadata: Metadata = { title: 'Employee features' };

export default async function EmployeeFeaturesPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const sp = await searchParams;
  const scope = sp.scope && /^(central|[0-9a-f-]{36})$/.test(sp.scope) ? sp.scope : 'central';
  const data = await loadOptional<{ scopes: EmployeeFeatureScope[]; scope: EmployeeFeatureScope | null; items: EmployeeFeatureRow[] }>(`/hr-workspaces/employee-features?scope=${scope}`);
  return (
    <>
      <PageHeader
        eyebrow="HR Workspace"
        title="Employee features"
        description="Choose which modules and pages Employee Workspace people get, for the central group or for each HR Workspace you run. You can only work with what the Super Workspace left on; the rest shows as Restricted."
      />
      {data?.scope ? <EmployeeFeaturesView key={data.scope.id} scopes={data.scopes} scope={data.scope} rows={data.items} /> : <EmptyState title="Nothing to manage here" description="You do not run the central group or any HR Workspace." />}
    </>
  );
}

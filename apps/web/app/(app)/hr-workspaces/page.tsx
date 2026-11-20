import type { HierarchyOverview } from '@crew/contracts';
import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Department, Location, Me, Member, Page } from '@/lib/types';
import { WorkspacesView } from './workspaces-view';

export const metadata: Metadata = { title: 'HR Workspaces' };

/**
 * The Super Workspace's map of the company: the central group it runs itself and each HR Workspace (a department,
 * branch or region) with the modules it was given, its admins and its people. An HR Workspace admin sees only theirs.
 */
export default async function HrWorkspacesPage({ searchParams }: { searchParams: Promise<{ create?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  const overview = await load<HierarchyOverview>('/hr-workspaces/overview');
  const manage = can(me, 'hierarchy:manage') && overview.levels.super;
  const [members, departments, locations] = await Promise.all([
    manage ? loadOptional<Page<Member>>('/members?status=active&limit=200') : null,
    manage ? loadOptional<Department[]>('/org/departments') : null,
    manage ? loadOptional<Location[]>('/org/locations') : null,
  ]);
  return (
    <>
      <PageHeader
        eyebrow={manage ? 'Super Workspace' : 'HR Workspace'}
        title="HR Workspaces"
        description={manage
          ? 'Split the company into HR Workspaces, such as a branch or a department. Each one gets a part of your modules and its own admins, who look after only its people. Everyone else stays in the central group, which you run.'
          : 'The HR Workspaces you run, the modules each one holds and its people.'}
      />
      <WorkspacesView
        overview={overview}
        manage={manage}
        transfer={can(me, 'employees:transfer')}
        openCreate={sp.create === 'hr-workspace'}
        members={(members?.items ?? []).map((m) => ({ id: m.id, name: m.fullName, email: m.email }))}
        departments={(departments ?? []).map((d) => ({ id: d.id, name: d.name }))}
        locations={(locations ?? []).map((l) => ({ id: l.id, name: l.name }))}
      />
    </>
  );
}

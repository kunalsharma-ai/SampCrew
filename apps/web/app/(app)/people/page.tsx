import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Department, LegalEntity, Location, Me, Member, Page, Role } from '@/lib/types';
import { PeopleView } from './people-view';

export const metadata: Metadata = { title: 'People' };

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; cursor?: string }> }) {
  const sp = await searchParams;
  const qs = new URLSearchParams({ limit: '50' });
  if (sp.q) qs.set('q', sp.q);
  if (sp.status && ['active', 'invited', 'suspended'].includes(sp.status)) qs.set('status', sp.status);
  if (sp.cursor) qs.set('cursor', sp.cursor);
  const me = await load<Me>('/me');
  const [members, roles, departments, entities, locations] = await Promise.all([
    load<Page<Member>>(`/members?${qs}`),
    loadOptional<Role[]>('/roles'),
    loadOptional<Department[]>('/org/departments'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
  ]);
  const scope = me.permissions['users:read'];
  const scopeNote = scope === 'tenant' ? 'Everyone in the workspace.' : scope === 'entity' ? 'People in your legal entity.' : scope === 'department' ? 'People in your department.' : scope === 'team' ? 'You and the people who report to you.' : 'Only you.';
  return (
    <>
      <PageHeader title="People" description={`Workspace members and their access. Showing: ${scopeNote} Full employee records arrive with Core HR.`} />
      <PeopleView
        me={me}
        page={members}
        query={{ q: sp.q ?? '', status: sp.status ?? '' }}
        roles={roles ?? []}
        departments={departments ?? []}
        entities={entities ?? []}
        locations={locations ?? []}
        canInvite={can(me, 'users:invite')}
        canManage={can(me, 'users:manage')}
        canAssignRoles={can(me, 'roles:manage')}
      />
    </>
  );
}

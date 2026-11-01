import { FEATURES, PERMISSIONS, type MemberPreferences } from '@crew/contracts';
import { load, loadOptional } from '@/lib/api';
import { can, quickActions, workflowActions } from '@/lib/nav';
import type { Me } from '@/lib/types';
import type { Announcement, Summary } from './helpdesk/types';
import { HomeDashboard, type Dashboard } from './home-dashboard';

interface Overview { legalEntities: number; businessUnits: number; locations: number; departments: number; activeMembers: number; pendingInvites: number; countries: number }

const SCOPE_LABEL: Record<string, string> = { own: 'Yourself', team: 'Your team', department: 'Your department', entity: 'Your legal entity', tenant: 'Whole organization' };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { welcome } = await searchParams;
  const me = await load<Me>('/me');
  const selfService = me.features.includes('self_service');
  const [overview, dashboard, prefs, news, helpdesk] = await Promise.all([
    can(me, 'org:read') ? loadOptional<Overview>('/org/overview') : null,
    loadOptional<Dashboard>('/dashboard'),
    loadOptional<MemberPreferences>('/me/preferences'),
    selfService && can(me, 'announcements:read') ? loadOptional<Announcement[]>('/announcements') : null,
    selfService && can(me, 'helpdesk:use') ? loadOptional<Summary>('/helpdesk/summary') : null,
  ]);
  const isAdmin = can(me, 'org:manage') || can(me, 'users:invite');

  const steps = overview && isAdmin
    ? [
        { done: overview.legalEntities > 0, label: 'Add your legal entities', href: '/organization?tab=entities' },
        { done: overview.locations > 0, label: 'Add offices, plants or sites', href: '/organization?tab=locations' },
        { done: overview.departments > 0, label: 'Build your department structure', href: '/organization?tab=departments' },
        { done: overview.activeMembers + overview.pendingInvites > 1, label: 'Invite your HR team', href: '/people' },
        { done: me.user.mfaEnabled, label: 'Turn on two-step verification', href: '/settings/security' },
      ]
    : [];

  const access = Object.entries(me.permissions)
    .map(([key, scope]) => ({ key, def: PERMISSIONS.find((p) => p.key === key), scope }))
    .filter((x) => x.def)
    .map((x) => ({ key: x.key, description: x.def!.description, scope: SCOPE_LABEL[x.scope] ?? x.scope }));

  return (
    <HomeDashboard
      firstName={me.user.fullName.split(' ')[0] ?? me.user.fullName}
      tenantName={me.tenant.name}
      welcome={Boolean(welcome)}
      dashboard={dashboard}
      layout={prefs?.dashboard ?? null}
      notes={prefs?.notes ?? ''}
      news={news}
      helpdesk={helpdesk}
      steps={steps}
      roles={me.membership.roles.map((r) => ({ key: r.key, name: r.name }))}
      access={access}
      plan={{
        name: me.subscription?.plan ?? null,
        status: me.subscription?.status ?? null,
        included: me.features.length,
        total: FEATURES.filter((f) => f.kind === 'boolean').length,
        maxEmployees: me.limits.max_employees ?? 0,
        canView: can(me, 'billing:read'),
      }}
      actions={[...quickActions(me), ...workflowActions(me).filter((a) => a.key !== 'theme')]}
    />
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { WorkspaceView, type TenantSettings } from './workspace-view';
import { SessionPolicyCard, type SessionPolicy } from './session-policy-card';

export const metadata: Metadata = { title: 'Workspace settings' };

export default async function WorkspacePage() {
  const [me, tenant, policy] = await Promise.all([load<Me>('/me'), load<TenantSettings>('/tenant'), loadOptional<SessionPolicy>('/tenant/session-policy')]);
  return (
    <>
      <PageHeader title="Workspace settings" description="Defaults that apply across your organization. Legal entities and locations can override time zone and currency." />
      <WorkspaceView tenant={tenant} canManage={can(me, 'tenant:manage')} myMfa={me.user.mfaEnabled} />
      {policy && <div className="mt-6 max-w-3xl"><SessionPolicyCard policy={policy} /></div>}
    </>
  );
}

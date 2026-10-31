import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { WorkspaceView, type TenantSettings } from './workspace-view';

export const metadata: Metadata = { title: 'Workspace settings' };

export default async function WorkspacePage() {
  const [me, tenant] = await Promise.all([load<Me>('/me'), load<TenantSettings>('/tenant')]);
  return (
    <>
      <PageHeader title="Workspace settings" description="Defaults that apply across your organization. Legal entities and locations can override time zone and currency." />
      <WorkspaceView tenant={tenant} canManage={can(me, 'tenant:manage')} myMfa={me.user.mfaEnabled} />
    </>
  );
}

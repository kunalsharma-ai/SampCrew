import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load } from '@/lib/api';
import { can } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { SupportView, type Grant } from './support-view';

export const metadata: Metadata = { title: 'Support access' };

export default async function SupportPage() {
  const [me, grants] = await Promise.all([load<Me>('/me'), load<Grant[]>('/support-access')]);
  return (
    <>
      <PageHeader
        title="Support access"
        description="SAMPLEDGE support staff cannot see your workspace unless you approve a request. Approved access is time-limited, can be ended early, and every action they take is written to your audit trail."
      />
      <SupportView grants={grants} canManage={can(me, 'tenant:manage')} />
    </>
  );
}

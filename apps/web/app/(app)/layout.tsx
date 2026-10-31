import { DemoBanner } from '@crew/ui';
import { load, loadOptional } from '@/lib/api';
import { visibleNav } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { Shell, type Notifications } from './shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await load<Me>('/me');
  const notifications = await loadOptional<Notifications>('/notifications?limit=15');
  return (
    <>
      {me.tenant.isDemo && <DemoBanner />}
      <Shell me={me} nav={visibleNav(me)} notifications={notifications}>{children}</Shell>
    </>
  );
}

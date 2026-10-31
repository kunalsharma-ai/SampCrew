import { DemoBanner } from '@crew/ui';
import { load } from '@/lib/api';
import { visibleNav } from '@/lib/nav';
import type { Me } from '@/lib/types';
import { Shell } from './shell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await load<Me>('/me');
  return (
    <>
      {me.tenant.isDemo && <DemoBanner />}
      <Shell me={me} nav={visibleNav(me)}>{children}</Shell>
    </>
  );
}

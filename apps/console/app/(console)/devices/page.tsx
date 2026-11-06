import { PageHeader } from '@crew/ui';
import { AlertTriangle, CirclePause, Fingerprint, Wifi } from 'lucide-react';
import type { Metadata } from 'next';
import { DevicesTable, type ConsoleDevice } from '@/components/devices-view';
import { Tile, TileRow } from '@/components/neon';
import { load } from '@/lib/api';
import { hasCap } from '@/lib/caps';
import type { Admin } from '@/lib/types';

export const metadata: Metadata = { title: 'Attendance machines' };

export default async function DevicesPage() {
  const [me, data] = await Promise.all([
    load<Admin>('/platform/auth/me'),
    load<{ items: ConsoleDevice[]; counts: Record<string, number>; total: number }>('/platform/devices'),
  ]);
  const c = data.counts;
  return (
    <>
      <PageHeader title="Attendance machines" description="Every biometric, face and card machine connected to SampCrew, in every workspace, with its live status. Pause a machine to refuse what it sends." />
      <TileRow>
        <Tile tone="violet" icon={<Fingerprint className="size-5" />} label="Machines" value={data.total} testId="tile-machines" />
        <Tile tone="green" icon={<Wifi className="size-5" />} label="Online" value={c.online ?? 0} hint={`${c.delayed ?? 0} delayed · ${c.waiting ?? 0} waiting`} />
        <Tile tone="orange" icon={<AlertTriangle className="size-5" />} label="Offline or failing" value={(c.offline ?? 0) + (c.error ?? 0)} />
        <Tile tone="pink" icon={<CirclePause className="size-5" />} label="Paused by SAMPLEDGE" value={c.paused ?? 0} />
      </TileRow>
      <div className="mt-6"><DevicesTable devices={data.items} showWorkspace canManage={hasCap(me, 'access:manage')} /></div>
    </>
  );
}

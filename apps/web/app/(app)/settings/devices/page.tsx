import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Device, Location } from '@/lib/types';
import { DevicesView } from './devices-view';

export const metadata: Metadata = { title: 'Attendance devices' };

export default async function DevicesPage() {
  const [devices, locations] = await Promise.all([load<Device[]>('/attendance/devices'), loadOptional<Location[]>('/org/locations')]);
  return (
    <>
      <PageHeader
        title="Attendance devices"
        description="Biometric and card terminals that push punches to CREW. Devices send punches only: fingerprints and faces stay on the device and are never stored here."
      />
      <DevicesView devices={devices} locations={locations ?? []} />
    </>
  );
}

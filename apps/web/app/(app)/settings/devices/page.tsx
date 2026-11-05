import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Device, DeviceIntegration, Location } from '@/lib/types';
import { DevicesView } from './devices-view';

export const metadata: Metadata = { title: 'Attendance devices' };

export default async function DevicesPage() {
  const [devices, locations, integrations] = await Promise.all([
    load<Device[]>('/attendance/devices'),
    loadOptional<Location[]>('/org/locations'),
    load<DeviceIntegration[]>('/attendance/devices/integrations'),
  ]);
  return (
    <>
      <PageHeader
        title="Attendance devices"
        description="Biometric, face and card machines that send punches to CREW. Devices send punches only: fingerprints and faces stay on the device and are never stored here."
      />
      <DevicesView devices={devices} locations={locations ?? []} integrations={integrations} />
    </>
  );
}

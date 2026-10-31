import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { DeviceDetail, DeviceMapping, Employee, Location, Page } from '@/lib/types';
import { DeviceDetailView } from './device-detail-view';

export const metadata: Metadata = { title: 'Attendance device' };

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [device, mappings, employees, locations] = await Promise.all([
    load<DeviceDetail>(`/attendance/devices/${id}`),
    load<DeviceMapping[]>('/attendance/devices/mappings'),
    loadOptional<Page<Employee>>('/employees?limit=200'),
    loadOptional<Location[]>('/org/locations'),
  ]);
  return (
    <>
      <PageHeader
        title={device.name}
        description={`${device.locationName} · serial ${device.serialNumber}`}
        actions={<Link className="text-sm font-medium text-accent hover:underline" href="/settings/devices">All devices</Link>}
      />
      <DeviceDetailView
        device={device}
        mappings={mappings.filter((m) => m.deviceId === null || m.deviceId === device.id)}
        employees={(employees?.items ?? []).map((e) => ({ id: e.id, label: `${e.displayName} (${e.employeeCode})` }))}
        locations={locations ?? []}
      />
    </>
  );
}

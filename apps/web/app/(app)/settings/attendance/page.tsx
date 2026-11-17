import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { AttendancePolicy, DisciplinePolicy, Kiosk, LegalEntity, Location, PeriodLock, ShiftTemplate } from '@/lib/types';
import { AttendanceSettingsView } from './attendance-settings-view';
import { LateRulesCard } from './late-rules';

export const metadata: Metadata = { title: 'Attendance settings' };

export default async function AttendanceSettingsPage() {
  const [shifts, policies, locks, kiosks, locations, entities, discipline] = await Promise.all([
    load<ShiftTemplate[]>('/shifts/templates'),
    load<AttendancePolicy[]>('/attendance/policies'),
    load<PeriodLock[]>('/attendance/locks'),
    // Kiosks need advanced attendance (Professional plan and above); otherwise the endpoint refuses and the card explains why.
    loadOptional<Kiosk[]>('/attendance/kiosks'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    load<DisciplinePolicy>('/attendance/late/policy'),
  ]);
  return (
    <>
      <PageHeader title="Attendance settings" description="Shifts, punching rules, late-coming reminders, payroll locks and QR kiosks. Geofences are set on each location under Organization. Every change is audited." />
      <div className="grid gap-6">
        <AttendanceSettingsView shifts={shifts} policies={policies} locks={locks} kiosks={kiosks} locations={locations ?? []} entities={entities ?? []} />
        <LateRulesCard policy={discipline} />
      </div>
    </>
  );
}

import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { AttendancePolicy, DisciplinePolicy, Kiosk, LegalEntity, Location, PeriodLock, RewardRule, RewardWinners, ShiftTemplate } from '@/lib/types';
import { AttendanceSettingsView } from './attendance-settings-view';
import { LateRulesCard } from './late-rules';
import { RewardWinnersCard } from './reward-winners';
import { RewardsCard } from './rewards-card';

export const metadata: Metadata = { title: 'Attendance settings' };

/** The newest finished month, so the winners card does not offer months that have not ended. */
const lastFinishedMonth = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

export default async function AttendanceSettingsPage({ searchParams }: { searchParams: Promise<{ winners?: string }> }) {
  const sp = await searchParams;
  const winnersMonth = sp.winners && /^\d{4}-\d{2}$/.test(sp.winners) ? sp.winners : '';
  const [shifts, policies, locks, kiosks, locations, entities, discipline, rewards, leaveTypes, winners] = await Promise.all([
    load<ShiftTemplate[]>('/shifts/templates'),
    load<AttendancePolicy[]>('/attendance/policies'),
    load<PeriodLock[]>('/attendance/locks'),
    // Kiosks need advanced attendance (Professional plan and above); otherwise the endpoint refuses and the card explains why.
    loadOptional<Kiosk[]>('/attendance/kiosks'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    load<DisciplinePolicy>('/attendance/late/policy'),
    loadOptional<RewardRule[]>('/workspace/reward-rules'),
    loadOptional<{ id: string; name: string }[]>('/leave/types'),
    loadOptional<RewardWinners>(`/workspace/reward-winners${winnersMonth ? `?month=${winnersMonth}` : ''}`),
  ]);
  return (
    <>
      <PageHeader title="Attendance settings" description="Shifts, punching rules, late-coming reminders, attendance rewards, payroll locks and QR kiosks. Geofences are set on each location under Organization. Every change is audited." />
      <div className="grid gap-6">
        <AttendanceSettingsView shifts={shifts} policies={policies} locks={locks} kiosks={kiosks} locations={locations ?? []} entities={entities ?? []} />
        <LateRulesCard policy={discipline} />
        <RewardsCard rules={rewards ?? []} currency={winners?.currency ?? 'INR'} leaveTypes={(leaveTypes ?? []).map((t) => ({ leaveTypeId: t.id, name: t.name }))} />
        {winners && <RewardWinnersCard data={winners} latest={lastFinishedMonth()} />}
      </div>
    </>
  );
}

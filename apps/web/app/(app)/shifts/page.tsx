import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ApiError, api, load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import { addDays } from '@/lib/time';
import type { Department, Location, Me, Roster, ScheduleDay, SwapRequest } from '@/lib/types';
import { MySchedule, RostersCard } from './shifts-view';

export const metadata: Metadata = { title: 'Shifts' };

export default async function ShiftsPage() {
  const me = await load<Me>('/me');
  const today = new Date().toISOString().slice(0, 10);
  let schedule: { employeeId: string; days: ScheduleDay[]; swaps: SwapRequest[] } | null = null;
  try {
    schedule = await api(`/shifts/schedule?from=${today}&to=${addDays(today, 13)}`);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'no_employee_record')) throw e;
  }
  const manage = can(me, 'shifts:manage');
  const [rosters, departments, locations] = await Promise.all([
    manage ? load<Roster[]>('/shifts/rosters') : Promise.resolve(null),
    manage ? loadOptional<Department[]>('/org/departments') : Promise.resolve(null),
    manage ? loadOptional<Location[]>('/org/locations') : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader title="Shifts" description="Your planned shifts for the next two weeks, shift swaps, and rosters for the people you schedule." />
      <div className="grid gap-6">
        {schedule && <MySchedule days={schedule.days} swaps={schedule.swaps} employeeId={schedule.employeeId} />}
        {rosters && <RostersCard rosters={rosters} departments={departments ?? []} locations={locations ?? []} />}
      </div>
    </>
  );
}

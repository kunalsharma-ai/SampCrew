import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { DisciplinePolicy, HolidayCalendar, LeaveType, LegalEntity, Location, Me } from '@/lib/types';
import { LeaveSettingsView } from './leave-settings-view';
import { SameDayRuleCard } from './same-day-rule';

export const metadata: Metadata = { title: 'Holidays and leave rules' };

export default async function LeaveSettingsPage() {
  const [, types, calendars, entities, locations, discipline] = await Promise.all([
    load<Me>('/me'),
    load<LeaveType[]>('/leave/types'),
    load<HolidayCalendar[]>('/leave/calendars'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<DisciplinePolicy>('/attendance/late/policy'),
  ]);
  return (
    <>
      <PageHeader title="Holidays and leave rules" description="Holiday calendars (by legal entity or location), the same-day leave rule Leave days are never credited automatically. Every change is audited." />
      <div className="grid gap-6">
        <LeaveSettingsView calendars={calendars} entities={entities ?? []} locations={locations ?? []} />
        {discipline && <SameDayRuleCard policy={discipline} types={types} />}
      </div>
    </>
  );
}

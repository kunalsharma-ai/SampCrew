import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import { can } from '@/lib/nav';
import type { DisciplinePolicy, HolidayCalendar, LeaveType, LegalEntity, Location, Me } from '@/lib/types';
import { LeaveSettingsView } from './leave-settings-view';
import { SameDayRuleCard } from './same-day-rule';

export const metadata: Metadata = { title: 'Holidays and leave rules' };

export default async function LeaveSettingsPage() {
  const [me, types, calendars, entities, locations, discipline] = await Promise.all([
    load<Me>('/me'),
    load<LeaveType[]>('/leave/types'),
    load<HolidayCalendar[]>('/leave/calendars'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<DisciplinePolicy>('/attendance/late/policy'),
  ]);
  return (
    <>
      <PageHeader title="Holidays and leave rules" description="Holiday calendars (by legal entity or location), the same-day leave rule and, for the Super Workspace, accruals and closing a leave year. Every change is audited." />
      <div className="grid gap-6">
        <LeaveSettingsView calendars={calendars} entities={entities ?? []} locations={locations ?? []} canConfigure={can(me, 'leave:configure')} />
        {discipline && <SameDayRuleCard policy={discipline} types={types} />}
      </div>
    </>
  );
}

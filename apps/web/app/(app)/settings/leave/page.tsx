import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { DisciplinePolicy, HolidayCalendar, LeavePolicy, LeaveType, LegalEntity, Location, Role } from '@/lib/types';
import { LeaveSettingsView } from './leave-settings-view';
import { SameDayRuleCard } from './same-day-rule';

export const metadata: Metadata = { title: 'Leave settings' };

export default async function LeaveSettingsPage() {
  const [types, policies, calendars, entities, locations, chain, roles, discipline] = await Promise.all([
    load<LeaveType[]>('/leave/types'),
    load<LeavePolicy[]>('/leave/policies'),
    load<HolidayCalendar[]>('/leave/calendars'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<{ steps: { type: string; role?: string }[]; fallbackRole: string }>('/approvals/policies/leave_request'),
    loadOptional<Role[]>('/roles'),
    loadOptional<DisciplinePolicy>('/attendance/late/policy'),
  ]);
  return (
    <>
      <PageHeader title="Leave settings" description="Leave types, who gets how much, holiday calendars and the approval chain. Every change is audited." />
      <div className="grid gap-6">
        <LeaveSettingsView types={types} policies={policies} calendars={calendars} entities={entities ?? []} locations={locations ?? []} chain={chain} roles={roles ?? []} />
        {discipline && <SameDayRuleCard policy={discipline} types={types} />}
      </div>
    </>
  );
}

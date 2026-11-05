import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { HolidayCalendar, LeavePolicy, LeaveType, LegalEntity, Location, Role } from '@/lib/types';
import { LeaveSettingsView } from './leave-settings-view';

export const metadata: Metadata = { title: 'Leave settings' };

export default async function LeaveSettingsPage() {
  const [types, policies, calendars, entities, locations, chain, roles] = await Promise.all([
    load<LeaveType[]>('/leave/types'),
    load<LeavePolicy[]>('/leave/policies'),
    load<HolidayCalendar[]>('/leave/calendars'),
    loadOptional<LegalEntity[]>('/org/legal-entities'),
    loadOptional<Location[]>('/org/locations'),
    loadOptional<{ steps: { type: string; role?: string }[]; fallbackRole: string }>('/approvals/policies/leave_request'),
    loadOptional<Role[]>('/roles'),
  ]);
  return (
    <>
      <PageHeader title="Leave settings" description="Leave types, who gets how much, holiday calendars and the approval chain. Every change is audited." />
      <LeaveSettingsView types={types} policies={policies} calendars={calendars} entities={entities ?? []} locations={locations ?? []} chain={chain} roles={roles ?? []} />
    </>
  );
}

import { Alert, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError, api, load } from '@/lib/api';
import { allowed, ModuleOverview } from '@/components/module-overview';
import { can } from '@/lib/nav';
import type { AttendanceMonth, AttendanceToday, Me } from '@/lib/types';
import { MonthView, TodayCard } from './attendance-view';

export const metadata: Metadata = { title: 'Attendance' };

const monthBounds = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { from, to };
};

export default async function AttendancePage({ searchParams }: { searchParams: Promise<{ month?: string; employeeId?: string }> }) {
  const sp = await searchParams;
  const me = await load<Me>('/me');
  let today: AttendanceToday | null = null;
  try {
    today = sp.employeeId ? null : await api<AttendanceToday>('/attendance/today');
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'no_employee_record')) return load<never>('/attendance/today');
    return (
      <>
        <PageHeader title="Attendance" />
        <Alert tone="info" title="No employee record linked">Your login is not linked to an employee record yet, so there is no attendance to show. Ask HR to link it from your employee profile.</Alert>
      </>
    );
  }
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : (today?.date ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
  const { from, to } = monthBounds(month);
  const data = await load<AttendanceMonth>(`/attendance/days?from=${from}&to=${to}${sp.employeeId ? `&employeeId=${sp.employeeId}` : ''}`);
  const own = !sp.employeeId;
  return (
    <>
      <PageHeader
        title={own ? 'Attendance' : `Attendance: ${data.employee.name}`}
        description={own ? 'Punch in and out, see how each day was counted, and ask for corrections.' : `${data.employee.code}. Times are shown in ${data.employee.timeZone}.`}
        actions={can(me, 'attendance:approve') && <Link className="text-sm font-medium text-accent hover:underline" href="/attendance/team">Team attendance</Link>}
      />
      {own && <ModuleOverview module="attendance" actions={allowed(me, [
        { label: 'Team attendance', href: '/attendance/team', icon: 'users-round', permission: 'attendance:approve' },
        { label: 'Missing punches', href: '/attendance/team?status=missing_punch', icon: 'clock', permission: 'attendance:approve' },
        { label: 'Shifts', href: '/shifts', icon: 'calendar-clock', permission: 'shifts:read', feature: 'shift_scheduling' },
        { label: 'Attendance settings', href: '/settings/attendance', icon: 'timer', permission: 'attendance:configure' },
        { label: 'Devices', href: '/settings/devices', icon: 'fingerprint', permission: 'devices:manage', feature: 'attendance_advanced' },
      ])} />}
      <div className="grid gap-6">
        {today && <TodayCard today={today} />}
        <MonthView data={data} month={month} own={own} canClaimFor={!own && can(me, 'attendance:correct')} />
      </div>
    </>
  );
}

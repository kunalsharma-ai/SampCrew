/** Display helpers for attendance. Times are shown in the employee's own time zone, not the viewer's. */

export function clock(iso: string | null | undefined, timeZone: string) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

export function hm(minutes: number | null | undefined) {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function dayLabel(date: string) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
}

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const STATUS_LABEL: Record<string, string> = {
  present: 'Present', half_day: 'Half day', absent: 'Absent', missing_punch: 'Missing punch', on_leave: 'On leave', half_day_leave: 'Half-day leave',
  holiday: 'Holiday', weekly_off: 'Weekly off', in_progress: 'In progress', not_joined: 'Not employed',
};

export const SOURCE_LABEL: Record<string, string> = { web: 'Web', mobile: 'Mobile app', qr: 'QR kiosk', device: 'Device', import: 'Import', correction: 'Approved correction' };

/** Checks the server records on punches sent from the mobile app, so a reviewer can see why a punch may need a look. */
export const RISK_FLAG_LABEL: Record<string, string> = {
  offline: 'Sent after being offline',
  clock_changed: "Phone clock didn't match",
  clock_unverified: 'Time from the phone clock',
  mock_location: 'Mock location reported',
};

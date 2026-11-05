export const caseStatus: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_on_employee: 'Waiting for you',
  resolved: 'Resolved',
  closed: 'Closed',
};
/** How a handler sees the same statuses. */
export const caseStatusHandler: Record<string, string> = { ...caseStatus, waiting_on_employee: 'Waiting on employee' };

export const moveLabel: Record<string, string> = {
  in_progress: 'Start working',
  waiting_on_employee: 'Ask the employee',
  resolved: 'Resolve',
  closed: 'Confirm it is solved',
  open: 'Reopen',
};

export const target: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' }> = {
  none: { label: 'No target', tone: 'neutral' },
  on_time: { label: 'On time', tone: 'ok' },
  due_soon: { label: 'Due soon', tone: 'warn' },
  overdue: { label: 'Overdue', tone: 'danger' },
  met: { label: 'Met', tone: 'ok' },
  missed: { label: 'Missed', tone: 'danger' },
};

export const leaveStatus: Record<string, { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'info' }> = {
  pending: { label: 'Waiting for approval', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const dayStatus: Record<string, string> = {
  present: 'Present',
  absent: 'Absent',
  half_day: 'Half day',
  on_leave: 'On leave',
  holiday: 'Holiday',
  weekly_off: 'Weekly off',
  incomplete: 'Incomplete',
  not_started: 'Not started',
  in_progress: 'In progress',
};

export const riskFlag: Record<string, string> = {
  offline: 'Sent after being offline',
  clock_changed: "Phone clock didn't match",
  clock_unverified: 'Time from phone clock',
  mock_location: 'Mock location reported',
};

export const syncReason: Record<string, string> = {
  too_old: 'Too old to send',
  in_future: 'Time is in the future',
  outside_geofence: 'Outside your workplace',
  location_required: 'Location needed',
  mobile_off: 'Mobile punching is off',
  not_started: 'Employment not started',
  employment_ended: 'Employment ended',
  refused: 'Refused',
};

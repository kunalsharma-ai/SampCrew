import type { Tone } from '@crew/ui';
import type { Announcement, TargetState } from './types';

export const STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting_on_employee: 'Waiting on employee', resolved: 'Resolved', closed: 'Closed' };
/** The same statuses as the person who asked sees them. */
export const STATUS_MINE: Record<string, string> = { ...STATUS, waiting_on_employee: 'Waiting for you' };
export const STATUS_TONE: Record<string, Tone> = { open: 'info', in_progress: 'accent', waiting_on_employee: 'warning', resolved: 'success', closed: 'neutral' };
export const PRIORITY: Record<string, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const PRIORITY_TONE: Record<string, Tone> = { low: 'neutral', normal: 'neutral', high: 'warning', urgent: 'danger' };
export const TARGET: Record<TargetState, string> = { none: 'No target', on_time: 'On time', due_soon: 'Due soon', overdue: 'Overdue', met: 'Met', missed: 'Missed' };
export const TARGET_TONE: Record<TargetState, Tone> = { none: 'neutral', on_time: 'success', due_soon: 'warning', overdue: 'danger', met: 'success', missed: 'danger' };
export const MOVE: Record<string, string> = { in_progress: 'Start working', waiting_on_employee: 'Ask the employee', resolved: 'Resolve', closed: 'Confirm it is solved', open: 'Reopen' };
export const HISTORY: Record<string, string> = {
  created: 'raised the case', status: 'changed the status', assigned: 'assigned it', priority: 'changed the priority', category: 'moved it to another category',
  rated: 'rated the help', auto_closed: 'closed it automatically',
};
export const dateTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const hours = (h: number | null) => (h === null ? 'No target' : h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hours`);

export function audienceLabel(a: Pick<Announcement, 'legalEntityName' | 'departmentName' | 'locationName'>) {
  const parts = [a.legalEntityName, a.departmentName && `${a.departmentName} (and sub-departments)`, a.locationName].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Everyone';
}

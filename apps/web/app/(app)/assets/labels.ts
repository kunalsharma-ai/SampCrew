import type { Tone } from '@crew/ui';

export const STATUS_TONE: Record<string, Tone> = { available: 'success', assigned: 'info', under_maintenance: 'warning', damaged: 'danger', lost: 'danger', retired: 'neutral' };
export const day = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
export const dateTime = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export const today = () => new Date().toISOString().slice(0, 10);
export const EVENT_LABEL: Record<string, string> = {
  registered: 'Registered', file_added: 'File attached', updated: 'Details changed', assigned: 'Assigned', returned: 'Returned', acknowledged: 'Acknowledged by the employee',
  maintenance_started: 'Sent for maintenance', maintenance_finished: 'Back in service', retired: 'Retired', written_off_lost: 'Written off as lost', written_off_damaged: 'Written off as damaged', status_changed: 'Status changed', file_uploaded: 'File attached', file_removed: 'File removed',
};

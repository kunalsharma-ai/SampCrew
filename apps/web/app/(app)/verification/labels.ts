import type { Tone } from '@crew/ui';

export const STATUS_TONE: Record<string, Tone> = {
  pending: 'neutral', in_progress: 'info', verified: 'success', failed: 'danger', on_hold: 'warning', cancelled: 'neutral',
};

export const day = (s: string | null | undefined) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
export const dateTime = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export const EVENT_LABEL: Record<string, string> = {
  created: 'Case started', check_added: 'Check added', check_status: 'Check status changed', check_updated: 'Check details changed', status_changed: 'Case status changed',
  remark: 'Remark added', decided: 'Result recorded', file_shared: 'File shared with the agency', file_unshared: 'File no longer shared', cancelled: 'Case cancelled', file_uploaded: 'File uploaded', file_removed: 'File removed', sent_to_agency: 'Sent to the agency',
  link_revoked: 'Agency link switched off', agency_feedback: 'Agency feedback', agency_submitted: 'Agency sent its findings', agency_report: 'Agency uploaded a report',
  agency_downloaded: 'Agency downloaded a file', updated: 'Case details changed',
};

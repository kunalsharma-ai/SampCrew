import type { Tone } from '@crew/ui';
import type { RunStatus, WorkflowStatus } from './types';

export const WORKFLOW_STATUS: Record<WorkflowStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Not active', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'info' },
  waiting: { label: 'Waiting', tone: 'info' },
  succeeded: { label: 'Finished', tone: 'success' },
  stopped: { label: 'Stopped by a step', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const STEP_STATUS: Record<string, { label: string; tone: Tone }> = {
  succeeded: { label: 'Done', tone: 'success' },
  stopped: { label: 'Stopped here', tone: 'neutral' },
  waiting: { label: 'Waiting', tone: 'info' },
  failed: { label: 'Failed', tone: 'danger' },
  simulated: { label: 'Simulated', tone: 'ember' },
};

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');

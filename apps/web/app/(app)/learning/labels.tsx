import { DIFFICULTY_LABEL, FORMAT_LABEL, LEARNER_STATUS_LABEL, MODULE_STATUS_LABEL, SUBMISSION_STATUS_LABEL, type LearnerStatus, type LearningDifficulty, type ModuleFormat, type ModuleStatus, type SubmissionStatus } from '@crew/contracts';
import { Badge, type Tone } from '@crew/ui';
import type { Creator } from './types';

export const minutesLabel = (m: number | null | undefined) => (!m ? null : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
export const formatLabel = (f: string) => FORMAT_LABEL[f as ModuleFormat] ?? f;
export const difficultyLabel = (d: string, custom?: string | null) => (d === 'custom' && custom ? custom : DIFFICULTY_LABEL[d as LearningDifficulty] ?? d);
export const creatorLabel = (c: Creator) => [c.name, c.designation, c.workspace].filter(Boolean).join(' · ');
export const dateLabel = (iso: string | null | undefined) => (iso ? new Date(iso.length === 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const scoreLabel = (s: number | null | undefined) => (s === null || s === undefined ? '' : `${s}%`);

const MODULE_TONE: Record<ModuleStatus, Tone> = { draft: 'neutral', scheduled: 'info', published: 'success', archived: 'warning' };
export function ModuleStatusBadge({ status, changes }: { status: ModuleStatus; changes?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={MODULE_TONE[status]} dot>{MODULE_STATUS_LABEL[status]}</Badge>
      {changes && <Badge tone="info">Unpublished changes</Badge>}
    </span>
  );
}

const LEARNER_TONE: Record<LearnerStatus, Tone> = { not_started: 'neutral', in_progress: 'info', completed: 'success', overdue: 'danger', cancelled: 'neutral' };
export function LearnerStatusBadge({ status }: { status: LearnerStatus }) {
  return <Badge tone={LEARNER_TONE[status]} dot>{LEARNER_STATUS_LABEL[status]}</Badge>;
}

const SUB_TONE: Record<SubmissionStatus, Tone> = { submitted: 'info', approved: 'success', rejected: 'danger', resubmit: 'warning' };
export function SubmissionBadge({ status }: { status: SubmissionStatus }) {
  return <Badge tone={SUB_TONE[status]} dot>{SUBMISSION_STATUS_LABEL[status]}</Badge>;
}

export function DueLabel({ dueOn, due }: { dueOn: string | null; due: { state: string; daysLeft: number | null } }) {
  if (!dueOn) return <span className="text-fg-subtle">No deadline</span>;
  if (due.state === 'overdue') return <span className="font-medium text-danger">Overdue since {dateLabel(dueOn)}</span>;
  if (due.state === 'due_soon') return <span className="font-medium text-warning">{due.daysLeft === 0 ? 'Due today' : `Due in ${due.daysLeft} day${due.daysLeft === 1 ? '' : 's'}`}</span>;
  if (due.state === 'none') return <span className="text-fg-muted">Was due {dateLabel(dueOn)}</span>;
  return <span className="text-fg-muted">Due {dateLabel(dueOn)}</span>;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <div className="flex items-center gap-2" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-bg-subtle">
        <span className="block h-full rounded-full bg-accent transition-[width] motion-reduce:transition-none" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </span>
      <span className="w-10 text-right text-xs tabular-nums text-fg-muted">{value}%</span>
    </div>
  );
}

/** The cover of a module: its uploaded image, or a calm placeholder with the format. */
export function Cover({ fileId, title, className = '' }: { fileId: string | null; title: string; className?: string }) {
  if (fileId) return <img src={`/learning-files/${fileId}`} alt="" className={`aspect-[16/9] w-full rounded-lg object-cover ${className}`} />;
  return (
    <div aria-hidden className={`grid aspect-[16/9] w-full place-items-center rounded-lg bg-gradient-to-br from-accent/25 via-bg-subtle to-accent/5 text-2xl font-semibold text-accent ${className}`}>
      {title.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
    </div>
  );
}

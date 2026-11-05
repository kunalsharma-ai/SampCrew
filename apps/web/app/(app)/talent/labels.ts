type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'accent';

export const GOAL_STATUS: Record<string, string> = { active: 'Active', completed: 'Completed', cancelled: 'Cancelled' };
export const GOAL_TONE: Record<string, Tone> = { active: 'info', completed: 'success', cancelled: 'neutral' };
export const CONFIDENCE: Record<string, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };
export const CONFIDENCE_TONE: Record<string, Tone> = { on_track: 'success', at_risk: 'warning', off_track: 'danger' };

export const CYCLE_STATUS: Record<string, string> = { draft: 'Draft', active: 'Writing reviews', calibration: 'Calibration', released: 'Released' };
export const CYCLE_TONE: Record<string, Tone> = { draft: 'neutral', active: 'info', calibration: 'warning', released: 'success' };
export const PART_STATUS: Record<string, string> = { pending: 'Not submitted', submitted: 'Submitted', not_required: 'Not needed' };
export const FEEDBACK_STATUS: Record<string, string> = { requested: 'Requested', submitted: 'Submitted', declined: 'Declined', withdrawn: 'Withdrawn' };
export const FEEDBACK_TONE: Record<string, Tone> = { requested: 'warning', submitted: 'success', declined: 'neutral', withdrawn: 'neutral' };

export const FORMAT: Record<string, string> = { online: 'Online course', video: 'Video', document: 'Reading', classroom: 'Classroom' };
export const ASSIGNMENT_STATUS: Record<string, string> = { assigned: 'Not started', in_progress: 'In progress', completed: 'Completed', cancelled: 'Removed' };
export const ASSIGNMENT_TONE: Record<string, Tone> = { assigned: 'neutral', in_progress: 'info', completed: 'success', cancelled: 'neutral' };

export const SURVEY_STATUS: Record<string, string> = { draft: 'Draft', open: 'Open', closed: 'Closed' };
export const SURVEY_TONE: Record<string, Tone> = { draft: 'neutral', open: 'success', closed: 'neutral' };
export const QUESTION_KIND: Record<string, string> = { scale: 'Agreement, 1 to 5', enps: 'Recommend, 0 to 10 (eNPS)', text: 'Comment' };
export const SCALE_LABELS = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];

export const minutes = (m: number | null) => (m == null ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
export const dateTime = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const dateOnly = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
export const ratingLabel = (scale: { value: number; label: string }[], v: number | null | undefined) =>
  v == null ? '–' : `${v} · ${scale.find((l) => l.value === v)?.label ?? ''}`;
/** "12.00" -> "12", "12.50" -> "12.5" */
export const num = (v: string) => v.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');

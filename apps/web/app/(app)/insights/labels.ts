import type { Tone } from '@crew/ui';
import type { Band, ReviewOutcome } from './types';

export const BAND: Record<Band, { label: string; tone: Tone }> = {
  high: { label: 'High', tone: 'danger' },
  medium: { label: 'Medium', tone: 'warning' },
  low: { label: 'Low', tone: 'neutral' },
};

export const OUTCOME: Record<ReviewOutcome, string> = {
  action_planned: 'Action planned',
  no_action: 'Reviewed, no action',
  not_accurate: 'Score not accurate',
};

/** Plain-English rules, matching ATTRITION_RULES in @crew/contracts. */
export const RULE_TEXT: Record<string, string> = {
  earlyTenure: 'In their first year',
  stalled: 'Three or more years in the job without a promotion or move',
  leaveSpike: 'Unplanned leave in the last 90 days at least doubled, and 4 days or more',
  attendance: 'Late or absent 3 or more days in the last 30',
  lowRating: 'Last released rating in the bottom 40% of the scale',
  noRecognition: 'No recognition in 180 days (after 6 months in the job)',
  payQueries: 'Two or more pay questions to HR in 90 days',
};

export const INPUT_TEXT: Record<string, string> = {
  tenureMonths: 'Months since joining',
  monthsSinceJobChange: 'Months since last job change',
  unplannedLeaveRecent: 'Unplanned leave, last 90 days',
  unplannedLeavePrior: 'Unplanned leave, 90 days before',
  lateOrAbsentDays30: 'Late or absent days, last 30',
  lastRatingShare: 'Last rating (share of top of scale)',
  recognitions180: 'Recognitions, last 180 days',
  payQueries90: 'Pay questions, last 90 days',
};

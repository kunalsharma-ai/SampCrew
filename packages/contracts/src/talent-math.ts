/**
 * Pure calculations for Phase 6 (goals, reviews, surveys). No I/O, so they are unit tested exhaustively and the API,
 * web and mobile apps all show the same numbers.
 *
 * Rules:
 * - **Key result progress** is how far the current value has moved from the start value towards the target, as a
 *   percentage clamped to 0..100. Targets below the start (for example "reduce defects from 40 to 10") work the same
 *   way. Progress is rounded to one decimal.
 * - **Goal progress** is the average of its key results. A goal without key results uses the progress its owner
 *   reports in check-ins.
 * - **Anonymity threshold (k):** survey results are shown only when at least k people responded. In a breakdown,
 *   groups smaller than k are merged into "Other groups". If that merged group is still smaller than k (and not
 *   empty), the whole breakdown is withheld, because the hidden group could be worked out by subtracting the visible
 *   groups from the total.
 * - **eNPS** is the percentage of promoters (9 or 10) minus the percentage of detractors (0 to 6), rounded to a whole
 *   number, from -100 to 100.
 */

const round1 = (n: number) => Math.round(n * 10) / 10;

export function keyResultProgress(start: number | string, target: number | string, current: number | string): number {
  const s = Number(start);
  const t = Number(target);
  const c = Number(current);
  if (![s, t, c].every(Number.isFinite) || s === t) return c === t ? 100 : 0;
  const p = ((c - s) / (t - s)) * 100;
  return round1(Math.min(100, Math.max(0, p)));
}

export function goalProgress(keyResults: { start: number | string; target: number | string; current: number | string }[], reported = 0): number {
  if (!keyResults.length) return round1(Math.min(100, Math.max(0, Number(reported) || 0)));
  const sum = keyResults.reduce((a, k) => a + keyResultProgress(k.start, k.target, k.current), 0);
  return round1(sum / keyResults.length);
}

/** Weighted progress across goals; goals without a weight count equally when no goal has a weight. */
export function weightedProgress(goals: { progress: number; weight: number }[]): number {
  if (!goals.length) return 0;
  const total = goals.reduce((a, g) => a + g.weight, 0);
  if (total <= 0) return round1(goals.reduce((a, g) => a + g.progress, 0) / goals.length);
  return round1(goals.reduce((a, g) => a + g.progress * g.weight, 0) / total);
}

export interface RatingLevel {
  value: number;
  label: string;
}

export const DEFAULT_RATING_SCALE: RatingLevel[] = [
  { value: 1, label: 'Below expectations' },
  { value: 2, label: 'Partly meets expectations' },
  { value: 3, label: 'Meets expectations' },
  { value: 4, label: 'Exceeds expectations' },
  { value: 5, label: 'Outstanding' },
];

/** Count of ratings per level, in scale order, plus people without a rating. */
export function ratingDistribution(ratings: (number | null | undefined)[], scale: RatingLevel[]) {
  const levels = scale.map((l) => ({ ...l, count: ratings.filter((r) => r === l.value).length }));
  const total = ratings.length;
  return {
    levels: levels.map((l) => ({ ...l, percent: total ? round1((l.count / total) * 100) : 0 })),
    unrated: ratings.filter((r) => r == null).length,
    total,
  };
}

// Surveys ----------------------------------------------------------------------------------------------------

export interface AnonGroup {
  key: string;
  label: string;
  count: number;
}

export type AnonBreakdown =
  | { shown: true; groups: AnonGroup[]; merged: { keys: string[]; count: number } | null }
  | { shown: false; reason: string };

/** Applies the anonymity threshold to a breakdown (see the rules at the top of this file). */
export function anonymousBreakdown(groups: AnonGroup[], k: number): AnonBreakdown {
  const total = groups.reduce((a, g) => a + g.count, 0);
  if (total < k) return { shown: false, reason: `Fewer than ${k} responses` };
  const visible = groups.filter((g) => g.count >= k);
  const hidden = groups.filter((g) => g.count > 0 && g.count < k);
  const hiddenCount = hidden.reduce((a, g) => a + g.count, 0);
  if (hiddenCount > 0 && hiddenCount < k) {
    return { shown: false, reason: `Some groups have fewer than ${k} responses, and together they still have fewer than ${k}` };
  }
  return { shown: true, groups: visible, merged: hidden.length ? { keys: hidden.map((g) => g.key), count: hiddenCount } : null };
}

export const SURVEY_QUESTION_KINDS = ['scale', 'enps', 'text'] as const;
export type SurveyQuestionKind = (typeof SURVEY_QUESTION_KINDS)[number];
export interface SurveyQuestion {
  id: string;
  kind: SurveyQuestionKind;
  text: string;
}
export type SurveyAnswers = Record<string, number | string | null | undefined>;

export function enps(scores: number[]): number | null {
  if (!scores.length) return null;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return Math.round(((promoters - detractors) / scores.length) * 100);
}

export interface QuestionSummary {
  id: string;
  kind: SurveyQuestionKind;
  text: string;
  answered: number;
  /** scale: 1..5; enps: 0..10. */
  average?: number | null;
  distribution?: { value: number; count: number }[];
  enps?: number | null;
  /** Free-text answers, in a stable order that does not follow submission order. */
  comments?: string[];
}

/** Summarises responses. Callers must check the threshold first; this function does not withhold anything. */
export function summariseSurvey(questions: SurveyQuestion[], responses: SurveyAnswers[]): QuestionSummary[] {
  return questions.map((q) => {
    const raw = responses.map((r) => r[q.id]).filter((v) => v !== null && v !== undefined && v !== '');
    if (q.kind === 'text') {
      const comments = raw.map((v) => String(v).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
      return { id: q.id, kind: q.kind, text: q.text, answered: comments.length, comments };
    }
    const nums = raw.map(Number).filter((n) => Number.isInteger(n));
    const [lo, hi] = q.kind === 'enps' ? [0, 10] : [1, 5];
    const distribution: { value: number; count: number }[] = [];
    for (let v = lo; v <= hi; v++) distribution.push({ value: v, count: nums.filter((n) => n === v).length });
    const average = nums.length ? Math.round((nums.reduce((a, n) => a + n, 0) / nums.length) * 100) / 100 : null;
    return { id: q.id, kind: q.kind, text: q.text, answered: nums.length, average, distribution, ...(q.kind === 'enps' ? { enps: enps(nums) } : {}) };
  });
}

/** Checks one person's answers against the questions. Returns an error message, or null when valid. */
export function validateSurveyAnswers(questions: SurveyQuestion[], answers: SurveyAnswers): string | null {
  const ids = new Set(questions.map((q) => q.id));
  for (const key of Object.keys(answers)) if (!ids.has(key)) return 'An answer does not match any question';
  for (const q of questions) {
    const v = answers[q.id];
    if (v === undefined || v === null || v === '') {
      if (q.kind !== 'text') return `Answer "${q.text}"`;
      continue;
    }
    if (q.kind === 'text') {
      if (typeof v !== 'string' || v.length > 2000) return 'Comments can be up to 2,000 characters';
      continue;
    }
    const [lo, hi] = q.kind === 'enps' ? [0, 10] : [1, 5];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) return `Answer "${q.text}" with a score from ${lo} to ${hi}`;
  }
  return null;
}

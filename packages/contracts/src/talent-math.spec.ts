import { describe, expect, it } from 'vitest';
import {
  anonymousBreakdown,
  DEFAULT_RATING_SCALE,
  enps,
  goalProgress,
  keyResultProgress,
  ratingDistribution,
  summariseSurvey,
  validateSurveyAnswers,
  weightedProgress,
} from './talent-math';

describe('goal progress', () => {
  it('measures movement from start to target and clamps to 0..100', () => {
    expect(keyResultProgress(0, 200, 50)).toBe(25);
    expect(keyResultProgress('10', '20', '13.33')).toBe(33.3);
    expect(keyResultProgress(0, 100, 150)).toBe(100);
    expect(keyResultProgress(0, 100, -5)).toBe(0);
  });

  it('handles targets below the start ("reduce defects from 40 to 10")', () => {
    expect(keyResultProgress(40, 10, 25)).toBe(50);
    expect(keyResultProgress(40, 10, 45)).toBe(0);
    expect(keyResultProgress(40, 10, 5)).toBe(100);
  });

  it('averages key results, or uses reported progress without key results', () => {
    expect(goalProgress([{ start: 0, target: 10, current: 10 }, { start: 0, target: 4, current: 1 }])).toBe(62.5);
    expect(goalProgress([], 40)).toBe(40);
    expect(goalProgress([], 140)).toBe(100);
  });

  it('weights goals, and counts them equally when no weights are set', () => {
    expect(weightedProgress([{ progress: 100, weight: 30 }, { progress: 0, weight: 70 }])).toBe(30);
    expect(weightedProgress([{ progress: 100, weight: 0 }, { progress: 50, weight: 0 }])).toBe(75);
    expect(weightedProgress([])).toBe(0);
  });
});

describe('ratings', () => {
  it('counts each level and the unrated', () => {
    const d = ratingDistribution([3, 3, 4, null, 5, 1], DEFAULT_RATING_SCALE);
    expect(d.levels.map((l) => l.count)).toEqual([1, 0, 2, 1, 1]);
    expect(d.unrated).toBe(1);
    expect(d.levels[2]!.percent).toBe(33.3);
  });
});

describe('survey anonymity', () => {
  const g = (key: string, count: number) => ({ key, label: key, count });

  it('withholds everything below the threshold', () => {
    expect(anonymousBreakdown([g('a', 2), g('b', 2)], 5)).toEqual({ shown: false, reason: 'Fewer than 5 responses' });
  });

  it('merges small groups when together they reach the threshold', () => {
    const r = anonymousBreakdown([g('ops', 9), g('qa', 3), g('hr', 2)], 5);
    expect(r).toEqual({ shown: true, groups: [g('ops', 9)], merged: { keys: ['qa', 'hr'], count: 5 } });
  });

  it('withholds the breakdown when one small group could be worked out by subtraction', () => {
    const r = anonymousBreakdown([g('ops', 9), g('eng', 6), g('hr', 2)], 5);
    expect(r.shown).toBe(false);
  });

  it('shows every group when all reach the threshold, ignoring empty ones', () => {
    expect(anonymousBreakdown([g('ops', 5), g('eng', 7), g('hr', 0)], 5)).toEqual({ shown: true, groups: [g('ops', 5), g('eng', 7)], merged: null });
  });
});

describe('survey results', () => {
  const questions = [
    { id: 'q1', kind: 'scale' as const, text: 'I have what I need to do my job' },
    { id: 'q2', kind: 'enps' as const, text: 'How likely are you to recommend working here?' },
    { id: 'q3', kind: 'text' as const, text: 'Anything else?' },
  ];

  it('computes eNPS from promoters and detractors', () => {
    expect(enps([10, 9, 8, 7, 6, 0])).toBe(0);
    expect(enps([10, 10, 9, 3])).toBe(50);
    expect(enps([])).toBeNull();
  });

  it('summarises scores and sorts comments so their order does not follow submission order', () => {
    const s = summariseSurvey(questions, [
      { q1: 4, q2: 10, q3: 'Zebra crossings at the gate' },
      { q1: 2, q2: 6 },
      { q1: 5, q2: 9, q3: 'Better canteen' },
    ]);
    expect(s[0]!.average).toBe(3.67);
    expect(s[0]!.distribution!.find((d) => d.value === 2)!.count).toBe(1);
    expect(s[1]!.enps).toBe(33);
    expect(s[2]!.comments).toEqual(['Better canteen', 'Zebra crossings at the gate']);
    expect(s[2]!.answered).toBe(2);
  });

  it('validates answers', () => {
    expect(validateSurveyAnswers(questions, { q1: 3, q2: 7 })).toBeNull();
    expect(validateSurveyAnswers(questions, { q1: 3 })).toMatch(/recommend/);
    expect(validateSurveyAnswers(questions, { q1: 6, q2: 7 })).toMatch(/1 to 5/);
    expect(validateSurveyAnswers(questions, { q1: 3, q2: 11 })).toMatch(/0 to 10/);
    expect(validateSurveyAnswers(questions, { q1: 3, q2: 7, q9: 1 })).toMatch(/does not match/);
    expect(validateSurveyAnswers(questions, { q1: 3.5, q2: 7 })).toMatch(/1 to 5/);
  });
});

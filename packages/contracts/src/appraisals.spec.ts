import { describe, expect, it } from 'vitest';
import { appraisalDefinition, bandFor, completion, computeAppraisal, FREQUENT_RESEARCH_TEMPLATE, missingAnswers, sectionsFor, weightedPercent, type AppraisalDefinition } from './appraisals';

const fr = FREQUENT_RESEARCH_TEMPLATE;
const rated = (d: AppraisalDefinition, isManager: boolean) => sectionsFor(d, isManager).filter((s) => s.kind === 'rated').flatMap((s) => s.questions);
const all = (d: AppraisalDefinition, isManager: boolean, score: number) => Object.fromEntries(rated(d, isManager).map((q) => [q.id, { score }]));

describe('appraisal maths', () => {
  it('the Frequent Research template is a valid form', () => {
    expect(appraisalDefinition.safeParse(fr).success).toBe(true);
    // Management Skills applies to managers only: 20 rated questions for others, 25 for managers.
    expect(rated(fr, false)).toHaveLength(20);
    expect(rated(fr, true)).toHaveLength(25);
  });

  it('question percentage is score / max x 100 and the overall is weighted by question', () => {
    const qs = [{ id: 'a', text: 'A', kind: 'score' as const, weight: 1, required: true, active: true }, { id: 'b', text: 'B', kind: 'score' as const, weight: 3, required: true, active: true }];
    // (4/5*100*1 + 2/5*100*3) / 4 = (80 + 120) / 4 = 50
    expect(weightedPercent(qs, { a: 4, b: 2 }, 5)).toBe(50);
    // Unanswered questions do not count against the person.
    expect(weightedPercent(qs, { a: 5, b: null }, 5)).toBe(100);
    expect(weightedPercent(qs, {}, 5)).toBeNull();
  });

  it("does not treat the employee's self-score as the final score", () => {
    const r = computeAppraisal(fr, false, { employee: all(fr, false, 5), manager: all(fr, false, 3), hr: {}, finalScores: {}, finalPercent: null });
    expect(r.selfPercent).toBe(100);
    expect(r.managerPercent).toBe(60);
    expect(r.finalPercent).toBe(60);
    expect(r.band).toBe('Meets Some Expectations');
  });

  it('HR can override a question, or the final percentage', () => {
    const base = { employee: all(fr, false, 5), manager: all(fr, false, 4), hr: {} };
    const q = rated(fr, false)[0]!.id;
    const r = computeAppraisal(fr, false, { ...base, finalScores: { [q]: 5 }, finalPercent: null });
    // 19 questions at 80% and one at 100%: 81%.
    expect(r.finalPercent).toBe(81);
    expect(r.band).toBe('Good Performance');
    const o = computeAppraisal(fr, false, { ...base, finalScores: {}, finalPercent: 96 });
    expect(o.calculatedPercent).toBe(80);
    expect(o.finalPercent).toBe(96);
    expect(o.band).toBe('Outstanding Performance');
  });

  it('a combined method weights the manager and HR scores as configured', () => {
    const d: AppraisalDefinition = { ...fr, scoring: { method: 'combined', hrScores: true, weights: { employee: 0, manager: 60, hr: 40 } } };
    const r = computeAppraisal(d, false, { employee: all(d, false, 1), manager: all(d, false, 5), hr: all(d, false, 2.5 as never), finalScores: {}, finalPercent: null });
    // 5*0.6 + 2.5*0.4 = 4 -> 80%
    expect(r.finalPercent).toBe(80);
    expect(r.hrPercent).toBe(50);
  });

  it('bands use the highest band reached', () => {
    const b = fr.bands;
    expect(bandFor(b, 49.9)).toBe('Needs Improvement');
    expect(bandFor(b, 50)).toBe('Meets Some Expectations');
    expect(bandFor(b, 84.9)).toBe('Good Performance');
    expect(bandFor(b, 85)).toBe('Very Good Performance');
    expect(bandFor(b, 100)).toBe('Outstanding Performance');
    expect(bandFor(b, null)).toBeNull();
  });

  it('lists what each role still has to answer and how complete the self-appraisal is', () => {
    expect(missingAnswers(fr, false, 'employee', {})).toHaveLength(23);
    expect(completion(fr, false, 'employee', {})).toBe(0);
    const answers = { ...all(fr, false, 3), 'self-questions-1': { text: 'Shipped X' }, 'self-questions-2': { text: 'Led Y' }, 'self-questions-3': { text: 'Grow Z' } };
    expect(missingAnswers(fr, false, 'employee', answers)).toEqual([]);
    expect(completion(fr, false, 'employee', answers)).toBe(100);
    // The manager answers the rated questions and their own feedback section, not the employee's.
    expect(missingAnswers(fr, false, 'manager', all(fr, false, 3))).toHaveLength(6);
    // HR scores nothing unless the form asks for HR scores.
    expect(missingAnswers(fr, false, 'hr', {})).toHaveLength(5);
  });

  it('refuses forms that cannot be scored or have duplicate ids or bands', () => {
    const bad = (patch: Partial<AppraisalDefinition>) => appraisalDefinition.safeParse({ ...fr, ...patch }).success;
    expect(bad({ bands: [{ min: 10, label: 'X' }] })).toBe(false);
    expect(bad({ bands: [{ min: 0, label: 'X' }, { min: 0, label: 'Y' }] })).toBe(false);
    expect(bad({ sections: [fr.sections[7]!] })).toBe(false);
    expect(bad({ sections: [fr.sections[0]!, fr.sections[0]!] })).toBe(false);
  });
});

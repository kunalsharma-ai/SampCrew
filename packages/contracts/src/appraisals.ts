import { z } from 'zod';

/**
 * Appraisals: forms HR builds (sections, questions, weights, scale, bands, how the final score is worked out), cycles
 * that hand a form to people, and the three-stage workflow: employee self-appraisal, reporting manager evaluation, HR
 * review and finalisation. The maths lives here so the API, the web and the tests share it.
 */

export const APPRAISAL_STAGES = ['self', 'manager', 'hr', 'finalized', 'published'] as const;
export type AppraisalStage = (typeof APPRAISAL_STAGES)[number];
export const APPRAISAL_STAGE_LABELS: Record<AppraisalStage, string> = {
  self: 'Self-appraisal', manager: 'Manager evaluation', hr: 'HR review', finalized: 'Finalised', published: 'Published',
};

/** score: a rating on the form's scale; long_text / short_text: a written answer. */
export const QUESTION_KINDS = ['score', 'long_text', 'short_text'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/**
 * Who answers a section: rated sections are scored by the employee, the manager and (when configured) HR;
 * self sections are written by the employee; manager and hr sections are written by the manager or HR.
 */
export const SECTION_KINDS = ['rated', 'self', 'manager', 'hr'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

/** all: everyone; managers: only people with direct reports (for example Management Skills); non_managers: the rest. */
export const SECTION_AUDIENCES = ['all', 'managers', 'non_managers'] as const;
export type SectionAudience = (typeof SECTION_AUDIENCES)[number];

/**
 * How each question's final score is decided.
 *  manager: the manager's score (HR can override a question's final score).
 *  hr: HR's score, or the manager's where HR gave none.
 *  combined: a weighted average of the scores given, using `weights` (employee weight 0 by default).
 */
export const FINAL_METHODS = ['manager', 'hr', 'combined'] as const;
export type FinalMethod = (typeof FINAL_METHODS)[number];

const id = z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Use lower-case letters, digits, - or _');
const text = (max: number) => z.string().trim().max(max);

export const ratingLevel = z.object({ from: z.number().int().min(0).max(100), to: z.number().int().min(0).max(100), label: text(80).min(1), description: text(1000).default('') });
export const appraisalQuestion = z.object({
  id,
  text: text(500).min(1),
  kind: z.enum(QUESTION_KINDS).default('score'),
  weight: z.number().min(0).max(100).default(1),
  required: z.boolean().default(true),
  active: z.boolean().default(true),
});
export const appraisalSection = z.object({
  id,
  title: text(160).min(1),
  description: text(1000).default(''),
  kind: z.enum(SECTION_KINDS).default('rated'),
  audience: z.enum(SECTION_AUDIENCES).default('all'),
  active: z.boolean().default(true),
  questions: z.array(appraisalQuestion).min(1).max(40),
});
export const appraisalBand = z.object({ min: z.number().min(0).max(100), label: text(80).min(1) });

export const appraisalDefinition = z
  .object({
    title: text(200).min(1),
    intro: text(4000).default(''),
    scale: z.object({ min: z.number().int().min(0).max(1), max: z.number().int().min(2).max(10), levels: z.array(ratingLevel).max(10).default([]) }),
    sections: z.array(appraisalSection).min(1).max(30),
    scoring: z.object({
      method: z.enum(FINAL_METHODS).default('manager'),
      hrScores: z.boolean().default(false),
      weights: z.object({ employee: z.number().min(0).max(100), manager: z.number().min(0).max(100), hr: z.number().min(0).max(100) }).default({ employee: 0, manager: 100, hr: 0 }),
    }),
    /** Performance categories by final percentage: each band starts at `min`; the highest band reached applies. */
    bands: z.array(appraisalBand).min(1).max(12),
    declaration: text(2000).default(''),
  })
  .superRefine((d, ctx) => {
    const sectionIds = new Set<string>();
    const questionIds = new Set<string>();
    d.sections.forEach((s, i) => {
      if (sectionIds.has(s.id)) ctx.addIssue({ code: 'custom', path: ['sections', i, 'id'], message: 'Two sections have the same id' });
      sectionIds.add(s.id);
      s.questions.forEach((q, j) => {
        if (questionIds.has(q.id)) ctx.addIssue({ code: 'custom', path: ['sections', i, 'questions', j, 'id'], message: 'Two questions have the same id' });
        questionIds.add(q.id);
        if (s.kind === 'rated' && q.kind !== 'score') ctx.addIssue({ code: 'custom', path: ['sections', i, 'questions', j, 'kind'], message: 'Questions in a rated section are scored' });
        if (s.kind !== 'rated' && q.kind === 'score') ctx.addIssue({ code: 'custom', path: ['sections', i, 'questions', j, 'kind'], message: 'Only rated sections have scores' });
      });
    });
    if (!d.sections.some((s) => s.active && s.kind === 'rated' && s.questions.some((q) => q.active && q.weight > 0))) {
      ctx.addIssue({ code: 'custom', path: ['sections'], message: 'Add at least one active rated question with a weight above 0' });
    }
    if (d.scale.max <= d.scale.min) ctx.addIssue({ code: 'custom', path: ['scale', 'max'], message: 'The top of the scale must be above the bottom' });
    const mins = d.bands.map((b) => b.min);
    if (new Set(mins).size !== mins.length) ctx.addIssue({ code: 'custom', path: ['bands'], message: 'Two bands start at the same percentage' });
    if (!mins.includes(0)) ctx.addIssue({ code: 'custom', path: ['bands'], message: 'One band must start at 0%' });
    const w = d.scoring.weights;
    if (d.scoring.method === 'combined' && w.manager + w.hr + w.employee <= 0) ctx.addIssue({ code: 'custom', path: ['scoring', 'weights'], message: 'Give at least one score a weight' });
  });
export type AppraisalDefinition = z.infer<typeof appraisalDefinition>;
export type AppraisalSection = z.infer<typeof appraisalSection>;
export type AppraisalQuestion = z.infer<typeof appraisalQuestion>;

export const appraisalFormInput = z.object({
  name: text(160).min(1),
  description: text(1000).optional().nullable(),
  active: z.boolean().default(true),
  /** Which people this form is for when a cycle picks forms automatically. Empty lists mean anyone. */
  departmentIds: z.array(z.uuid()).max(200).default([]),
  designationIds: z.array(z.uuid()).max(200).default([]),
  audience: z.enum(SECTION_AUDIENCES).default('all'),
  isDefault: z.boolean().default(false),
  definition: appraisalDefinition,
});
export type AppraisalFormInput = z.infer<typeof appraisalFormInput>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31');
export const appraisalCycleInput = z
  .object({
    name: text(160).min(1),
    /** A form for everyone, or null to pick each person's form by the forms' department, designation and manager rules. */
    formId: z.uuid().nullable().default(null),
    periodStart: date,
    periodEnd: date,
    selfDue: date,
    managerDue: date,
    hrDue: date.optional().nullable(),
    departmentIds: z.array(z.uuid()).max(200).default([]),
    /** HR reviewers for the cycle; empty means anyone who runs appraisals (performance:configure). */
    hrReviewerMembershipIds: z.array(z.uuid()).max(50).default([]),
  })
  .superRefine((c, ctx) => {
    if (c.periodEnd < c.periodStart) ctx.addIssue({ code: 'custom', path: ['periodEnd'], message: 'The period ends before it starts' });
    if (c.managerDue < c.selfDue) ctx.addIssue({ code: 'custom', path: ['managerDue'], message: 'The manager deadline is before the self-appraisal deadline' });
    if (c.hrDue && c.hrDue < c.managerDue) ctx.addIssue({ code: 'custom', path: ['hrDue'], message: 'The HR deadline is before the manager deadline' });
  });
export type AppraisalCycleInput = z.infer<typeof appraisalCycleInput>;

const scoreValue = z.number().int().min(0).max(10).nullable();
const answer = z.object({ score: scoreValue.optional(), comment: text(4000).optional().nullable(), text: text(8000).optional().nullable() });
/** Answers by question id. Unknown questions are refused by the API. */
export const appraisalAnswersInput = z.object({ answers: z.record(z.string().max(40), answer).default({}) });
export const appraisalHrInput = appraisalAnswersInput.extend({
  /** HR's final score per question, overriding the method's result. */
  finalScores: z.record(z.string().max(40), scoreValue).default({}),
  /** The final approved percentage when HR records a different one from the calculated result (needs a reason). */
  finalPercent: z.number().min(0).max(100).nullable().default(null),
  overrideReason: text(1000).optional().nullable(),
});
export const appraisalReopenInput = z.object({ stage: z.enum(['self', 'manager', 'hr']), reason: text(1000).min(3) });

export type AnswerMap = Record<string, { score?: number | null; comment?: string | null; text?: string | null }>;

// ---------------------------------------------------------------------------------------------------------------
// Maths
// ---------------------------------------------------------------------------------------------------------------

/** The sections that apply to a person (managers get manager-only sections; inactive ones are left out). */
export function sectionsFor(d: AppraisalDefinition, isManager: boolean): AppraisalSection[] {
  return d.sections
    .filter((s) => s.active && (s.audience === 'all' || (s.audience === 'managers') === isManager))
    .map((s) => ({ ...s, questions: s.questions.filter((q) => q.active) }))
    .filter((s) => s.questions.length);
}

export function ratedQuestions(sections: AppraisalSection[]): AppraisalQuestion[] {
  return sections.filter((s) => s.kind === 'rated').flatMap((s) => s.questions.filter((q) => q.kind === 'score'));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Weighted percentage of a set of scores: sum(score / max × 100 × weight) / sum(weights of answered questions). */
export function weightedPercent(questions: AppraisalQuestion[], scores: Record<string, number | null | undefined>, max: number): number | null {
  let sum = 0;
  let weights = 0;
  for (const q of questions) {
    const v = scores[q.id];
    if (v === null || v === undefined || q.weight <= 0) continue;
    sum += (v / max) * 100 * q.weight;
    weights += q.weight;
  }
  return weights ? round1(sum / weights) : null;
}

/** A question's final score by the form's method, unless HR set one. */
export function finalScore(
  d: AppraisalDefinition,
  q: AppraisalQuestion,
  s: { employee?: number | null; manager?: number | null; hr?: number | null; override?: number | null },
): number | null {
  if (s.override !== null && s.override !== undefined) return s.override;
  const m = d.scoring.method;
  if (m === 'manager') return s.manager ?? null;
  if (m === 'hr') return s.hr ?? s.manager ?? null;
  const w = d.scoring.weights;
  const parts: [number | null | undefined, number][] = [[s.employee, w.employee], [s.manager, w.manager], [d.scoring.hrScores ? s.hr : null, w.hr]];
  let sum = 0;
  let weight = 0;
  for (const [v, k] of parts) {
    if (v === null || v === undefined || k <= 0) continue;
    sum += v * k;
    weight += k;
  }
  return weight ? round1(sum / weight) : null;
}

export function bandFor(bands: { min: number; label: string }[], percent: number | null): string | null {
  if (percent === null) return null;
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  return sorted.find((b) => percent >= b.min)?.label ?? null;
}

/** The rating level label a score falls in, e.g. 4 -> "Outstanding Performance". */
export function levelFor(d: AppraisalDefinition, score: number | null | undefined): string | null {
  if (score === null || score === undefined) return null;
  return d.scale.levels.find((l) => score >= l.from && score <= l.to)?.label ?? null;
}

export interface AppraisalResult {
  selfPercent: number | null;
  managerPercent: number | null;
  hrPercent: number | null;
  calculatedPercent: number | null;
  finalPercent: number | null;
  band: string | null;
  finals: Record<string, number | null>;
  questions: { id: string; weight: number; employee: number | null; manager: number | null; hr: number | null; final: number | null; percent: number | null }[];
}

/** Every percentage of one appraisal, from the answers given so far. */
export function computeAppraisal(
  d: AppraisalDefinition,
  isManager: boolean,
  a: { employee: AnswerMap; manager: AnswerMap; hr: AnswerMap; finalScores: Record<string, number | null>; finalPercent: number | null },
): AppraisalResult {
  const qs = ratedQuestions(sectionsFor(d, isManager));
  const pick = (m: AnswerMap) => Object.fromEntries(qs.map((q) => [q.id, m[q.id]?.score ?? null]));
  const e = pick(a.employee);
  const mg = pick(a.manager);
  const h = pick(a.hr);
  const finals: Record<string, number | null> = {};
  for (const q of qs) finals[q.id] = finalScore(d, q, { employee: e[q.id], manager: mg[q.id], hr: h[q.id], override: a.finalScores[q.id] });
  const calculated = weightedPercent(qs, finals, d.scale.max);
  const finalPercent = a.finalPercent ?? calculated;
  return {
    selfPercent: weightedPercent(qs, e, d.scale.max),
    managerPercent: weightedPercent(qs, mg, d.scale.max),
    hrPercent: d.scoring.hrScores ? weightedPercent(qs, h, d.scale.max) : null,
    calculatedPercent: calculated,
    finalPercent,
    band: bandFor(d.bands, finalPercent),
    finals,
    questions: qs.map((q) => ({ id: q.id, weight: q.weight, employee: e[q.id] ?? null, manager: mg[q.id] ?? null, hr: h[q.id] ?? null, final: finals[q.id] ?? null, percent: finals[q.id] === null || finals[q.id] === undefined ? null : round1((finals[q.id]! / d.scale.max) * 100) })),
  };
}

/** Questions a role must answer before submitting, that are still empty. */
export function missingAnswers(d: AppraisalDefinition, isManager: boolean, role: 'employee' | 'manager' | 'hr', answers: AnswerMap): string[] {
  const sections = sectionsFor(d, isManager);
  const out: string[] = [];
  for (const s of sections) {
    const mine = s.kind === 'rated' ? role !== 'hr' || d.scoring.hrScores : s.kind === (role === 'employee' ? 'self' : role);
    if (!mine) continue;
    for (const q of s.questions) {
      if (!q.required) continue;
      const v = answers[q.id];
      const empty = q.kind === 'score' ? v?.score === null || v?.score === undefined : !v?.text?.trim();
      if (empty) out.push(q.id);
    }
  }
  return out;
}

/** How much of the self-appraisal is filled in, 0 to 100. */
export function completion(d: AppraisalDefinition, isManager: boolean, role: 'employee' | 'manager' | 'hr', answers: AnswerMap): number {
  const sections = sectionsFor(d, isManager);
  let total = 0;
  for (const s of sections) {
    const mine = s.kind === 'rated' ? role !== 'hr' || d.scoring.hrScores : s.kind === (role === 'employee' ? 'self' : role);
    if (mine) total += s.questions.filter((q) => q.required).length;
  }
  if (!total) return 100;
  return Math.round(((total - missingAnswers(d, isManager, role, answers).length) / total) * 100);
}

// ---------------------------------------------------------------------------------------------------------------
// Built-in templates
// ---------------------------------------------------------------------------------------------------------------

export const DEFAULT_APPRAISAL_BANDS = [
  { min: 0, label: 'Needs Improvement' },
  { min: 50, label: 'Meets Some Expectations' },
  { min: 70, label: 'Good Performance' },
  { min: 85, label: 'Very Good Performance' },
  { min: 95, label: 'Outstanding Performance' },
];

const rated = (sid: string, title: string, items: string[], audience: SectionAudience = 'all'): AppraisalSection => ({
  id: sid, title, description: '', kind: 'rated', audience, active: true,
  questions: items.map((t, i) => ({ id: `${sid}-${i + 1}`, text: t, kind: 'score', weight: 1, required: true, active: true })),
});
const written = (sid: string, title: string, kind: 'self' | 'manager' | 'hr', items: string[], description = '', required = true): AppraisalSection => ({
  id: sid, title, description, kind, audience: 'all', active: true,
  questions: items.map((t, i) => ({ id: `${sid}-${i + 1}`, text: t, kind: 'long_text', weight: 0, required, active: true })),
});

/** The Frequent Research Employee Performance Evaluation form, as provided, ready for HR to adjust. */
export const FREQUENT_RESEARCH_TEMPLATE: AppraisalDefinition = {
  title: 'Frequent Research Employee Performance Evaluation',
  intro: 'Welcome to the Frequent Research Performance Evaluation Program.',
  scale: {
    min: 1,
    max: 5,
    levels: [
      { from: 1, to: 1, label: 'Below Performance', description: 'Performance is below standards. Employee does not fully achieve assigned goals. Work assignments are not consistent in meeting quality standards or deadlines. Employee requires close supervision and does not consistently demonstrate the ability to perform job functions at the expected level of proficiency.' },
      { from: 2, to: 3, label: 'Good Performance', description: 'Satisfactorily performs assigned activities and achieves expected outcomes. Work assignments are typically completed on time and meet quality standards. Employee works under general or minimum supervision, with demonstrated understanding of job functions and expected standards.' },
      { from: 4, to: 5, label: 'Outstanding Performance', description: 'Quality and quantity of work are routinely higher than expected. Performance reflects a high degree of initiative, commitment to excellence, and the ability to anticipate and respond to client or vendor needs. Employee demonstrates mastery of job functions and contributes to improved systems and procedures.' },
    ],
  },
  sections: [
    rated('job-knowledge', 'Job Knowledge', ['Understands job requirements and responsibilities', 'Possesses required skills and knowledge for the job', 'Keeps abreast of current developments pertaining to the job']),
    rated('planning', 'Planning and Problem Solving', ['Works in an organized manner', 'Requires minimal supervision', 'Can identify problems', 'Reacts to problems in an appropriate time']),
    rated('productivity', 'Productivity', ['Achieves established goals', 'Can multitask between several projects', 'Meets productivity standards']),
    rated('communication', 'Communication Skills', ['Articulates ideas effectively', 'Participates in meetings', 'Listens carefully']),
    rated('teamwork', 'Teamwork', ['Is an effective team player', 'Offers assistance to team members', 'Works well with different personality types', 'Participates in team discussions']),
    rated('management', 'Management Skills', [
      'Clearly identifies goals to all working in the managed area', 'Holds themselves accountable to goals and objectives', 'Reports progress towards reaching goals to all in the managed area',
      'Demonstrates effective leadership talent and skills', 'Positively motivates others to achieve goals and gain skills',
    ], 'managers'),
    rated('discretion', 'Discretion and Confidentiality', [
      'Understands which Market Research Data Privacy information or materials are sensitive and why', 'Secures company credentials from external access',
      'Demonstrates the ability to maintain sensitive information in confidence, sharing only with appropriate contacts',
    ]),
    written('self-questions', 'Employee Self-Appraisal Questions', 'self', [
      'List your top three achievements during this appraisal period.', 'Describe a project or task where you added significant value to the team or organization.', 'What are your short-term goals for the next 6–12 months?',
    ]),
    written('manager-feedback', 'Manager Feedback', 'manager', ['Key Strengths', 'Areas of Improvement', 'Performance Observations', 'Recommended Training', 'Career Development Recommendations', "Manager's Overall Comments"]),
    written('hr-evaluation', 'HR Evaluation', 'hr', ['HR Observations', 'Policy and Compliance Review', 'Final Performance Recommendation', 'Appraisal Outcome', 'HR Remarks']),
  ],
  scoring: { method: 'manager', hrScores: false, weights: { employee: 0, manager: 100, hr: 0 } },
  bands: DEFAULT_APPRAISAL_BANDS,
  declaration: 'Your self-appraisal will be reviewed by your reporting manager during the appraisal discussion. We encourage you to be honest and detailed, as this will form an important part of the evaluation process.',
};

export const APPRAISAL_TEMPLATES = [{ key: 'frequent_research', name: 'Frequent Research Employee Performance Evaluation', definition: FREQUENT_RESEARCH_TEMPLATE }] as const;
export type AppraisalTemplateKey = (typeof APPRAISAL_TEMPLATES)[number]['key'];

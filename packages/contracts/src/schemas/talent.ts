import { z } from 'zod';
import { SURVEY_QUESTION_KINDS } from '../talent-math';
import { isoDate } from './people';

const decimal = z.string().trim().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'Use a number such as 40 or 12.5');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

// Goals -------------------------------------------------------------------------------------------------------

export const GOAL_STATUSES = ['active', 'completed', 'cancelled'] as const;
export const CONFIDENCE_LEVELS = ['on_track', 'at_risk', 'off_track'] as const;

export const keyResultInput = z.object({
  id: z.uuid().optional(),
  title: text(3, 200),
  startValue: decimal.default('0'),
  targetValue: decimal,
  unit: z.string().trim().max(20).default(''),
});

export const goalInput = z
  .object({
    /** Whose goal it is. Defaults to the caller's own employee record. */
    employeeId: z.uuid().optional(),
    parentGoalId: z.uuid().nullable().optional(),
    title: text(3, 200),
    description: z.string().trim().max(2000).default(''),
    periodStart: isoDate,
    periodEnd: isoDate,
    weight: z.number().int().min(0).max(100).default(0),
    keyResults: z.array(keyResultInput).max(10).default([]),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: 'The end date must be on or after the start date', path: ['periodEnd'] })
  .refine((v) => v.keyResults.every((k) => Number(k.startValue) !== Number(k.targetValue)), { message: 'A target must differ from its starting value', path: ['keyResults'] });
export type GoalInput = z.infer<typeof goalInput>;

export const checkinInput = z.object({
  /** Only for goals without key results. */
  progress: z.number().min(0).max(100).optional(),
  values: z.array(z.object({ keyResultId: z.uuid(), value: decimal })).max(10).default([]),
  confidence: z.enum(CONFIDENCE_LEVELS),
  note: z.string().trim().max(1000).default(''),
});
export type CheckinInput = z.infer<typeof checkinInput>;

export const goalStatusInput = z.object({ status: z.enum(GOAL_STATUSES), note: z.string().trim().max(500).default('') });

// Reviews -----------------------------------------------------------------------------------------------------

export const CYCLE_STATUSES = ['draft', 'active', 'calibration', 'released'] as const;

const questionList = z
  .array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,20}$/), text: text(3, 300) }))
  .min(1)
  .max(15)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, 'Each question needs its own id');

const ratingScale = z
  .array(z.object({ value: z.number().int().min(1).max(10), label: text(2, 60) }))
  .min(2)
  .max(10)
  .refine((s) => s.every((l, i) => l.value === i + 1), 'Number the rating levels 1, 2, 3 and so on, lowest first');

export const cycleInput = z
  .object({
    name: text(3, 120),
    periodStart: isoDate,
    periodEnd: isoDate,
    selfReview: z.boolean().default(true),
    peerFeedback: z.boolean().default(false),
    questions: questionList,
    ratingScale,
    legalEntityId: z.uuid().nullable().default(null),
    departmentId: z.uuid().nullable().default(null),
    selfDue: isoDate.nullable().default(null),
    managerDue: isoDate.nullable().default(null),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: 'The end date must be on or after the start date', path: ['periodEnd'] });
export type CycleInput = z.infer<typeof cycleInput>;

const answers = z.record(z.string().regex(/^[a-z0-9_]{1,20}$/), z.string().trim().max(4000));

export const reviewWriteInput = z.object({
  answers: answers.default({}),
  rating: z.number().int().min(1).max(10).nullable().default(null),
  /** false saves a draft; true submits, after which the review cannot be changed. */
  submit: z.boolean().default(false),
});
export type ReviewWriteInput = z.infer<typeof reviewWriteInput>;

export const feedbackRequestInput = z.object({ reviewerEmployeeIds: z.array(z.uuid()).min(1).max(8) });
export const feedbackWriteInput = z.object({ answers: answers.default({}), submit: z.boolean().default(false) });
export const calibrateInput = z.object({ finalRating: z.number().int().min(1).max(10), reason: text(5, 1000) });
export const excludeInput = z.object({ reason: text(5, 500) });
export const acknowledgeInput = z.object({ comment: z.string().trim().max(2000).default('') });

// Learning ----------------------------------------------------------------------------------------------------

export const COURSE_FORMATS = ['online', 'video', 'document', 'classroom'] as const;
export const ASSIGNMENT_STATUSES = ['assigned', 'in_progress', 'completed', 'cancelled'] as const;

export const courseInput = z.object({
  title: text(3, 160),
  description: z.string().trim().max(4000).default(''),
  format: z.enum(COURSE_FORMATS),
  contentUrl: z.url({ protocol: /^https$/, message: 'Use an https:// link' }).max(500).nullable().default(null),
  durationMinutes: z.number().int().min(1).max(10000).nullable().default(null),
  /** Completion lapses after this many months (certifications that need renewing). */
  validityMonths: z.number().int().min(1).max(120).nullable().default(null),
  category: z.string().trim().max(60).default(''),
  selfEnrol: z.boolean().default(true),
});
export type CourseInput = z.infer<typeof courseInput>;

export const pathInput = z.object({
  title: text(3, 160),
  description: z.string().trim().max(2000).default(''),
  courseIds: z.array(z.uuid()).min(1).max(30).refine((ids) => new Set(ids).size === ids.length, 'Each course can appear once'),
});
export type PathInput = z.infer<typeof pathInput>;

export const assignInput = z
  .object({
    employeeIds: z.array(z.uuid()).min(1).max(200),
    courseId: z.uuid().optional(),
    pathId: z.uuid().optional(),
    dueOn: isoDate.nullable().default(null),
  })
  .refine((v) => Boolean(v.courseId) !== Boolean(v.pathId), { message: 'Choose a course or a learning path', path: ['courseId'] });
export type AssignInput = z.infer<typeof assignInput>;

export const completeInput = z.object({ note: z.string().trim().max(1000).default(''), completedOn: isoDate.optional() });

// Engagement --------------------------------------------------------------------------------------------------

export const SURVEY_STATUSES = ['draft', 'open', 'closed'] as const;

export const surveyInput = z.object({
  title: text(3, 160),
  description: z.string().trim().max(2000).default(''),
  /** Every survey is anonymous: responses are stored without the respondent. */
  minResponses: z.number().int().min(3).max(50).default(5),
  questions: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,20}$/), kind: z.enum(SURVEY_QUESTION_KINDS), text: text(3, 300) }))
    .min(1)
    .max(30)
    .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, 'Each question needs its own id'),
  legalEntityId: z.uuid().nullable().default(null),
  departmentId: z.uuid().nullable().default(null),
  closesOn: isoDate.nullable().default(null),
});
export type SurveyInput = z.infer<typeof surveyInput>;

export const surveyAnswerInput = z.object({ answers: z.record(z.string(), z.union([z.number(), z.string().max(2000), z.null()])) });

export const recognitionInput = z.object({
  toEmployeeId: z.uuid(),
  valueId: z.uuid().nullable().default(null),
  message: text(3, 500),
});
export const valueInput = z.object({ name: text(2, 60), description: z.string().trim().max(300).default('') });
export const hideInput = z.object({ reason: text(3, 300) });

/** 360 feedback uses the same two prompts in every cycle. */
export const PEER_QUESTIONS = [
  { id: 'strengths', text: 'What does this person do well?' },
  { id: 'improve', text: 'What could they do more of, or differently?' },
] as const;
/** Peer feedback is shown to the employee, without names, only when at least this many peers answered. */
export const PEER_ANONYMITY_MIN = 3;

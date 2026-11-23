import { z } from 'zod';

/**
 * Learning & Development (LMS). A learning module is a course in the catalogue that carries an ordered list of
 * content blocks (video, audio, text, documents, presentations, links, images, quizzes and assignments). The
 * module is edited as a working copy; publishing freezes it as a numbered version, and every learner works through
 * the version they were enrolled on, so later edits never change a historical record.
 *
 * This file is shared by the API and the web app: the inputs, the predefined lists, and the pure rules (grading a
 * quiz, working out progress, the learner's view of a block without its answers, deadline states).
 */

// Predefined lists ---------------------------------------------------------------------------------------------

export const LEARNING_CATEGORIES = [
  'Onboarding', 'Compliance', 'Company Policy', 'Workplace Safety', 'Communication', 'Leadership', 'Management', 'Sales',
  'Customer Service', 'Technical Skills', 'Soft Skills', 'Professional Development', 'Product Training', 'HR Training',
  'Finance', 'Cybersecurity', 'Data Privacy', 'Workplace Ethics', 'Performance Improvement', 'Career Development', 'Other',
] as const;

export const LEARNING_SKILLS = [
  'Communication', 'Leadership', 'Teamwork', 'Problem Solving', 'Time Management', 'Sales', 'Negotiation', 'Customer Service',
  'Technical Skills', 'Project Management', 'Data Analysis', 'Software Development', 'Management', 'Presentation', 'Business Writing',
] as const;

export const LEARNING_DIFFICULTIES = ['beginner', 'intermediate', 'advanced', 'expert', 'custom'] as const;
export type LearningDifficulty = (typeof LEARNING_DIFFICULTIES)[number];
export const DIFFICULTY_LABEL: Record<LearningDifficulty, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', expert: 'Expert', custom: 'Custom' };

export const LEARNING_LANGUAGES = ['English', 'Hindi', 'Arabic', 'Bengali', 'French', 'German', 'Gujarati', 'Kannada', 'Malayalam', 'Marathi', 'Spanish', 'Tamil', 'Telugu', 'Urdu', 'Other'] as const;

/** Module states. Draft and scheduled modules are never visible to learners. */
export const MODULE_STATUSES = ['draft', 'scheduled', 'published', 'archived'] as const;
export type ModuleStatus = (typeof MODULE_STATUSES)[number];
export const MODULE_STATUS_LABEL: Record<ModuleStatus, string> = { draft: 'Draft', scheduled: 'Scheduled', published: 'Published', archived: 'Archived' };

/** The module's main format, worked out from its blocks (kept in `courses.format` so older screens still read it). */
export const MODULE_FORMATS = ['online', 'video', 'document', 'classroom', 'audio', 'text', 'presentation', 'external', 'mixed'] as const;
export type ModuleFormat = (typeof MODULE_FORMATS)[number];
export const FORMAT_LABEL: Record<ModuleFormat, string> = {
  online: 'Online course', video: 'Video', document: 'Document', classroom: 'Classroom', audio: 'Audio', text: 'Article', presentation: 'Presentation', external: 'External resource', mixed: 'Mixed',
};

export const BLOCK_KINDS = ['text', 'video', 'audio', 'document', 'presentation', 'external', 'image', 'quiz', 'assignment'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];
export const BLOCK_LABEL: Record<BlockKind, string> = {
  text: 'Text', video: 'Video', audio: 'Audio', document: 'Document / PDF', presentation: 'Presentation', external: 'External link', image: 'Image', quiz: 'Quiz / test', assignment: 'Assignment',
};

export const QUESTION_TYPES = ['single', 'multiple', 'true_false', 'exact', 'short', 'long', 'matching', 'scenario'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_LABEL: Record<QuestionType, string> = {
  single: 'Multiple choice (one answer)', multiple: 'Multiple select', true_false: 'True / false', exact: 'Single answer (typed)',
  short: 'Short answer (graded by a reviewer)', long: 'Long answer (graded by a reviewer)', matching: 'Matching', scenario: 'Scenario-based',
};
/** Question types a person marks by hand. */
export const MANUAL_QUESTION_TYPES: readonly QuestionType[] = ['short', 'long'];

export const SUBMISSION_TYPES = ['text', 'file', 'link'] as const;
export type SubmissionType = (typeof SUBMISSION_TYPES)[number];

/**
 * What the Super Workspace can let each HR Workspace do in Learning. Nothing is on by default except viewing:
 * an HR Workspace gets the rest only when the Super Workspace switches it on.
 */
export const LEARNING_CAPS = ['view', 'create', 'edit', 'publish', 'assign', 'quiz', 'assignment', 'grade', 'reports', 'export'] as const;
export type LearningCap = (typeof LEARNING_CAPS)[number];
export const LEARNING_CAP_LABEL: Record<LearningCap, string> = {
  view: 'View learning', create: 'Create learning module', edit: 'Edit learning module', publish: 'Publish learning module', assign: 'Assign learning',
  quiz: 'Create quiz', assignment: 'Create assignment', grade: 'Grade assignment', reports: 'View learning reports', export: 'Export learning reports',
};
export const DEFAULT_HR_LEARNING_CAPS: readonly LearningCap[] = ['view'];

// Blocks -------------------------------------------------------------------------------------------------------

const blockId = z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Use letters, digits, - or _');
const httpsUrl = z.url({ protocol: /^https$/, message: 'Use an https:// link' }).max(1000);
const title = z.string().trim().min(1, 'Give it a title').max(200);
const desc = z.string().trim().max(4000).default('');

/** A file uploaded to the learning library, or a link. */
const source = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upload'), fileId: z.uuid() }),
  z.object({ type: z.literal('url'), url: httpsUrl }),
]);
export type BlockSource = z.infer<typeof source>;

/** How a media or reading block counts as done. */
export const COMPLETION_RULES = ['full', 'percent', 'manual', 'open'] as const;
export type CompletionRule = (typeof COMPLETION_RULES)[number];
export const COMPLETION_RULE_LABEL: Record<CompletionRule, string> = {
  full: 'Watch or listen to all of it', percent: 'Watch or listen to a minimum percentage', manual: 'Learner marks it complete', open: 'Opening it counts',
};

const optionId = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const question = z.object({
  id: blockId,
  type: z.enum(QUESTION_TYPES),
  text: z.string().trim().min(1, 'Write the question').max(2000),
  /** Scenario-based questions: the situation the question is about. */
  scenario: z.string().trim().max(4000).default(''),
  options: z.array(z.object({ id: optionId, text: z.string().trim().min(1).max(500) })).max(12).default([]),
  /** single, scenario, true_false: one option id ("true"/"false" for true_false); multiple: every correct id. */
  correct: z.array(z.string().max(500)).max(12).default([]),
  /** exact: accepted answers (compared ignoring case and extra spaces). */
  accepted: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  /** matching: the left items and the right item each matches. */
  pairs: z.array(z.object({ left: z.string().trim().min(1).max(300), right: z.string().trim().min(1).max(300) })).max(12).default([]),
  explanation: z.string().trim().max(2000).default(''),
  marks: z.number().min(0.5).max(100).default(1),
  difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
  required: z.boolean().default(true),
});
export type QuizQuestion = z.infer<typeof question>;

export const quizSettings = z.object({
  passPercent: z.number().int().min(0).max(100).default(70),
  /** 0 means unlimited. */
  maxAttempts: z.number().int().min(0).max(20).default(3),
  /** Minutes; 0 means no time limit. */
  timeLimitMinutes: z.number().int().min(0).max(600).default(0),
  randomizeQuestions: z.boolean().default(false),
  randomizeOptions: z.boolean().default(false),
  showCorrectAnswers: z.boolean().default(true),
  showScore: z.boolean().default(true),
  allowRetake: z.boolean().default(true),
  /** A final assessment: its score is the module's score when it has one. */
  finalAssessment: z.boolean().default(false),
});
export type QuizSettings = z.infer<typeof quizSettings>;

export const assignmentSettings = z.object({
  instructions: z.string().trim().min(1, 'Write the instructions').max(8000),
  startOn: z.iso.date().nullable().default(null),
  dueOn: z.iso.date().nullable().default(null),
  maxScore: z.number().int().min(1).max(1000).default(100),
  passScore: z.number().int().min(0).max(1000).default(50),
  submissionTypes: z.array(z.enum(SUBMISSION_TYPES)).min(1, 'Allow at least one kind of submission').max(3).default(['text']),
  /** Files for the learner to read: reference material. */
  referenceFileIds: z.array(z.uuid()).max(10).default([]),
  gradingMethod: z.enum(['score', 'pass_fail']).default('score'),
});
export type AssignmentSettings = z.infer<typeof assignmentSettings>;

const blockBase = { id: blockId, title, description: desc, required: z.boolean().default(true) };

export const contentBlock = z.discriminatedUnion('kind', [
  z.object({ ...blockBase, kind: z.literal('text'), body: z.string().max(100_000).default(''), attachmentFileIds: z.array(z.uuid()).max(10).default([]), completion: z.enum(['open', 'manual']).default('manual') }),
  z.object({
    ...blockBase, kind: z.literal('video'), source, durationMinutes: z.number().int().min(1).max(1000).nullable().default(null), coverFileId: z.uuid().nullable().default(null),
    completion: z.enum(COMPLETION_RULES).default('full'), minPercent: z.number().int().min(10).max(100).default(90),
  }),
  z.object({
    ...blockBase, kind: z.literal('audio'), source, durationMinutes: z.number().int().min(1).max(1000).nullable().default(null), coverFileId: z.uuid().nullable().default(null),
    completion: z.enum(COMPLETION_RULES).default('full'), minPercent: z.number().int().min(10).max(100).default(90),
  }),
  z.object({ ...blockBase, kind: z.literal('document'), source, coverFileId: z.uuid().nullable().default(null), completion: z.enum(['open', 'manual']).default('manual') }),
  z.object({ ...blockBase, kind: z.literal('presentation'), source, completion: z.enum(['open', 'manual']).default('manual') }),
  z.object({ ...blockBase, kind: z.literal('external'), url: httpsUrl, completion: z.enum(['open', 'manual']).default('open') }),
  z.object({ ...blockBase, kind: z.literal('image'), source, caption: z.string().trim().max(500).default(''), completion: z.enum(['open', 'manual']).default('open') }),
  z.object({ ...blockBase, kind: z.literal('quiz'), settings: quizSettings.default(quizSettings.parse({})), questions: z.array(question).min(1, 'Add at least one question').max(100) }),
  z.object({ ...blockBase, kind: z.literal('assignment'), settings: assignmentSettings }),
]);
export type ContentBlock = z.infer<typeof contentBlock>;
export type QuizBlock = Extract<ContentBlock, { kind: 'quiz' }>;
export type AssignmentBlock = Extract<ContentBlock, { kind: 'assignment' }>;

/** Checks a quiz question is answerable: options, a correct answer that exists, and so on. Returns problems. */
export function questionIssues(q: QuizQuestion): string[] {
  const out: string[] = [];
  const ids = new Set(q.options.map((o) => o.id));
  if (['single', 'multiple', 'scenario'].includes(q.type)) {
    if (q.options.length < 2) out.push('Give at least two answer options');
    if (ids.size !== q.options.length) out.push('Each option needs its own id');
    if (!q.correct.length) out.push('Mark the correct answer');
    if (q.correct.some((c) => !ids.has(c))) out.push('A correct answer is not one of the options');
    if (q.type !== 'multiple' && q.correct.length > 1) out.push('Only one answer can be correct');
  }
  if (q.type === 'scenario' && !q.scenario) out.push('Describe the scenario');
  if (q.type === 'true_false' && !(q.correct.length === 1 && ['true', 'false'].includes(q.correct[0]!))) out.push('Choose whether the statement is true or false');
  if (q.type === 'exact' && !q.accepted.length) out.push('Add the accepted answer');
  if (q.type === 'matching' && q.pairs.length < 2) out.push('Add at least two pairs to match');
  return out;
}

/** Problems in a module's blocks (ids repeated, quiz questions that cannot be answered, pass marks above the maximum). */
export function blockIssues(blocks: ContentBlock[]): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const seen = new Set<string>();
  blocks.forEach((b, i) => {
    if (seen.has(b.id)) out.push({ path: `blocks.${i}.id`, message: 'Two content items have the same id' });
    seen.add(b.id);
    if (b.kind === 'quiz') {
      const qs = new Set<string>();
      b.questions.forEach((q, j) => {
        if (qs.has(q.id)) out.push({ path: `blocks.${i}.questions.${j}.id`, message: 'Two questions have the same id' });
        qs.add(q.id);
        for (const m of questionIssues(q)) out.push({ path: `blocks.${i}.questions.${j}`, message: `Question ${j + 1}: ${m}` });
      });
    }
    if ((b.kind === 'video' || b.kind === 'audio') && b.source.type === 'url' && embedUrl(b.source.url) && (b.completion === 'full' || b.completion === 'percent')) {
      out.push({ path: `blocks.${i}.completion`, message: 'YouTube and Vimeo players do not report how much was watched: choose "Learner marks it complete" or "Opening it counts"' });
    }
    if (b.kind === 'assignment') {
      if (b.settings.passScore > b.settings.maxScore) out.push({ path: `blocks.${i}.settings.passScore`, message: 'The passing score is above the maximum score' });
      if (b.settings.startOn && b.settings.dueOn && b.settings.dueOn < b.settings.startOn) out.push({ path: `blocks.${i}.settings.dueOn`, message: 'The due date is before the start date' });
    }
  });
  return out;
}

/** The module's main format from its content. */
export function formatOf(blocks: { kind: BlockKind }[]): ModuleFormat {
  const kinds = new Set(blocks.map((b) => b.kind).filter((k) => k !== 'quiz' && k !== 'assignment' && k !== 'image'));
  if (kinds.size === 0) return blocks.length ? 'mixed' : 'online';
  if (kinds.size > 1) return 'mixed';
  const k = [...kinds][0]!;
  return k === 'text' ? 'text' : k === 'external' ? 'external' : (k as ModuleFormat);
}

// Module input -------------------------------------------------------------------------------------------------

/**
 * Who a module is for. A person is included when they match any of the groups chosen ("everyone" includes every
 * current employee). An HR Workspace only reaches the people it manages, whatever is chosen.
 */
export const learningAudience = z.object({
  all: z.boolean().default(false),
  employeeIds: z.array(z.uuid()).max(2000).default([]),
  hrWorkspaceIds: z.array(z.uuid()).max(200).default([]),
  /** People not in any HR Workspace (the central group). */
  central: z.boolean().default(false),
  departmentIds: z.array(z.uuid()).max(500).default([]),
  designationIds: z.array(z.uuid()).max(500).default([]),
  locationIds: z.array(z.uuid()).max(500).default([]),
  employmentTypes: z.array(z.enum(['full_time', 'part_time', 'contract', 'intern', 'temporary'])).max(5).default([]),
});
export type LearningAudience = z.infer<typeof learningAudience>;
export const EMPTY_LEARNING_AUDIENCE: LearningAudience = learningAudience.parse({});
export const audienceIsEmpty = (a: LearningAudience) =>
  !a.all && !a.central && !a.employeeIds.length && !a.hrWorkspaceIds.length && !a.departmentIds.length && !a.designationIds.length && !a.locationIds.length && !a.employmentTypes.length;

export const learningModuleInput = z.object({
  title: z.string().trim().min(3, 'At least 3 characters').max(160),
  shortDescription: z.string().trim().max(300).default(''),
  description: z.string().trim().max(4000).default(''),
  category: z.string().trim().min(1, 'Choose a category').max(60),
  topic: z.string().trim().max(120).default(''),
  skills: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  difficulty: z.enum(LEARNING_DIFFICULTIES).default('beginner'),
  customDifficulty: z.string().trim().max(40).default(''),
  durationMinutes: z.number().int().min(1).max(10000).nullable().default(null),
  creatorName: z.string().trim().min(1, 'Who is the instructor or creator?').max(120),
  creatorDesignation: z.string().trim().max(120).default(''),
  coverFileId: z.uuid().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  language: z.string().trim().min(1).max(40).default('English'),
  selfEnrol: z.boolean().default(false),
  /** Issue a completion certificate when a learner completes the module. */
  certificate: z.boolean().default(false),
  /** Days after enrolment the module is due, when the assignment does not set a date. */
  defaultDueDays: z.number().int().min(1).max(365).nullable().default(null),
  /** For an HR Workspace admin of several HR Workspaces: which one owns the module. Ignored for the Super Workspace. */
  hrWorkspaceId: z.uuid().nullable().default(null),
  blocks: z.array(contentBlock).max(60).default([]),
}).strict();
export type LearningModuleInput = z.infer<typeof learningModuleInput>;

export const publishModuleInput = z.object({
  /** Publish now (null) or at a later time. */
  publishAt: z.iso.datetime({ offset: true }).nullable().default(null),
  /** What changed, kept with the version. */
  note: z.string().trim().max(500).default(''),
}).strict();

export const assignModuleInput = z.object({
  audience: learningAudience,
  dueOn: z.iso.date().nullable().default(null),
  /** Keep enrolling new people who come to match the audience (new joiners, transfers). */
  keepEnrolling: z.boolean().default(false),
}).strict();
export type AssignModuleInput = z.infer<typeof assignModuleInput>;

export const moduleListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum([...MODULE_STATUSES, 'all']).default('all'),
  category: z.string().trim().max(60).optional(),
  skill: z.string().trim().max(60).optional(),
  difficulty: z.enum(LEARNING_DIFFICULTIES).optional(),
  format: z.enum(MODULE_FORMATS).optional(),
});

// Learner actions ----------------------------------------------------------------------------------------------

export const blockProgressInput = z.object({
  /** For video and audio: the furthest point reached and the length, in seconds. */
  position: z.number().min(0).max(1_000_000).optional(),
  duration: z.number().min(0).max(1_000_000).optional(),
  /** The learner says they finished it (manual rule), or opened it (open rule). */
  action: z.enum(['open', 'complete', 'heartbeat']),
  /** Seconds spent since the last report (capped). */
  seconds: z.number().int().min(0).max(600).default(0),
}).strict();

export const quizAnswersInput = z.object({
  attemptId: z.uuid(),
  /** By question id: option ids, typed text, or for matching the right-hand item chosen for each left item, in order. */
  answers: z.record(z.string(), z.union([z.array(z.string().max(500)).max(12), z.string().max(8000)])),
}).strict();
export type QuizAnswers = z.infer<typeof quizAnswersInput>['answers'];

export const submissionInput = z.object({
  text: z.string().trim().max(20_000).default(''),
  link: httpsUrl.nullable().default(null),
  fileIds: z.array(z.uuid()).max(5).default([]),
}).strict().refine((v) => v.text || v.link || v.fileIds.length, 'Write a response, add a link or attach a file');

export const SUBMISSION_STATUSES = ['submitted', 'approved', 'rejected', 'resubmit'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];
export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = { submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', resubmit: 'Resubmission requested' };

export const reviewSubmissionInput = z.object({
  decision: z.enum(['approved', 'rejected', 'resubmit']),
  score: z.number().min(0).max(1000).nullable().default(null),
  feedback: z.string().trim().max(4000).default(''),
}).strict().refine((v) => v.decision === 'approved' || v.feedback.length >= 3, { message: 'Tell the learner why', path: ['feedback'] });

/** Marks for answers a reviewer grades by hand (short and long answers), by question id. */
export const gradeAttemptInput = z.object({
  marks: z.record(z.string(), z.number().min(0).max(100)),
  feedback: z.string().trim().max(4000).default(''),
}).strict();

export const learningPermissionsInput = z.object({
  /** null: HR Workspace admins for the whole company (the central group). */
  hrWorkspaceId: z.uuid().nullable(),
  caps: z.array(z.enum(LEARNING_CAPS)).max(LEARNING_CAPS.length).transform((a) => [...new Set(a)]),
}).strict();

export const learningCategoryInput = z.object({ name: z.string().trim().min(2).max(60) }).strict();

export const learningReportQuery = z.object({
  moduleId: z.uuid().optional(),
  employeeId: z.uuid().optional(),
  hrWorkspaceId: z.union([z.uuid(), z.literal('central')]).optional(),
  departmentId: z.uuid().optional(),
  designationId: z.uuid().optional(),
  status: z.enum(['not_started', 'in_progress', 'completed', 'overdue']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  minScore: z.coerce.number().min(0).max(100).optional(),
  maxScore: z.coerce.number().min(0).max(100).optional(),
  q: z.string().trim().max(100).optional(),
});
export type LearningReportQuery = z.infer<typeof learningReportQuery>;

// Pure rules ---------------------------------------------------------------------------------------------------

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export interface QuestionResult { id: string; earned: number; marks: number; correct: boolean | null; manual: boolean }
export interface QuizResult {
  earned: number; total: number;
  /** Rounded to one decimal; null while answers still wait for a reviewer. */
  percent: number | null;
  passed: boolean | null;
  pendingReview: boolean;
  questions: QuestionResult[];
}

/**
 * Marks a quiz. Single, true/false and scenario answers must be the correct option; multiple select must name
 * exactly the correct options; typed answers match an accepted answer ignoring case and spacing; matching earns
 * marks in proportion to the pairs matched. Short and long answers wait for a reviewer (`manualMarks` once given).
 */
export function gradeQuiz(quiz: Pick<QuizBlock, 'questions' | 'settings'>, answers: QuizAnswers, manualMarks: Record<string, number> = {}): QuizResult {
  const questions: QuestionResult[] = quiz.questions.map((q) => {
    const a = answers[q.id];
    const list = Array.isArray(a) ? a : typeof a === 'string' && a ? [a] : [];
    if (MANUAL_QUESTION_TYPES.includes(q.type)) {
      const given = manualMarks[q.id];
      const answered = typeof a === 'string' ? a.trim().length > 0 : list.length > 0;
      if (!answered) return { id: q.id, earned: 0, marks: q.marks, correct: false, manual: true };
      return given === undefined ? { id: q.id, earned: 0, marks: q.marks, correct: null, manual: true } : { id: q.id, earned: Math.min(given, q.marks), marks: q.marks, correct: given >= q.marks / 2, manual: true };
    }
    let earned = 0;
    if (q.type === 'multiple') {
      const want = new Set(q.correct);
      const got = new Set(list);
      earned = want.size === got.size && [...want].every((x) => got.has(x)) ? q.marks : 0;
    } else if (q.type === 'exact') {
      earned = list.length && q.accepted.some((x) => norm(x) === norm(list[0]!)) ? q.marks : 0;
    } else if (q.type === 'matching') {
      const right = q.pairs.filter((p, i) => list[i] !== undefined && norm(list[i]!) === norm(p.right)).length;
      earned = q.pairs.length ? Math.round((q.marks * right / q.pairs.length) * 100) / 100 : 0;
    } else {
      earned = list.length === 1 && q.correct.includes(list[0]!) ? q.marks : 0;
    }
    return { id: q.id, earned, marks: q.marks, correct: earned >= q.marks, manual: false };
  });
  const total = questions.reduce((n, q) => n + q.marks, 0);
  const earned = questions.reduce((n, q) => n + q.earned, 0);
  const pendingReview = questions.some((q) => q.manual && q.correct === null);
  const percent = pendingReview ? null : total ? Math.round((earned / total) * 1000) / 10 : 0;
  return { earned, total, percent, passed: percent === null ? null : percent >= quiz.settings.passPercent, pendingReview, questions };
}

/** A question as the learner sees it: no correct answers, explanations or accepted answers; matching items shuffled. */
export function learnerQuestion(q: QuizQuestion, shuffle: <T>(a: T[]) => T[] = (a) => a) {
  return {
    id: q.id, type: q.type, text: q.text, scenario: q.scenario, marks: q.marks, required: q.required,
    options: q.type === 'true_false' ? [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }] : q.options,
    left: q.type === 'matching' ? q.pairs.map((p) => p.left) : [],
    right: q.type === 'matching' ? shuffle(q.pairs.map((p) => p.right)) : [],
  };
}
export type LearnerQuestion = ReturnType<typeof learnerQuestion>;

/** A deterministic shuffle (the same seed gives the same order), so a reloaded attempt keeps its order. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A block's state for one learner. */
export interface BlockState {
  done: boolean;
  /** 0-100: how much of a video or audio was reached, or the best quiz score. */
  percent?: number;
  openedAt?: string;
  doneAt?: string;
  /** Quiz: best result; assignment: latest submission status. */
  bestPercent?: number | null;
  passed?: boolean | null;
  submission?: SubmissionStatus | null;
  attempts?: number;
}

/** Whether a media block's rule is met at this point (seconds reached of the length). */
export function mediaComplete(rule: CompletionRule, minPercent: number, position: number, duration: number): boolean {
  if (rule === 'manual' || rule === 'open') return false;
  if (!duration) return false;
  const pct = (position / duration) * 100;
  // "All of it" allows the last 2 seconds (players often stop a moment before the end).
  return rule === 'full' ? position >= duration - 2 || pct >= 99 : pct >= minPercent;
}

/**
 * Progress through a module: the share of required items done (every item, when none is marked required). Worked
 * out from the learner's records each time it is shown, never stored as a fixed number.
 */
export function moduleProgress(blocks: { id: string; required: boolean }[], state: Record<string, BlockState | undefined>) {
  const counted = blocks.some((b) => b.required) ? blocks.filter((b) => b.required) : blocks;
  const done = counted.filter((b) => state[b.id]?.done).map((b) => b.id);
  const remaining = counted.filter((b) => !state[b.id]?.done).map((b) => b.id);
  const percent = counted.length ? Math.round((done.length / counted.length) * 100) : 0;
  return { percent, done, remaining, complete: counted.length > 0 && remaining.length === 0 };
}

/**
 * The module's score: the final assessment's best score when it has one; otherwise the average of the best quiz
 * scores and assignment scores (as a percentage of the maximum). Null when nothing is scored.
 */
export function moduleScore(blocks: ContentBlock[], state: Record<string, BlockState | undefined>, assignmentScores: Record<string, number | null> = {}): number | null {
  const finalQuiz = blocks.find((b): b is QuizBlock => b.kind === 'quiz' && b.settings.finalAssessment);
  if (finalQuiz) return state[finalQuiz.id]?.bestPercent ?? null;
  const scores: number[] = [];
  for (const b of blocks) {
    if (b.kind === 'quiz' && typeof state[b.id]?.bestPercent === 'number') scores.push(state[b.id]!.bestPercent!);
    if (b.kind === 'assignment' && b.settings.gradingMethod === 'score' && typeof assignmentScores[b.id] === 'number') scores.push(Math.round((assignmentScores[b.id]! / b.settings.maxScore) * 1000) / 10);
  }
  return scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
}

export type DueState = 'none' | 'on_track' | 'due_soon' | 'overdue';
/** Deadline state: due soon within 3 days. Completed learning is never overdue. */
export function dueState(dueOn: string | null | undefined, today: string, completed = false): { state: DueState; daysLeft: number | null } {
  if (!dueOn || completed) return { state: 'none', daysLeft: null };
  const days = Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return { state: days < 0 ? 'overdue' : days <= 3 ? 'due_soon' : 'on_track', daysLeft: days };
}

/** The learner-facing status of an enrolment. */
export type LearnerStatus = 'not_started' | 'in_progress' | 'completed' | 'overdue' | 'cancelled';
export function learnerStatus(status: string, dueOn: string | null | undefined, today: string): LearnerStatus {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (dueOn && dueOn < today) return 'overdue';
  return status === 'in_progress' ? 'in_progress' : 'not_started';
}
export const LEARNER_STATUS_LABEL: Record<LearnerStatus, string> = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed', overdue: 'Overdue', cancelled: 'Cancelled' };

/** A short certificate number: SC-<year>-<8 characters>. */
export function certificateNumber(year: number, random: string): string {
  return `SC-${year}-${random.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()}`;
}

/** Media and file types the learning library accepts. Videos and audio up to 50 MB; documents and images up to 25 MB. */
export const LEARNING_FILE_TYPES = {
  video: ['video/mp4', 'video/webm'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm'],
  document: ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'text/plain'],
  presentation: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint', 'application/pdf'],
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
} as const;
export const LEARNING_MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const LEARNING_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const ALL_LEARNING_FILE_TYPES: readonly string[] = [...new Set(Object.values(LEARNING_FILE_TYPES).flat())];

/** YouTube or Vimeo links become privacy-friendly embeds; other links play directly or open in a new tab. */
export function embedUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtube.com' && u.pathname === '/watch' && u.searchParams.get('v')) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.searchParams.get('v')!)}`;
    if (host === 'youtu.be' && u.pathname.length > 1) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.pathname.slice(1))}`;
    if (host === 'youtube.com' && u.pathname.startsWith('/embed/')) return `https://www.youtube-nocookie.com${u.pathname}`;
    if (host === 'vimeo.com' && /^\/\d+$/.test(u.pathname)) return `https://player.vimeo.com/video${u.pathname}`;
    if (host === 'player.vimeo.com') return url;
    return null;
  } catch {
    return null;
  }
}

/**
 * The one content item of a course made with the simple course form (title, format and link) or before learning
 * modules: the link as a video, document or external item, or the description as text. The learner marks it done
 * (classroom attendance is confirmed by a manager or HR).
 */
export function legacyCourseBlocks(c: { title: string; description?: string | null; format: string; content_url?: string | null; duration_minutes?: number | null }): ContentBlock[] {
  const base = { id: 'course', title: c.title.slice(0, 200), description: (c.description ?? '').slice(0, 4000), required: true };
  const url = c.content_url && /^https:\/\//.test(c.content_url) ? c.content_url : null;
  if (url && c.format === 'video') return [{ ...base, kind: 'video', source: { type: 'url', url }, durationMinutes: c.duration_minutes ?? null, coverFileId: null, completion: 'manual', minPercent: 90 }];
  if (url && c.format === 'document') return [{ ...base, kind: 'document', source: { type: 'url', url }, coverFileId: null, completion: 'manual' }];
  if (url) return [{ ...base, kind: 'external', url, completion: 'manual' }];
  return [{ ...base, kind: 'text', body: '', attachmentFileIds: [], completion: 'manual' }];
}

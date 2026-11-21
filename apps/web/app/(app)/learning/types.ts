import type { AssignmentSettings, BlockSource, BlockState, ContentBlock, DueState, LearnerQuestion, LearnerStatus, LearningCap, SubmissionStatus } from '@crew/contracts';

export interface LearningAccessView {
  level: 'super' | 'hr' | 'employee';
  manager: boolean;
  caps: Record<LearningCap, boolean>;
  scopes: { key: string; name: string; caps: LearningCap[] }[];
  learner: boolean;
}

export interface Creator { name: string | null; designation: string | null; workspace: string }

export interface LearningOptions {
  categories: string[];
  customCategories: { id: string; name: string }[];
  skills: string[];
  languages: string[];
  departments: { id: string; name: string }[];
  designations: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  hrWorkspaces: { id: string; name: string }[];
  canAssignCentral: boolean;
  people: { id: string; name: string; code: string; hrWorkspaceId: string | null }[];
}

export interface ModuleSummary {
  id: string; title: string; shortDescription: string; category: string; topic: string; skills: string[]; difficulty: string; customDifficulty: string | null;
  durationMinutes: number | null; format: string; status: 'draft' | 'scheduled' | 'published' | 'archived'; version: number; unpublishedChanges: boolean;
  publishedAt: string | null; publishAt: string | null; coverFileId: string | null; tags: string[]; language: string; selfEnrol: boolean; certificate: boolean;
  creator: Creator; createdAt: string; contentKinds: string[]; blockCount: number; assigned: number; completed: number; completionRate: number | null;
  can: { edit: boolean; publish: boolean; assign: boolean };
}

export interface ModuleDetail extends ModuleSummary {
  description: string; customDifficulty: string; creatorName: string; creatorDesignation: string; defaultDueDays: number | null; hrWorkspaceId: string | null;
  blocks: ContentBlock[];
  versions: { version: number; note: string; publishedAt: string; title: string }[];
  audiences: { id: string; description: string; dueOn: string | null; keepEnrolling: boolean; active: boolean; enrolled: number; createdAt: string }[];
}

export interface MyItem {
  id: string; moduleId: string; title: string; shortDescription: string; category: string; difficulty: string; durationMinutes: number | null; coverFileId: string | null;
  format: string; creator: Creator; assignedBy: string | null; publishedAt: string | null; version: number; status: LearnerStatus; dueOn: string | null;
  due: { state: DueState; daysLeft: number | null }; progressPercent: number; scorePercent: number | null; passed: boolean | null; completedOn: string | null;
  certificateNo: string | null; itemCount: number; newerVersion: boolean;
}

export interface MyLearning {
  items: MyItem[];
  available: { id: string; title: string; shortDescription: string; category: string; difficulty: string; durationMinutes: number | null; format: string; coverFileId: string | null; creator: Creator; skills: string[] }[];
  summary: { total: number; notStarted: number; inProgress: number; completed: number; overdue: number; averageScore: number | null; timeSpentMinutes: number };
}

export interface Attempt { id: string; attemptNo: number; status: string; percent: number | null; passed: boolean | null; submittedAt: string | null; deadlineAt: string | null }
export interface Submission {
  id: string; status: SubmissionStatus; text: string; link: string | null; fileIds: string[]; score: number | null; passed: boolean | null; feedback: string | null;
  reviewer: string | null; submittedAt: string | null; reviewedAt: string | null;
}

export interface PlayerBlock {
  id: string; kind: ContentBlock['kind']; title: string; description: string; required: boolean; state: BlockState;
  body?: string; attachmentFileIds?: string[]; completion?: string; source?: BlockSource; embed?: string | null; durationMinutes?: number | null; minPercent?: number;
  caption?: string; url?: string; questionCount?: number; totalMarks?: number;
  settings?: Partial<AssignmentSettings> & { passPercent?: number; maxAttempts?: number; timeLimitMinutes?: number; allowRetake?: boolean; showScore?: boolean; showCorrectAnswers?: boolean; finalAssessment?: boolean };
  attempts?: Attempt[]; submissions?: Submission[];
}

export interface PlayerView {
  id: string; moduleId: string; title: string; description: string; category: string; difficulty: string; durationMinutes: number | null; language: string; skills: string[];
  coverFileId: string | null; creator: Creator; publishedAt: string | null; assignedBy: string | null; assignedOn: string | null; version: number; status: LearnerStatus;
  dueOn: string | null; due: { state: DueState; daysLeft: number | null }; progressPercent: number; done: string[]; remaining: string[]; scorePercent: number | null;
  passed: boolean | null; completedOn: string | null; completedAt: string | null; certificateNo: string | null; timeSpentMinutes: number; classroom: boolean; blocks: PlayerBlock[];
}

export interface AttemptStart { attemptId: string; attemptNo: number; deadlineAt: string | null; questions: LearnerQuestion[]; answers: Record<string, string | string[]> }
export interface AttemptResult {
  attemptNo: number; late: boolean; pendingReview: boolean; percent: number | null; passed: boolean | null; passPercent: number; earned: number | null; total: number;
  questions: { id: string; text: string; correct: boolean | null; earned: number; marks: number; explanation: string; answer: string[] }[] | null;
  enrolment: PlayerView;
}

export interface Certificate {
  employeeName: string; employeeCode: string | null; moduleTitle: string; version: number; completedOn: string; completedAt: string | null; scorePercent: number | null;
  passed: boolean | null; certificateNo: string | null; issuedBy: string; creator: Creator; durationMinutes: number | null; timeSpentMinutes: number;
}

export interface EnrolmentRow {
  id: string; moduleId: string; moduleTitle: string; version: number; employeeId: string; employeeName: string; employeeCode: string; hrWorkspace: string | null;
  hrWorkspaceId: string | null; department: string | null; designation: string | null; status: LearnerStatus; rawStatus: string; progressPercent: number;
  scorePercent: number | null; passed: boolean | null; dueOn: string | null; due: { state: DueState; daysLeft: number | null }; assignedOn: string | null;
  completedOn: string | null; completedAt: string | null; timeSpentMinutes: number; certificateNo: string | null; source: string;
}

export interface Tally { assigned: number; completed: number; inProgress: number; notStarted: number; overdue: number; averageScore: number | null; completionRate: number | null }
export type Group = Tally & { name: string };

export interface LearningDashboard extends Tally {
  scope: string;
  modules: { total: number; published: number; draft: number; scheduled: number; archived: number };
  learners: number; pendingSubmissions: number; pendingQuizReviews: number;
  split: { completed: number | null; inProgress: number | null; notStarted: number | null; overdue: number | null };
  byHrWorkspace: Group[]; byDepartment: Group[]; byDesignation: Group[]; byModule: Group[];
  quizResults: { module: string; quiz: string; attempts: number; averagePercent: number | null; passRate: number | null }[];
  recentCompletions: EnrolmentRow[]; overdueList: EnrolmentRow[];
}

export interface ReviewSubmission {
  id: string; enrolmentId: string; employeeId: string; employeeName: string; employeeCode: string; hrWorkspace: string; department: string | null; moduleTitle: string;
  assignmentTitle: string; settings: AssignmentSettings | null; status: SubmissionStatus; text: string; link: string | null; fileIds: string[]; score: number | null;
  passed: boolean | null; feedback: string | null; reviewer: string | null; submittedAt: string | null; reviewedAt: string | null;
}

export interface PendingAttempt {
  id: string; employeeName: string; hrWorkspace: string; moduleTitle: string; quizTitle: string; attemptNo: number; submittedAt: string | null;
  questions: { id: string; text: string; marks: number; answer: string }[];
}

export interface PermissionRow { hrWorkspaceId: string | null; name: string; status: string; employees: number; caps: LearningCap[]; customised: boolean; updatedAt: string | null }

export interface LearnerProfile {
  employee: { id: string; name: string; code: string; department: string | null; designation: string | null; hrWorkspace: string; level: string; status: string };
  summary: Tally & { cancelled: number; timeSpentMinutes: number };
  rows: EnrolmentRow[];
}

export interface EnrolmentDetail extends EnrolmentRow {
  items: { id: string; kind: string; title: string; required: boolean; state: BlockState; attempts: { id: string; attemptNo: number; status: string; percent: number | null; passed: boolean | null; submittedAt: string | null }[]; submissions: { id: string; status: string; score: number | null; submittedAt: string | null }[] }[];
  certificate: Certificate | null;
}

/** The views of My learning (a plain module, so server pages can read the list). */
export const MY_TABS = ['all', 'not_started', 'in_progress', 'completed', 'overdue', 'library'] as const;
export type MyTab = (typeof MY_TABS)[number];

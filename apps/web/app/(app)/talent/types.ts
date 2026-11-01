export interface Goal {
  id: string;
  employeeId: string;
  employeeName: string;
  title: string;
  description: string;
  periodStart: string;
  periodEnd: string;
  weight: number;
  status: 'active' | 'completed' | 'cancelled';
  progress: number;
  confidence: 'on_track' | 'at_risk' | 'off_track' | null;
  lastCheckinAt: string | null;
  parentGoalId: string | null;
  keyResultCount: number;
}
export interface KeyResult { id: string; title: string; startValue: string; targetValue: string; currentValue: string; unit: string; progress: number }
export interface Checkin { id: string; progress: number; confidence: string; note: string; values: { keyResultId: string; title: string; from: string; to: string }[]; createdAt: string; byName: string }
export interface GoalDetail extends Goal {
  keyResults: KeyResult[];
  checkins: Checkin[];
  parent: { id: string; title: string; employeeName: string } | null;
  children: { id: string; title: string; progress: number; status: string; employeeName: string }[];
  can: { manage: boolean; reopen: boolean };
}
export interface Alignable { id: string; title: string; employeeName: string; periodEnd: string }

export interface Question { id: string; text: string }
export interface Level { value: number; label: string }
export interface CycleSummary {
  id: string; name: string; status: 'draft' | 'active' | 'calibration' | 'released'; periodStart: string; periodEnd: string; selfReview: boolean; peerFeedback: boolean;
  legalEntityName: string | null; departmentName: string | null; selfDue: string | null; managerDue: string | null; participants: number; managerDone: number; selfDone: number;
}
export interface Distribution { levels: (Level & { count: number; percent: number })[]; unrated: number; total: number }
export interface CycleReviewRow {
  id: string; employeeId: string; employeeName: string; employeeCode: string; departmentName: string | null; managerEmployeeId: string | null; managerName: string | null;
  selfStatus: string; managerStatus: string; selfRating: number | null; managerRating: number | null; finalRating: number | null; excluded: boolean; excludedReason: string | null;
  acknowledgedAt: string | null; peerSubmitted: number; peerRequested: number; calibrationChanges: number;
}
export interface CycleDetail extends Omit<CycleSummary, 'participants' | 'managerDone' | 'selfDone'> {
  questions: Question[]; ratingScale: Level[]; legalEntityId: string | null; departmentId: string | null;
  launchedAt: string | null; calibrationStartedAt: string | null; releasedAt: string | null;
  reviews: CycleReviewRow[]; distribution: { manager: Distribution; final: Distribution }; preview?: { id: string; name: string; manager_employee_id: string | null; manager_name: string | null }[];
}
export interface ReviewListItem {
  id: string; cycleId: string; cycleName: string; cycleStatus: string; employeeName: string; managerName: string | null; selfReview: boolean; selfStatus: string; managerStatus: string;
  excluded: boolean; selfDue: string | null; managerDue: string | null; finalRating: number | null; releasedAt: string | null; acknowledgedAt: string | null;
}
export interface FeedbackListItem { id: string; status: string; reviewId: string; employeeName: string; cycleName: string; cycleStatus: string; requestedAt: string; submittedAt: string | null }
export interface ReviewDetail {
  id: string; employeeId: string; employeeName: string; managerEmployeeId: string | null; managerName: string | null;
  selfStatus: string; selfAnswers: Record<string, string>; selfRating: number | null; selfSubmittedAt: string | null;
  managerStatus: string; managerAnswers: Record<string, string>; managerRating: number | null; managerSubmittedAt: string | null;
  finalRating: number | null; excluded: boolean; excludedReason: string | null; releasedAt: string | null; acknowledgedAt: string | null; employeeComment: string | null;
  cycle: { id: string; name: string; status: string; questions: Question[]; ratingScale: Level[]; selfReview: boolean; peerFeedback: boolean; periodStart: string; periodEnd: string };
  role: 'employee' | 'manager' | 'hr' | 'viewer';
  peer:
    | { shown: false; reason: string }
    | { shown: true; answers: (Question & { comments: string[] })[] }
    | { shown: true; requests: { id: string; reviewerEmployeeId: string; reviewerName: string; status: string; answers: Record<string, string>; submittedAt: string | null }[] };
  peerQuestions: Question[];
  calibrations: { fromRating: number | null; toRating: number; reason: string; createdAt: string; byName: string }[];
  goals: { id: string; title: string; progress: number; status: string; weight: number }[];
  can: { writeSelf: boolean; writeManager: boolean; requestFeedback: boolean; calibrate: boolean; exclude: boolean; acknowledge: boolean };
}
export interface FeedbackForm { id: string; status: string; employeeName: string; cycleName: string; answers: Record<string, string>; questions: Question[]; can: { write: boolean }; notice: string }
export interface Colleague { id: string; name: string; departmentName: string | null }

export interface Course {
  id: string; title: string; description: string; format: 'online' | 'video' | 'document' | 'classroom'; contentUrl: string | null; durationMinutes: number | null;
  validityMonths: number | null; category: string; selfEnrol: boolean; archivedAt: string | null; myStatus: string | null; completions: number;
}
export interface LearningPath { id: string; title: string; description: string; courses: { id: string; title: string; format: string; durationMinutes: number | null }[] }
export interface Assignment {
  id: string; employeeId: string; employeeName: string; courseId: string; courseTitle: string; format: string; contentUrl: string | null; durationMinutes: number | null;
  pathId: string | null; pathTitle: string | null; source: 'assigned' | 'self_enrolled'; dueOn: string | null; status: 'assigned' | 'in_progress' | 'completed' | 'cancelled';
  startedAt: string | null; completedOn: string | null; completionNote: string | null; expiresOn: string | null; createdAt: string; overdue: boolean; expired: boolean;
}

export type SurveyKind = 'scale' | 'enps' | 'text';
export interface SurveyQuestionDef { id: string; kind: SurveyKind; text: string }
export interface SurveySummary {
  id: string; title: string; status: 'draft' | 'open' | 'closed'; minResponses: number; closesOn: string | null; legalEntityName: string | null; departmentName: string | null;
  openedAt: string | null; closedAt: string | null; questions: number; invited: number; responded: number;
}
export interface SurveyDetail { id: string; title: string; description: string; status: string; minResponses: number; questions: SurveyQuestionDef[]; legalEntityId: string | null; departmentId: string | null; closesOn: string | null }
export interface MySurvey { id: string; title: string; description: string; status: string; closesOn: string | null; responded: boolean; questions: number }
export interface SurveyForm { id: string; title: string; description: string; status: string; questions: SurveyQuestionDef[]; closesOn: string | null; responded: boolean; notice: string }
export interface QuestionResult { id: string; kind: SurveyKind; text: string; answered: number; average?: number | null; distribution?: { value: number; count: number }[]; enps?: number | null; comments?: string[] }
export type SurveyResults = { id: string; title: string; minResponses: number; invited: number; responded: number; notice: string } & (
  | { shown: false; reason: string }
  | {
      shown: true;
      questions: QuestionResult[];
      breakdown: { shown: false; reason: string } | { shown: true; groups: { label: string; count: number; questions: { id: string; average: number | null; enps?: number | null }[] }[] };
    }
);

export interface Recognition {
  id: string; fromEmployeeId: string; fromName: string; toEmployeeId: string; toName: string; toDepartmentName: string | null; valueName: string | null; message: string;
  createdAt: string; hiddenAt?: string | null; hiddenReason?: string | null;
}
export interface CompanyValue { id: string; name: string; description: string; archivedAt: string | null }

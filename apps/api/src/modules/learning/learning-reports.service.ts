import { Injectable } from '@nestjs/common';
import { gradeQuiz, type LearningCap, type LearningReportQuery, type QuizAnswers, type SubmissionStatus } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { foldQuiz, certificateView } from './learner.service';
import { CENTRAL, learningAccess, type LearningAccess } from './learning-access';
import { type Doc, enrolmentRow, type EnrolmentRow, placements, recompute, today, versionOf } from './learning-common';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((n, x) => n + x, 0) / xs.length) * 10) / 10 : null);

function tally(rows: EnrolmentRow[]) {
  const live = rows.filter((r) => r.status !== 'cancelled');
  const completed = live.filter((r) => r.status === 'completed').length;
  const scores = live.filter((r) => r.status === 'completed' && r.scorePercent !== null).map((r) => r.scorePercent!);
  return {
    assigned: live.length, completed, inProgress: live.filter((r) => r.status === 'in_progress').length, notStarted: live.filter((r) => r.status === 'not_started').length,
    overdue: live.filter((r) => r.status === 'overdue').length, averageScore: avg(scores), completionRate: pct(completed, live.length),
  };
}

function groupBy(rows: EnrolmentRow[], key: (r: EnrolmentRow) => string | null, empty: string) {
  const m = new Map<string, EnrolmentRow[]>();
  for (const r of rows) m.set(key(r) ?? empty, [...(m.get(key(r) ?? empty) ?? []), r]);
  return [...m.entries()].map(([name, list]) => ({ name, ...tally(list) })).sort((a, b) => b.assigned - a.assigned || a.name.localeCompare(b.name));
}

/**
 * Learning dashboards, reports and the Excel export, an employee's learning profile, and the review queues
 * (assignment submissions and quiz answers marked by hand). Everything is worked out from the enrolment, attempt and
 * submission records each time, and only for the people the caller's Learning powers reach.
 */
@Injectable()
export class LearningReportsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async access(tx: TenantTx) {
    return learningAccess(tx, await this.authz.subject(tx));
  }

  /** Enrolment rows the caller's `cap` reaches, with the report filters applied. */
  private async rows(tx: TenantTx, a: LearningAccess, cap: LearningCap, q: Partial<LearningReportQuery> = {}): Promise<EnrolmentRow[]> {
    const people: Doc = { ...a.peopleFilter(cap) };
    if (q.employeeId) people.id = q.employeeId;
    if (q.departmentId) people.current_department_id = q.departmentId;
    if (q.designationId) people.current_designation_id = q.designationId;
    if (q.hrWorkspaceId) people.hr_workspace_id = q.hrWorkspaceId === CENTRAL ? null : q.hrWorkspaceId;
    const ids = await tx.collection('employees').distinct<string>('id', people);
    const filter: Doc = { employee_id: { $in: ids }, status: { $ne: 'cancelled' } };
    if (q.moduleId) filter.course_id = q.moduleId;
    const list = await tx.collection('course_assignments').find(filter, { limit: 20_000 });
    const place = await placements(tx, list.map((r) => r.employee_id));
    const courses = new Map((await tx.collection('courses').find({ id: { $in: [...new Set(list.map((r) => r.course_id))] } }, { projection: { title: 1 } })).map((c) => [c.id as string, c]));
    const now = today();
    let rows = list.map((r) => enrolmentRow(r, courses.get(r.course_id), place.get(r.employee_id), now));
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.from) rows = rows.filter((r) => (r.completedOn ?? r.assignedOn ?? '') >= q.from!);
    if (q.to) rows = rows.filter((r) => (r.completedOn ?? r.assignedOn ?? '') <= q.to!);
    if (q.minScore !== undefined) rows = rows.filter((r) => r.scorePercent !== null && r.scorePercent >= q.minScore!);
    if (q.maxScore !== undefined) rows = rows.filter((r) => r.scorePercent !== null && r.scorePercent <= q.maxScore!);
    if (q.q) {
      const n = q.q.toLowerCase();
      rows = rows.filter((r) => [r.employeeName, r.employeeCode, r.moduleTitle, r.department, r.hrWorkspace].some((x) => String(x ?? '').toLowerCase().includes(n)));
    }
    return rows.sort((x, y) => x.employeeName.localeCompare(y.employeeName) || x.moduleTitle.localeCompare(y.moduleTitle));
  }

  dashboard() {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('view');
      const rows = await this.rows(tx, a, 'view');
      const moduleFilter: Doc = a.isSuper ? {} : { $or: [{ id: { $in: [...new Set(rows.map((r) => r.moduleId))] } }, { creator_level: 'hr', owner_hr_workspace_id: { $in: a.scopes.map((s) => (s.key === CENTRAL ? null : s.key)) } }] };
      const modules = await tx.collection('courses').find(moduleFilter, { projection: { status: 1, title: 1 } });
      const t = tally(rows);
      const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
      const assignmentIds = rows.map((r) => r.id);
      const pendingSubmissions = await tx.collection('learning_submissions').count({ assignment_id: { $in: assignmentIds }, status: 'submitted' });
      const pendingQuizReviews = await tx.collection('learning_quiz_attempts').count({ assignment_id: { $in: assignmentIds }, status: 'pending_review' });
      const attempts = await tx.collection('learning_quiz_attempts').find({ assignment_id: { $in: assignmentIds }, status: 'graded' }, { projection: { assignment_id: 1, block_id: 1, percent: 1, passed: 1 } });
      const byQuiz = new Map<string, { module: string; block: string; scores: number[]; passed: number }>();
      const moduleOf = new Map(rows.map((r) => [r.id, r]));
      for (const x of attempts) {
        const r = moduleOf.get(x.assignment_id)!;
        const k = `${r.moduleId}:${x.block_id}`;
        const e = byQuiz.get(k) ?? { module: r.moduleTitle, block: x.block_id, scores: [] as number[], passed: 0 };
        e.scores.push(Number(x.percent ?? 0));
        if (x.passed) e.passed++;
        byQuiz.set(k, e);
      }
      const titles = new Map<string, string>();
      for (const k of byQuiz.keys()) {
        const [moduleId, blockId] = k.split(':') as [string, string];
        const c = await tx.collection('courses').findOne({ id: moduleId }, { projection: { blocks: 1 } });
        const b = (c?.blocks as Doc[] | undefined)?.find((x) => x.id === blockId);
        titles.set(k, (b?.title as string) ?? blockId);
      }
      return {
        scope: a.isSuper ? 'Super Workspace' : a.scopes.map((s) => s.name).join(', '),
        modules: { total: modules.length, published: modules.filter((m) => m.status === 'published').length, draft: modules.filter((m) => m.status === 'draft').length, scheduled: modules.filter((m) => m.status === 'scheduled').length, archived: modules.filter((m) => m.status === 'archived').length },
        learners: employeeIds.length, ...t, pendingSubmissions, pendingQuizReviews,
        split: { completed: pct(t.completed, t.assigned), inProgress: pct(t.inProgress, t.assigned), notStarted: pct(t.notStarted, t.assigned), overdue: pct(t.overdue, t.assigned) },
        byHrWorkspace: groupBy(rows, (r) => r.hrWorkspace, 'Central group'),
        byDepartment: groupBy(rows, (r) => r.department, 'No department'),
        byDesignation: groupBy(rows, (r) => r.designation, 'No job role'),
        byModule: groupBy(rows, (r) => r.moduleTitle, '').slice(0, 15),
        quizResults: [...byQuiz.entries()].map(([k, v]) => ({ module: v.module, quiz: titles.get(k) ?? v.block, attempts: v.scores.length, averagePercent: avg(v.scores), passRate: pct(v.passed, v.scores.length) })).sort((x, y) => y.attempts - x.attempts).slice(0, 10),
        recentCompletions: rows.filter((r) => r.status === 'completed').sort((x, y) => String(y.completedAt ?? y.completedOn).localeCompare(String(x.completedAt ?? x.completedOn))).slice(0, 10),
        overdueList: rows.filter((r) => r.status === 'overdue').sort((x, y) => String(x.dueOn).localeCompare(String(y.dueOn))).slice(0, 10),
      };
    });
  }

  report(q: LearningReportQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('reports');
      const rows = await this.rows(tx, a, 'reports', q);
      return { rows: rows.slice(0, 2000), total: rows.length, summary: tally(rows), canExport: a.has('export') };
    });
  }

  /** A module's learners the caller can see. */
  moduleLearners(moduleId: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('view');
      const rows = await this.rows(tx, a, 'view', { moduleId });
      return { rows, total: rows.length, summary: tally(rows), canExport: a.has('export') && a.has('reports') };
    });
  }

  /** By HR Workspace, department and job role, for the Super Workspace and HR. */
  workspaces() {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('reports');
      const rows = await this.rows(tx, a, 'reports');
      return { byHrWorkspace: groupBy(rows, (r) => r.hrWorkspace, 'Central group'), byDepartment: groupBy(rows, (r) => r.department, 'No department'), byDesignation: groupBy(rows, (r) => r.designation, 'No job role') };
    });
  }

  exportRows(q: LearningReportQuery) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('export');
      // The export is limited to what the reports show this person: both checks apply.
      a.require('reports');
      const rows = await this.rows(tx, a, 'export', q);
      const reportable = new Set((await this.rows(tx, a, 'reports', q)).map((r) => r.id));
      const out = rows.filter((r) => reportable.has(r.id));
      const subs = await tx.collection('learning_submissions').find({ assignment_id: { $in: out.map((r) => r.id) } }, { sort: { created_at: 1 }, projection: { assignment_id: 1, status: 1 } });
      const lastSub = new Map(subs.map((x) => [x.assignment_id as string, x.status as SubmissionStatus]));
      const tries = new Map<string, number>();
      for (const t of await tx.collection('learning_quiz_attempts').find({ assignment_id: { $in: out.map((r) => r.id) }, status: { $ne: 'in_progress' } }, { projection: { assignment_id: 1 } })) tries.set(t.assignment_id, (tries.get(t.assignment_id) ?? 0) + 1);
      await this.audit.record(tx, { action: 'learning.report_exported', resourceType: 'learning_report', metadata: { rows: out.length, filters: q } });
      const header = ['Employee', 'Employee ID', 'HR Workspace', 'Department', 'Job role', 'Learning module', 'Version', 'Status', 'Progress %', 'Score %', 'Passed', 'Assignment status', 'Quiz attempts', 'Assigned on', 'Due date', 'Completed on', 'Time spent (min)', 'Certificate'];
      const label: Record<string, string> = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed', overdue: 'Overdue' };
      const subLabel: Record<string, string> = { submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', resubmit: 'Resubmission requested' };
      return [header, ...out.map((r) => [
        r.employeeName, r.employeeCode, r.hrWorkspace ?? 'Central group', r.department ?? '', r.designation ?? '', r.moduleTitle, r.version, label[r.status] ?? r.status, r.progressPercent,
        r.scorePercent ?? '', r.passed === null ? '' : r.passed ? 'Yes' : 'No', lastSub.get(r.id) ? subLabel[lastSub.get(r.id)!] : '', tries.get(r.id) ?? 0,
        r.assignedOn ?? '', r.dueOn ?? '', r.completedOn ?? '', r.timeSpentMinutes, r.certificateNo ?? '',
      ])];
    });
  }

  /** One employee's learning: totals and every module, including finished earlier versions. */
  learner(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const e = await tx.collection('employees').findOne({ id: employeeId });
      if (!e || !a.covers('view', e)) throw Errors.notFound('Employee');
      const rows = await this.rows(tx, a, 'view', { employeeId });
      const cancelled = await tx.collection('course_assignments').count({ employee_id: employeeId, status: 'cancelled' });
      const p = (await placements(tx, [employeeId])).get(employeeId)!;
      return {
        employee: { id: p.id, name: p.name, code: p.code, department: p.department, designation: p.designation, hrWorkspace: p.hrWorkspace ?? 'Central group', level: 'Employee Workspace', status: p.status },
        summary: { ...tally(rows), cancelled, timeSpentMinutes: rows.reduce((n, r) => n + r.timeSpentMinutes, 0) },
        rows,
      };
    });
  }

  /** One learner's enrolment in detail, for HR: per item progress, attempts and submissions. */
  enrolment(id: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      const row = await tx.collection('course_assignments').findOne({ id });
      const e = row && (await tx.collection('employees').findOne({ id: row.employee_id }));
      if (!row || !e || !a.covers('view', e)) throw Errors.notFound('Enrolment');
      const v = await versionOf(tx, row);
      const c = await tx.collection('courses').findOne({ id: row.course_id }, { projection: { title: 1 } });
      const p = (await placements(tx, [row.employee_id])).get(row.employee_id);
      const attempts = await tx.collection('learning_quiz_attempts').find({ assignment_id: id }, { sort: { attempt_no: 1 } });
      const subs = await tx.collection('learning_submissions').find({ assignment_id: id }, { sort: { created_at: 1 } });
      return {
        ...enrolmentRow(row, c, p),
        items: v.blocks.map((b) => ({
          id: b.id, kind: b.kind, title: b.title, required: b.required, state: (row.progress ?? {})[b.id] ?? { done: false },
          attempts: attempts.filter((t) => t.block_id === b.id).map((t) => ({ id: t.id as string, attemptNo: t.attempt_no as number, status: t.status as string, percent: num(t.percent), passed: t.passed ?? null, submittedAt: iso(t.submitted_at) })),
          submissions: subs.filter((s) => s.block_id === b.id).map((s) => ({ id: s.id as string, status: s.status as string, score: num(s.score), submittedAt: iso(s.created_at) })),
        })),
        certificate: row.status === 'completed' ? await certificateView(tx, row) : null,
      };
    });
  }

  // Review queues -------------------------------------------------------------------------------------------------

  submissions(status: SubmissionStatus | 'all') {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('grade');
      const people = await tx.collection('employees').distinct<string>('id', a.peopleFilter('grade'));
      const list = await tx.collection('learning_submissions').find({ employee_id: { $in: people }, ...(status === 'all' ? {} : { status }) }, { sort: { created_at: status === 'submitted' ? 1 : -1 }, limit: 500 });
      const place = await placements(tx, list.map((x) => x.employee_id));
      const reviewers = await membershipUserNames(tx, list.map((x) => x.reviewed_by_membership_id));
      const enrolments = new Map((await tx.collection('course_assignments').find({ id: { $in: list.map((x) => x.assignment_id) } })).map((r) => [r.id as string, r]));
      return Promise.all(list.map(async (x) => {
        const enr = enrolments.get(x.assignment_id)!;
        const v = await versionOf(tx, enr);
        const b = v.blocks.find((k) => k.id === x.block_id);
        const p = place.get(x.employee_id);
        return {
          id: x.id as string, enrolmentId: x.assignment_id as string, employeeId: x.employee_id as string, employeeName: p?.name ?? '', employeeCode: p?.code ?? '', hrWorkspace: p?.hrWorkspace ?? 'Central group',
          department: p?.department ?? null, moduleTitle: v.title, assignmentTitle: b?.title ?? x.block_id, settings: b?.kind === 'assignment' ? b.settings : null,
          status: x.status as SubmissionStatus, text: x.text as string, link: (x.link as string | null) ?? null, fileIds: (x.file_ids as string[]) ?? [],
          score: num(x.score), passed: (x.passed as boolean | null) ?? null, feedback: (x.feedback as string | null) ?? null,
          reviewer: x.reviewed_by_membership_id ? (reviewers.get(x.reviewed_by_membership_id) ?? null) : null, submittedAt: iso(x.created_at), reviewedAt: iso(x.reviewed_at),
        };
      }));
    });
  }

  review(id: string, input: { decision: 'approved' | 'rejected' | 'resubmit'; score: number | null; feedback: string }) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('grade');
      const x = await tx.collection('learning_submissions').findOne({ id });
      const e = x && (await tx.collection('employees').findOne({ id: x.employee_id }));
      if (!x || !e || !a.covers('grade', e)) throw Errors.notFound('Submission');
      if (x.status !== 'submitted') throw Errors.conflict('already_reviewed', 'This submission was already reviewed');
      await tx.collection('course_assignments').lock({ id: x.assignment_id });
      const enr = (await tx.collection('course_assignments').findOne({ id: x.assignment_id }))!;
      const v = await versionOf(tx, enr);
      const b = v.blocks.find((k) => k.id === x.block_id);
      if (b?.kind !== 'assignment') throw Errors.notFound('Assignment');
      let passed: boolean | null = null;
      if (input.decision !== 'resubmit') {
        if (b.settings.gradingMethod === 'score') {
          if (input.score === null) throw Errors.validation([{ path: 'score', message: `Give a score out of ${b.settings.maxScore}` }]);
          if (input.score > b.settings.maxScore) throw Errors.validation([{ path: 'score', message: `The score can be at most ${b.settings.maxScore}` }]);
          passed = input.score >= b.settings.passScore;
          if (input.decision === 'approved' && !passed) throw Errors.validation([{ path: 'score', message: `The passing score is ${b.settings.passScore}: reject it or ask for a resubmission` }]);
        } else passed = input.decision === 'approved';
      }
      await tx.collection('learning_submissions').updateOne({ id }, {
        $set: { status: input.decision, score: input.decision === 'resubmit' ? null : input.score, passed, feedback: input.feedback || null, reviewed_at: new Date(), reviewed_by_membership_id: a.subject.membershipId },
      });
      const prev = { done: false, ...((enr.progress ?? {})[b.id] ?? {}) };
      if (['assigned', 'in_progress'].includes(enr.status)) {
        await recompute(tx, this.notifications, enr, { progress: { [b.id]: { ...prev, submission: input.decision, done: input.decision === 'approved', doneAt: input.decision === 'approved' ? new Date().toISOString() : undefined } } });
      }
      const words = { approved: 'was approved', rejected: 'was not passed', resubmit: 'needs to be resubmitted' }[input.decision];
      if (e.membership_id) {
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id], kind: input.decision === 'resubmit' ? 'learning.resubmit' : 'learning.reviewed', priority: input.decision === 'resubmit' ? 'high' : 'normal',
          title: `Your assignment "${b.title}" ${words}${input.score !== null && input.decision !== 'resubmit' ? ` (${input.score}/${b.settings.maxScore})` : ''}`,
          body: input.feedback || undefined, link: `/learning/my/${enr.id}`, actorMembershipId: a.subject.membershipId,
        });
      }
      await this.audit.record(tx, { action: 'learning.submission_reviewed', resourceType: 'learning_submission', resourceId: id, metadata: { decision: input.decision, score: input.score } });
      return { status: input.decision };
    });
  }

  /** Quiz attempts with short or long answers waiting for marks. */
  pendingAttempts() {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('grade');
      const people = await tx.collection('employees').distinct<string>('id', a.peopleFilter('grade'));
      const list = await tx.collection('learning_quiz_attempts').find({ employee_id: { $in: people }, status: 'pending_review' }, { sort: { submitted_at: 1 }, limit: 200 });
      const place = await placements(tx, list.map((x) => x.employee_id));
      const enrolments = new Map((await tx.collection('course_assignments').find({ id: { $in: list.map((x) => x.assignment_id) } })).map((r) => [r.id as string, r]));
      return Promise.all(list.map(async (t) => {
        const v = await versionOf(tx, enrolments.get(t.assignment_id)!);
        const b = v.blocks.find((k) => k.id === t.block_id);
        const answers = (t.answers ?? {}) as QuizAnswers;
        return {
          id: t.id as string, employeeName: place.get(t.employee_id)?.name ?? '', hrWorkspace: place.get(t.employee_id)?.hrWorkspace ?? 'Central group', moduleTitle: v.title, quizTitle: b?.title ?? t.block_id,
          attemptNo: t.attempt_no as number, submittedAt: iso(t.submitted_at),
          questions: b?.kind === 'quiz' ? b.questions.filter((q) => q.type === 'short' || q.type === 'long').map((q) => ({ id: q.id, text: q.text, marks: q.marks, answer: typeof answers[q.id] === 'string' ? (answers[q.id] as string) : '' })) : [],
        };
      }));
    });
  }

  gradeAttempt(id: string, marks: Record<string, number>, feedback: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx);
      a.require('grade');
      const t = await tx.collection('learning_quiz_attempts').findOne({ id });
      const e = t && (await tx.collection('employees').findOne({ id: t.employee_id }));
      if (!t || !e || !a.covers('grade', e)) throw Errors.notFound('Attempt');
      if (t.status !== 'pending_review') throw Errors.conflict('already_graded', 'This attempt was already marked');
      await tx.collection('course_assignments').lock({ id: t.assignment_id });
      const enr = (await tx.collection('course_assignments').findOne({ id: t.assignment_id }))!;
      const b = (await versionOf(tx, enr)).blocks.find((k) => k.id === t.block_id);
      if (b?.kind !== 'quiz') throw Errors.notFound('Quiz');
      const manual = b.questions.filter((q) => q.type === 'short' || q.type === 'long');
      for (const q of manual) {
        const m = marks[q.id];
        if (m === undefined) throw Errors.validation([{ path: `marks.${q.id}`, message: 'Give marks for every written answer' }]);
        if (m > q.marks) throw Errors.validation([{ path: `marks.${q.id}`, message: `At most ${q.marks}` }]);
      }
      const r = gradeQuiz(b, (t.answers ?? {}) as QuizAnswers, marks);
      await tx.collection('learning_quiz_attempts').updateOne({ id }, { $set: { manual_marks: marks, result: r, percent: r.percent, passed: r.passed, status: 'graded', graded_at: new Date(), graded_by_membership_id: a.subject.membershipId, feedback: feedback || null } });
      await foldQuiz(tx, this.notifications, enr, b);
      if (e.membership_id) {
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id], kind: 'learning.quiz_result', title: `Your result for ${b.title}: ${r.percent}% (${r.passed ? 'passed' : 'not passed'})`,
          body: feedback || undefined, link: `/learning/my/${enr.id}`, actorMembershipId: a.subject.membershipId,
        });
      }
      await this.audit.record(tx, { action: 'learning.quiz_graded', resourceType: 'course_assignment', resourceId: enr.id, metadata: { attemptId: id, percent: r.percent } });
      return { percent: r.percent, passed: r.passed };
    });
  }
}

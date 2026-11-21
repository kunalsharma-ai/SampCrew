import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type BlockState, type ContentBlock, dueState, embedUrl, gradeQuiz, learnerQuestion, learnerStatus, mediaComplete, moduleProgress, type QuizAnswers, type QuizBlock, seededShuffle,
  type SubmissionStatus,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { displayName } from '../employees/employee-view';
import { needEmployee } from '../talent/talent-common';
import { creatorOf, type Doc, OPEN, ownEnrolment, parseBlocks, recompute, today, versionOf } from './learning-common';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

/** A content item as the learner sees it: quizzes without questions or answers (those come with an attempt). */
function learnerBlock(b: ContentBlock) {
  const base = { id: b.id, kind: b.kind, title: b.title, description: b.description, required: b.required };
  switch (b.kind) {
    case 'text': return { ...base, body: b.body, attachmentFileIds: b.attachmentFileIds, completion: b.completion };
    case 'video': case 'audio':
      return { ...base, source: b.source, embed: b.source.type === 'url' ? embedUrl(b.source.url) : null, durationMinutes: b.durationMinutes, coverFileId: b.coverFileId, completion: b.completion, minPercent: b.minPercent };
    case 'document': case 'presentation': case 'image': return { ...base, source: b.source, completion: b.completion, caption: b.kind === 'image' ? b.caption : undefined };
    case 'external': return { ...base, url: b.url, completion: b.completion };
    case 'quiz': return {
      ...base, questionCount: b.questions.length, totalMarks: b.questions.reduce((n, q) => n + q.marks, 0),
      settings: { passPercent: b.settings.passPercent, maxAttempts: b.settings.maxAttempts, timeLimitMinutes: b.settings.timeLimitMinutes, allowRetake: b.settings.allowRetake, showScore: b.settings.showScore, showCorrectAnswers: b.settings.showCorrectAnswers, finalAssessment: b.settings.finalAssessment },
    };
    case 'assignment': return { ...base, settings: b.settings };
  }
}

/**
 * The learner's side of Learning: what is assigned to them, the module player (content in order, progress that the
 * server works out from what they actually did), quizzes with server-side marking, assignment submissions and the
 * completion certificate. Every call is limited to the caller's own records.
 */
@Injectable()
export class LearnerService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private async me(tx: TenantTx) {
    const s = await this.authz.subject(tx);
    return { s, employeeId: s.employeeId ?? null };
  }

  /** My learning: everything assigned to me with its progress, score and deadline, and what I can enrol in. */
  my() {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      if (!employeeId) return { items: [], available: [], summary: { total: 0, notStarted: 0, inProgress: 0, completed: 0, overdue: 0, averageScore: null, timeSpentMinutes: 0 } };
      const rows = await tx.collection('course_assignments').find({ employee_id: employeeId, status: { $ne: 'cancelled' } }, { sort: { created_at: -1 } });
      const courses = new Map((await tx.collection('courses').find({ id: { $in: [...new Set(rows.map((r) => r.course_id))] } })).map((c) => [c.id as string, c]));
      const by = await membershipUserNames(tx, rows.map((r) => r.assigned_by_membership_id));
      const now = today();
      const items = await Promise.all(rows.map(async (a) => {
        const c = courses.get(a.course_id) ?? {};
        const v = await versionOf(tx, a);
        return {
          id: a.id as string, moduleId: a.course_id as string, title: v.title || (c.title as string), shortDescription: (c.short_description as string) || String(c.description ?? '').slice(0, 200),
          category: c.category as string, difficulty: c.difficulty as string, durationMinutes: (c.duration_minutes as number | null) ?? null, coverFileId: (c.cover_file_id as string | null) ?? null,
          format: c.format as string, creator: await creatorOf(tx, c), assignedBy: a.assigned_by_membership_id ? (by.get(a.assigned_by_membership_id) ?? null) : a.source === 'self_enrolled' ? 'You enrolled' : null,
          publishedAt: iso(c.published_at), version: (a.version as number | null) ?? 1, status: learnerStatus(a.status, a.due_on, now), dueOn: (a.due_on as string | null) ?? null,
          due: dueState(a.due_on, now, a.status === 'completed'), progressPercent: (a.progress_percent as number) ?? 0, scorePercent: num(a.score_percent), passed: (a.passed as boolean | null) ?? null,
          completedOn: (a.completed_on as string | null) ?? null, certificateNo: (a.certificate_no as string | null) ?? null, itemCount: v.blocks.length,
          newerVersion: a.status === 'completed' && (c.version as number) > ((a.version as number | null) ?? 1),
        };
      }));
      const enrolled = new Set(rows.filter((r) => OPEN.includes(r.status)).map((r) => r.course_id));
      const open = await tx.collection('courses').find({ status: 'published', self_enrol: true, id: { $nin: [...enrolled] } }, { sort: { title: 1 }, limit: 200 });
      const available = await Promise.all(open.map(async (c) => ({
        id: c.id as string, title: c.title as string, shortDescription: (c.short_description as string) || String(c.description ?? '').slice(0, 200), category: c.category as string,
        difficulty: c.difficulty as string, durationMinutes: (c.duration_minutes as number | null) ?? null, format: c.format as string, coverFileId: (c.cover_file_id as string | null) ?? null,
        creator: await creatorOf(tx, c), skills: (c.skill_names as string[]) ?? [],
      })));
      const scored = items.filter((i) => i.scorePercent !== null && i.status === 'completed');
      const summary = {
        total: items.length, notStarted: items.filter((i) => i.status === 'not_started').length, inProgress: items.filter((i) => i.status === 'in_progress').length,
        completed: items.filter((i) => i.status === 'completed').length, overdue: items.filter((i) => i.status === 'overdue').length,
        averageScore: scored.length ? Math.round((scored.reduce((n, i) => n + i.scorePercent!, 0) / scored.length) * 10) / 10 : null,
        timeSpentMinutes: Math.round(rows.reduce((n, r) => n + ((r.time_spent_seconds as number) ?? 0), 0) / 60),
      };
      return { items, available, summary };
    });
  }

  enrol(moduleId: string) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      const id = needEmployee(employeeId);
      await this.authz.require('learning:read', { employeeId: id }, tx);
      const c = await tx.collection('courses').findOne({ id: moduleId, status: 'published' });
      if (!c) throw Errors.notFound('Learning module');
      if (!c.self_enrol) throw Errors.forbidden('This learning is assigned by HR');
      const table = tx.collection('course_assignments');
      if (await table.exists({ employee_id: id, course_id: moduleId, status: { $in: OPEN } })) throw Errors.conflict('already_enrolled', 'You already have this learning in progress');
      const r = await table.insert({ employee_id: id, course_id: moduleId, source: 'self_enrolled', status: 'in_progress', started_at: new Date(), version: c.version, version_id: c.published_version_id });
      await this.audit.record(tx, { action: 'learning.enrolled', resourceType: 'course', resourceId: moduleId });
      return { id: r.id as string };
    });
  }

  private async view(tx: TenantTx, a: Doc) {
    const c = (await tx.collection('courses').findOne({ id: a.course_id }))!;
    const v = await versionOf(tx, a);
    const state = (a.progress ?? {}) as Record<string, BlockState>;
    const p = moduleProgress(v.blocks, state);
    const attempts = await tx.collection('learning_quiz_attempts').find({ assignment_id: a.id }, { sort: { attempt_no: 1 } });
    const subs = await tx.collection('learning_submissions').find({ assignment_id: a.id }, { sort: { created_at: 1 } });
    const reviewers = await membershipUserNames(tx, subs.map((x) => x.reviewed_by_membership_id));
    const by = a.assigned_by_membership_id ? (await membershipUserNames(tx, [a.assigned_by_membership_id])).get(a.assigned_by_membership_id) ?? null : null;
    const now = today();
    return {
      id: a.id as string, moduleId: c.id as string, title: v.title, description: c.description as string, category: c.category as string, difficulty: c.difficulty as string,
      durationMinutes: (c.duration_minutes as number | null) ?? null, language: c.language as string, skills: (c.skill_names as string[]) ?? [], coverFileId: (c.cover_file_id as string | null) ?? null,
      creator: await creatorOf(tx, c), publishedAt: iso(c.published_at), assignedBy: by, assignedOn: iso(a.created_at), version: v.version,
      status: learnerStatus(a.status, a.due_on, now), dueOn: (a.due_on as string | null) ?? null, due: dueState(a.due_on, now, a.status === 'completed'),
      progressPercent: p.percent, done: p.done, remaining: p.remaining, scorePercent: num(a.score_percent), passed: (a.passed as boolean | null) ?? null,
      completedOn: (a.completed_on as string | null) ?? null, completedAt: iso(a.completed_at), certificateNo: (a.certificate_no as string | null) ?? null,
      timeSpentMinutes: Math.round(((a.time_spent_seconds as number) ?? 0) / 60), classroom: c.format === 'classroom',
      blocks: v.blocks.map((b) => ({
        ...learnerBlock(b), state: state[b.id] ?? { done: false },
        attempts: b.kind === 'quiz' ? attempts.filter((t) => t.block_id === b.id).map((t) => ({
          id: t.id as string, attemptNo: t.attempt_no as number, status: t.status as string, percent: b.settings.showScore || t.status === 'graded' ? num(t.percent) : null,
          passed: b.settings.showScore || t.status === 'graded' ? ((t.passed as boolean | null) ?? null) : null, submittedAt: iso(t.submitted_at), deadlineAt: iso(t.deadline_at),
        })) : undefined,
        submissions: b.kind === 'assignment' ? subs.filter((x) => x.block_id === b.id).map((x) => ({
          id: x.id as string, status: x.status as SubmissionStatus, text: x.text as string, link: (x.link as string | null) ?? null, fileIds: (x.file_ids as string[]) ?? [],
          score: num(x.score), passed: (x.passed as boolean | null) ?? null, feedback: (x.feedback as string | null) ?? null, reviewer: x.reviewed_by_membership_id ? (reviewers.get(x.reviewed_by_membership_id) ?? null) : null,
          submittedAt: iso(x.created_at), reviewedAt: iso(x.reviewed_at),
        })) : undefined,
      })),
    };
  }

  player(id: string) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      return this.view(tx, await ownEnrolment(tx, id, employeeId));
    });
  }

  private block(blocks: ContentBlock[], blockId: string): ContentBlock {
    const b = blocks.find((x) => x.id === blockId);
    if (!b) throw Errors.notFound('Content item');
    return b;
  }

  /** Records what the learner did with a video, audio, reading or link; the server decides whether it is done. */
  progress(id: string, blockId: string, input: { action: 'open' | 'complete' | 'heartbeat'; position?: number; duration?: number; seconds: number }) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      const table = tx.collection('course_assignments');
      await table.lock({ id });
      const a = await ownEnrolment(tx, id, employeeId);
      if (!OPEN.includes(a.status)) return this.view(tx, a);
      const v = await versionOf(tx, a);
      const b = this.block(v.blocks, blockId);
      if (b.kind === 'quiz' || b.kind === 'assignment') throw Errors.badRequest('wrong_item', 'Quizzes and assignments are finished by submitting them');
      const c = await tx.collection('courses').findOne({ id: a.course_id }, { projection: { format: 1 } });
      const prev: BlockState = { done: false, ...((a.progress ?? {})[blockId] ?? {}) };
      const next: BlockState = { ...prev, openedAt: prev.openedAt ?? new Date().toISOString() };
      const rule = b.completion;
      if (input.action === 'heartbeat' && (b.kind === 'video' || b.kind === 'audio') && input.duration) {
        const pct = Math.min(100, Math.round(((input.position ?? 0) / input.duration) * 100));
        next.percent = Math.max(prev.percent ?? 0, pct);
        if (mediaComplete(rule, b.kind === 'video' || b.kind === 'audio' ? b.minPercent : 100, Math.max(input.position ?? 0, ((prev.percent ?? 0) / 100) * input.duration), input.duration)) next.done = true;
      }
      if (input.action === 'open' && rule === 'open') next.done = true;
      if (input.action === 'complete') {
        if (c?.format === 'classroom') throw Errors.forbidden('Your manager or HR confirms classroom attendance');
        if (rule !== 'manual' && rule !== 'open') throw Errors.badRequest('watch_required', (b.kind === 'video' ? 'Watch' : 'Listen to') + (rule === 'full' ? ' all of it' : ` at least ${'minPercent' in b ? b.minPercent : 90}%`) + ' to complete this item');
        next.done = true;
      }
      if (next.done && !prev.done) next.doneAt = new Date().toISOString();
      const extra: Doc = { progress: { [blockId]: next }, time_spent_seconds: ((a.time_spent_seconds as number) ?? 0) + Math.min(input.seconds, 600) };
      await recompute(tx, this.notifications, a, extra);
      return this.view(tx, (await table.findOne({ id }))!);
    });
  }

  private questionsFor(b: QuizBlock, seed: string) {
    const order = b.settings.randomizeQuestions ? seededShuffle(b.questions, seed) : b.questions;
    return order.map((q) => {
      const view = learnerQuestion(q, (x) => seededShuffle(x, `${seed}:${q.id}:r`));
      return b.settings.randomizeOptions && view.options.length && q.type !== 'true_false' ? { ...view, options: seededShuffle(view.options, `${seed}:${q.id}`) } : view;
    });
  }

  /** Starts a quiz attempt (or returns the one already open), with its questions in this attempt's order. */
  startAttempt(id: string, blockId: string) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      await tx.collection('course_assignments').lock({ id });
      const a = await ownEnrolment(tx, id, employeeId);
      if (!OPEN.includes(a.status)) throw Errors.conflict('finished', 'This learning is already completed');
      const b = this.block((await versionOf(tx, a)).blocks, blockId);
      if (b.kind !== 'quiz') throw Errors.badRequest('not_quiz', 'This item is not a quiz');
      const table = tx.collection('learning_quiz_attempts');
      const open = await table.findOne({ assignment_id: id, block_id: blockId, status: 'in_progress' });
      if (open && (!open.deadline_at || new Date(open.deadline_at).getTime() > Date.now())) {
        return { attemptId: open.id as string, attemptNo: open.attempt_no as number, deadlineAt: iso(open.deadline_at), questions: this.questionsFor(b, open.seed), answers: open.answers ?? {} };
      }
      if (open) await this.finish(tx, a, b, open, (open.answers ?? {}) as QuizAnswers);
      const past = await table.find({ assignment_id: id, block_id: blockId, status: { $ne: 'in_progress' } });
      if (past.some((t) => t.status === 'pending_review')) throw Errors.conflict('pending_review', 'Your last attempt is waiting for a reviewer to mark it');
      if (past.length && !b.settings.allowRetake) throw Errors.conflict('no_retake', 'This quiz can be taken once');
      if (past.some((t) => t.passed) ) throw Errors.conflict('already_passed', 'You have already passed this quiz');
      if (b.settings.maxAttempts && past.length >= b.settings.maxAttempts) throw Errors.conflict('no_attempts_left', `You have used all ${b.settings.maxAttempts} attempts`);
      const seed = randomUUID();
      const deadline = b.settings.timeLimitMinutes ? new Date(Date.now() + b.settings.timeLimitMinutes * 60_000) : null;
      const t = await table.insert({ assignment_id: id, block_id: blockId, employee_id: a.employee_id, attempt_no: past.length + 1, seed, deadline_at: deadline, answers: {}, manual_marks: {} });
      await recompute(tx, this.notifications, a);
      return { attemptId: t.id as string, attemptNo: t.attempt_no as number, deadlineAt: iso(deadline), questions: this.questionsFor(b, seed), answers: {} };
    });
  }

  /** Marks an attempt and folds its result into the learner's progress. */
  private async finish(tx: TenantTx, a: Doc, b: QuizBlock, t: Doc, answers: QuizAnswers) {
    const ids = new Set(b.questions.map((q) => q.id));
    const clean = Object.fromEntries(Object.entries(answers).filter(([k]) => ids.has(k)));
    const r = gradeQuiz(b, clean);
    await tx.collection('learning_quiz_attempts').updateOne({ id: t.id }, {
      $set: { answers: clean, result: r, percent: r.percent, passed: r.passed, status: r.pendingReview ? 'pending_review' : 'graded', submitted_at: new Date() },
    });
    await foldQuiz(tx, this.notifications, a, b);
    return r;
  }

  submitAttempt(id: string, blockId: string, input: { attemptId: string; answers: QuizAnswers }) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      await tx.collection('course_assignments').lock({ id });
      const a = await ownEnrolment(tx, id, employeeId);
      const b = this.block((await versionOf(tx, a)).blocks, blockId);
      if (b.kind !== 'quiz') throw Errors.badRequest('not_quiz', 'This item is not a quiz');
      const t = await tx.collection('learning_quiz_attempts').findOne({ id: input.attemptId, assignment_id: id, block_id: blockId });
      if (!t) throw Errors.notFound('Attempt');
      if (t.status !== 'in_progress') throw Errors.conflict('already_submitted', 'This attempt was already submitted');
      // A little grace for the network; answers after the time limit are not accepted.
      const late = t.deadline_at && Date.now() > new Date(t.deadline_at).getTime() + 30_000;
      const r = await this.finish(tx, a, b, t, late ? ((t.answers ?? {}) as QuizAnswers) : input.answers);
      await this.audit.record(tx, { action: 'learning.quiz_submitted', resourceType: 'course_assignment', resourceId: id, metadata: { blockId, attempt: t.attempt_no, percent: r.percent, passed: r.passed, late: !!late } });
      const showAnswers = b.settings.showCorrectAnswers && !r.pendingReview;
      return {
        attemptNo: t.attempt_no as number, late: !!late, pendingReview: r.pendingReview,
        percent: b.settings.showScore ? r.percent : null, passed: b.settings.showScore ? r.passed : null, passPercent: b.settings.passPercent,
        earned: b.settings.showScore ? r.earned : null, total: r.total,
        questions: showAnswers ? b.questions.map((q) => {
          const res = r.questions.find((x) => x.id === q.id)!;
          return { id: q.id, text: q.text, correct: res.correct, earned: res.earned, marks: res.marks, explanation: q.explanation, answer: q.type === 'matching' ? q.pairs.map((p) => `${p.left} → ${p.right}`) : q.type === 'exact' ? q.accepted.slice(0, 1) : q.correct.map((c) => (q.type === 'true_false' ? (c === 'true' ? 'True' : 'False') : q.options.find((o) => o.id === c)?.text ?? c)) };
        }) : null,
        enrolment: await this.view(tx, (await tx.collection('course_assignments').findOne({ id }))!),
      };
    });
  }

  /** Saves answers so far (an attempt survives a reload or a lost connection). */
  saveAnswers(id: string, blockId: string, input: { attemptId: string; answers: QuizAnswers }) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      await ownEnrolment(tx, id, employeeId);
      const n = await tx.collection('learning_quiz_attempts').updateOne({ id: input.attemptId, assignment_id: id, block_id: blockId, status: 'in_progress' }, { $set: { answers: input.answers } });
      if (!n) throw Errors.conflict('not_open', 'This attempt is closed');
      return { saved: true };
    });
  }

  submit(id: string, blockId: string, input: { text: string; link: string | null; fileIds: string[] }) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      await tx.collection('course_assignments').lock({ id });
      const a = await ownEnrolment(tx, id, employeeId);
      if (!OPEN.includes(a.status)) throw Errors.conflict('finished', 'This learning is already completed');
      const b = this.block((await versionOf(tx, a)).blocks, blockId);
      if (b.kind !== 'assignment') throw Errors.badRequest('not_assignment', 'This item is not an assignment');
      const s = b.settings;
      if (s.startOn && s.startOn > today()) throw Errors.conflict('not_open', `This assignment opens on ${s.startOn}`);
      if (input.text && !s.submissionTypes.includes('text')) throw Errors.badRequest('text_not_allowed', 'This assignment does not take a written response');
      if (input.link && !s.submissionTypes.includes('link')) throw Errors.badRequest('link_not_allowed', 'This assignment does not take a link');
      if (input.fileIds.length && !s.submissionTypes.includes('file')) throw Errors.badRequest('file_not_allowed', 'This assignment does not take files');
      if (input.fileIds.length && (await tx.collection('learning_files').count({ id: { $in: input.fileIds }, purpose: 'submission', employee_id: a.employee_id })) !== new Set(input.fileIds).size) {
        throw Errors.badRequest('unknown_file', 'Upload the files again');
      }
      const last = await tx.collection('learning_submissions').findOne({ assignment_id: id, block_id: blockId }, { sort: { created_at: -1 } });
      if (last?.status === 'submitted') throw Errors.conflict('pending_review', 'Your submission is waiting for review');
      if (last?.status === 'approved') throw Errors.conflict('approved', 'Your submission was already approved');
      if (last?.status === 'rejected') throw Errors.conflict('rejected', 'This assignment was not passed. Ask HR if you can try again.');
      const row = await tx.collection('learning_submissions').insert({ assignment_id: id, block_id: blockId, course_id: a.course_id, employee_id: a.employee_id, text: input.text, link: input.link, file_ids: input.fileIds });
      const prev: BlockState = { done: false, ...((a.progress ?? {})[blockId] ?? {}) };
      await recompute(tx, this.notifications, a, { progress: { [blockId]: { ...prev, submission: 'submitted', attempts: (prev.attempts ?? 0) + 1 } } });
      // Tell whoever made the module that there is something to review.
      const c = await tx.collection('courses').findOne({ id: a.course_id }, { projection: { title: 1, created_by_membership_id: 1 } });
      const e = await tx.collection('employees').findOne({ id: a.employee_id });
      if (c?.created_by_membership_id) {
        await this.notifications.notify(tx, { membershipIds: [c.created_by_membership_id], kind: 'learning.submission', title: `${e ? displayName(e as never) : 'A learner'} submitted ${b.title} (${c.title})`, link: '/learning/manage/reviews', dedupeKey: `learning.submissions:${a.course_id}` });
      }
      await this.audit.record(tx, { action: 'learning.submitted', resourceType: 'learning_submission', resourceId: row.id, metadata: { blockId } });
      return this.view(tx, (await tx.collection('course_assignments').findOne({ id }))!);
    });
  }

  /** The completion record and certificate of a finished module. */
  certificate(id: string) {
    return this.db.tenant(async (tx) => {
      const { employeeId } = await this.me(tx);
      const a = await ownEnrolment(tx, id, employeeId);
      return certificateView(tx, a);
    });
  }
}

/** Folds a quiz's attempts into the learner's state: attempts used, best score, passed, done. */
export async function foldQuiz(tx: TenantTx, notifications: NotificationService, a: Doc, b: QuizBlock) {
  const all = await tx.collection('learning_quiz_attempts').find({ assignment_id: a.id, block_id: b.id, status: { $ne: 'in_progress' } });
  const graded = all.filter((t) => t.status === 'graded');
  const best = graded.length ? Math.max(...graded.map((t) => Number(t.percent ?? 0))) : null;
  const passed = graded.some((t) => t.passed);
  const outOfTries = !passed && ((b.settings.maxAttempts && all.length >= b.settings.maxAttempts) || (!b.settings.allowRetake && all.length > 0));
  const prev: BlockState = { done: false, ...((a.progress ?? {})[b.id] ?? {}) };
  const next: BlockState = { ...prev, attempts: all.length, bestPercent: best, passed: passed ? true : graded.length && outOfTries ? false : graded.length ? false : null, done: passed, doneAt: passed ? prev.doneAt ?? new Date().toISOString() : undefined };
  const fresh = (await tx.collection('course_assignments').findOne({ id: a.id }))!;
  if (!OPEN.includes(fresh.status)) return fresh;
  return recompute(tx, notifications, fresh, { progress: { [b.id]: next } });
}

export async function certificateView(tx: TenantTx, a: Doc) {
  if (a.status !== 'completed') throw Errors.conflict('not_completed', 'The module is not completed yet');
  const c = (await tx.collection('courses').findOne({ id: a.course_id }))!;
  const e = await tx.collection('employees').findOne({ id: a.employee_id });
  const tenant = await tx.collection('tenants').findOne({});
  const v = await versionOf(tx, a);
  return {
    employeeName: e ? displayName(e as never) : '', employeeCode: (e?.employee_code as string | undefined) ?? null, moduleTitle: v.title, version: v.version,
    completedOn: a.completed_on as string, completedAt: iso(a.completed_at), scorePercent: num(a.score_percent), passed: (a.passed as boolean | null) ?? null,
    certificateNo: (a.certificate_no as string | null) ?? null, issuedBy: (tenant?.name as string | undefined) ?? '', creator: await creatorOf(tx, c),
    durationMinutes: (c.duration_minutes as number | null) ?? null, timeSpentMinutes: Math.round(((a.time_spent_seconds as number) ?? 0) / 60),
  };
}

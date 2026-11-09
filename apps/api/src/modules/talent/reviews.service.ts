import { Injectable } from '@nestjs/common';
import { type CycleInput, PEER_ANONYMITY_MIN, PEER_QUESTIONS, type RatingLevel, type ReviewWriteInput, talentMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService, descendants } from '../../platform/authz/authz.service';
import { can, hasPermission, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { countBy, membershipUserNames, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, employeeNames, fieldById } from '../employees/employee-view';
import { attrsOf, needEmployee, pickAnswers, talentEmployee } from './talent-common';

interface CycleRow {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'calibration' | 'released';
  self_review: boolean;
  peer_feedback: boolean;
  questions: { id: string; text: string }[];
  rating_scale: RatingLevel[];
  period_start: string;
  period_end: string;
  legal_entity_id: string | null;
  department_id: string | null;
}

interface ReviewRow {
  id: string;
  cycle_id: string;
  employee_id: string;
  manager_employee_id: string | null;
  self_status: string;
  manager_status: string;
  manager_rating: number | null;
  final_rating: number | null;
  excluded: boolean;
  released_at: string | null;
  acknowledged_at: string | null;
}

type Role = 'employee' | 'manager' | 'hr' | 'viewer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const cycleRow = (c: Doc): CycleRow => ({
  id: c.id, name: c.name, status: c.status, self_review: c.self_review, peer_feedback: c.peer_feedback, questions: c.questions ?? [], rating_scale: c.rating_scale ?? [],
  period_start: c.period_start, period_end: c.period_end, legal_entity_id: c.legal_entity_id ?? null, department_id: c.department_id ?? null,
});

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/**
 * Review cycles: HR launches a cycle for a group of people; each person writes a self review, their manager writes a
 * manager review and can ask peers for 360 feedback. HR then calibrates ratings (every change needs a reason and is
 * kept) and releases results, after which nothing can change except the employee's acknowledgement.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  private isHr(s: Subject) {
    return hasPermission(s, 'performance:configure').allowed;
  }

  private async cycle(tx: TenantTx, id: string, lock = false): Promise<CycleRow> {
    const cycles = tx.collection('review_cycles');
    if (lock) await cycles.lock({ id });
    const c = await cycles.findOne({ id });
    if (!c) throw Errors.notFound('Review cycle');
    return cycleRow(c);
  }

  private async review(tx: TenantTx, id: string, lock = false): Promise<ReviewRow> {
    const reviews = tx.collection('reviews');
    if (lock) await reviews.lock({ id });
    const r = await reviews.findOne({ id });
    if (!r) throw Errors.notFound('Review');
    return {
      id: r.id, cycle_id: r.cycle_id, employee_id: r.employee_id, manager_employee_id: r.manager_employee_id ?? null, self_status: r.self_status, manager_status: r.manager_status,
      manager_rating: r.manager_rating ?? null, final_rating: r.final_rating ?? null, excluded: r.excluded, released_at: r.released_at ?? null, acknowledged_at: r.acknowledged_at ?? null,
    };
  }

  /** How the caller relates to a review. Anyone else gets 404. */
  private async roleFor(tx: TenantTx, r: ReviewRow): Promise<{ role: Role; s: Subject }> {
    const s = await this.authz.subject(tx);
    if (s.employeeId && s.employeeId === r.employee_id) return { role: 'employee', s };
    if (s.employeeId && s.employeeId === r.manager_employee_id) return { role: 'manager', s };
    if (this.isHr(s)) return { role: 'hr', s };
    const e = await talentEmployee(tx, r.employee_id);
    if (can(s, 'performance:read', attrsOf(e)).allowed) return { role: 'viewer', s };
    throw Errors.notFound('Review');
  }

  // Cycles -------------------------------------------------------------------------------------------------------

  listCycles() {
    return this.db.tenant(async (tx) => {
      const cycles = await tx.collection('review_cycles').find({}, { sort: { created_at: -1 }, limit: 200 });
      const entities = await fieldById(tx, 'legal_entities', cycles.map((c) => c.legal_entity_id));
      const depts = await fieldById(tx, 'departments', cycles.map((c) => c.department_id));
      const reviews = await tx.collection('reviews').find({ cycle_id: { $in: cycles.map((c) => c.id) }, excluded: false }, { projection: { cycle_id: 1, manager_status: 1, self_status: 1 } });
      return cycles.map((c) => {
        const mine = reviews.filter((r) => r.cycle_id === c.id);
        return {
          id: c.id, name: c.name, status: c.status, periodStart: c.period_start, periodEnd: c.period_end, selfReview: c.self_review, peerFeedback: c.peer_feedback,
          legalEntityName: entities.get(c.legal_entity_id) ?? null, departmentName: depts.get(c.department_id) ?? null, selfDue: c.self_due ?? null, managerDue: c.manager_due ?? null,
          launchedAt: c.launched_at ?? null, releasedAt: c.released_at ?? null, participants: mine.length,
          managerDone: mine.filter((r) => r.manager_status === 'submitted').length, selfDone: mine.filter((r) => r.self_status === 'submitted').length,
        };
      });
    });
  }

  async getCycle(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id);
      const x = (await tx.collection('review_cycles').findOne({ id }))!;
      const entity = await fieldById(tx, 'legal_entities', [x.legal_entity_id]);
      const dept = await fieldById(tx, 'departments', [x.department_id]);
      const full = {
        id: x.id, name: x.name, status: x.status, periodStart: x.period_start, periodEnd: x.period_end, selfReview: x.self_review, peerFeedback: x.peer_feedback,
        questions: x.questions, ratingScale: x.rating_scale, legalEntityId: x.legal_entity_id ?? null, legalEntityName: entity.get(x.legal_entity_id) ?? null,
        departmentId: x.department_id ?? null, departmentName: dept.get(x.department_id) ?? null, selfDue: x.self_due ?? null, managerDue: x.manager_due ?? null,
        launchedAt: x.launched_at ?? null, calibrationStartedAt: x.calibration_started_at ?? null, releasedAt: x.released_at ?? null,
      };
      const rows = await tx.collection('reviews').find({ cycle_id: id });
      const ids = rows.map((r) => r.id as string);
      const people = await employeeNames(tx, rows.flatMap((r) => [r.employee_id, r.manager_employee_id]));
      const deptNames = await fieldById(tx, 'departments', [...people.values()].map((p) => p.doc.current_department_id));
      const feedback = await tx.collection('review_feedback').find({ review_id: { $in: ids }, status: { $in: ['requested', 'submitted'] } }, { projection: { review_id: 1, status: 1 } });
      const calibrations = await countBy(tx, 'review_calibrations', 'review_id', ids);
      const reviews = rows
        .filter((r) => people.has(r.employee_id))
        .map((r) => {
          const e = people.get(r.employee_id)!;
          const fb = feedback.filter((f) => f.review_id === r.id);
          return {
            id: r.id as string, employeeId: r.employee_id, employeeName: e.name, employeeCode: e.doc.employee_code, departmentName: deptNames.get(e.doc.current_department_id) ?? null,
            managerEmployeeId: r.manager_employee_id ?? null, managerName: people.get(r.manager_employee_id)?.name ?? null, selfStatus: r.self_status, managerStatus: r.manager_status,
            selfRating: r.self_rating ?? null, managerRating: (r.manager_rating as number | null) ?? null, finalRating: (r.final_rating as number | null) ?? null, excluded: r.excluded as boolean,
            excludedReason: r.excluded_reason ?? null, acknowledgedAt: r.acknowledged_at ?? null,
            peerSubmitted: fb.filter((f) => f.status === 'submitted').length, peerRequested: fb.length, calibrationChanges: calibrations.get(r.id) ?? 0,
          };
        })
        .sort((a, b) => Number(a.excluded) - Number(b.excluded) || a.employeeName.localeCompare(b.employeeName));
      const included = reviews.filter((r) => !r.excluded);
      return {
        ...full,
        reviews,
        distribution: {
          manager: talentMath.ratingDistribution(included.map((r) => r.managerRating), c.rating_scale),
          final: talentMath.ratingDistribution(included.map((r) => r.finalRating), c.rating_scale),
        },
        preview: c.status === 'draft' ? await this.participants(tx, c) : undefined,
      };
    });
  }

  /** Everyone a cycle would include: current employees in its entity and department (with sub-departments) who joined by the end of the period. */
  private async participants(tx: TenantTx, c: CycleRow) {
    const filter: Doc = { status: { $in: ['probation', 'active', 'notice'] }, date_of_joining: { $lte: c.period_end } };
    if (c.legal_entity_id) filter.current_legal_entity_id = c.legal_entity_id;
    if (c.department_id) filter.current_department_id = { $in: [c.department_id, ...(await descendants(tx, 'departments', 'parent_id', c.department_id))] };
    const people = await tx.collection('employees').find(filter);
    const managers = await employeeNames(tx, people.map((e) => e.current_manager_employee_id));
    return people
      .map((e) => {
        const m = managers.get(e.current_manager_employee_id);
        return {
          id: e.id as string, name: displayName(e as never), manager_employee_id: (e.current_manager_employee_id as string | null) ?? null, manager_name: m?.name ?? null,
          membership_id: (e.membership_id as string | null) ?? null, manager_membership_id: m?.membershipId ?? null,
        };
      })
      .sort(byName);
  }

  private cycleFields(input: CycleInput) {
    return {
      name: input.name, period_start: input.periodStart, period_end: input.periodEnd, self_review: input.selfReview, peer_feedback: input.peerFeedback, questions: input.questions,
      rating_scale: input.ratingScale, legal_entity_id: input.legalEntityId ?? null, department_id: input.departmentId ?? null, self_due: input.selfDue ?? null, manager_due: input.managerDue ?? null,
    };
  }

  async createCycle(input: CycleInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const row = await tx.collection('review_cycles').insert({ ...this.cycleFields(input), created_by_membership_id: actor.membershipId });
      await this.audit.record(tx, { action: 'review_cycle.created', resourceType: 'review_cycle', resourceId: row.id, changes: input });
      return { id: row.id as string };
    });
  }

  async updateCycle(id: string, input: CycleInput) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft cycle can be changed');
      await tx.collection('review_cycles').updateOne({ id }, { $set: this.cycleFields(input) });
      await this.audit.record(tx, { action: 'review_cycle.updated', resourceType: 'review_cycle', resourceId: id, changes: input });
      return { id };
    });
  }

  async removeCycle(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft cycle can be deleted');
      await tx.collection('review_cycles').deleteOne({ id });
      await this.audit.record(tx, { action: 'review_cycle.deleted', resourceType: 'review_cycle', resourceId: id });
    });
  }

  async launch(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'draft') throw Errors.conflict('invalid_state', 'This cycle has already been launched');
      const people = await this.participants(tx, c);
      if (!people.length) throw Errors.badRequest('no_participants', 'Nobody matches this cycle. Check its legal entity, department and dates.');
      await tx.collection('reviews').insertMany(people.map((p) => ({ cycle_id: id, employee_id: p.id, manager_employee_id: p.manager_employee_id, self_status: c.self_review ? 'pending' : 'not_required' })));
      await tx.collection('review_cycles').updateOne({ id }, { $set: { status: 'active', launched_at: new Date() } });
      if (c.self_review) {
        await this.notifications.notify(tx, { membershipIds: people.map((p) => p.membership_id), kind: 'review.self_requested', title: `${c.name}: write your self review`, link: '/reviews' });
      }
      await this.notifications.notify(tx, {
        membershipIds: people.map((p) => p.manager_membership_id), kind: 'review.manager_requested', title: `${c.name}: write reviews for your team`, link: '/reviews?view=team',
      });
      const withoutManager = people.filter((p) => !p.manager_employee_id).length;
      await this.audit.record(tx, { action: 'review_cycle.launched', resourceType: 'review_cycle', resourceId: id, metadata: { participants: people.length, withoutManager } });
      return { participants: people.length, withoutManager };
    });
  }

  async startCalibration(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'active') throw Errors.conflict('invalid_state', 'Calibration starts from an active cycle');
      const pending = await tx.collection('reviews').find({ cycle_id: id, excluded: false, manager_status: { $ne: 'submitted' } }, { projection: { employee_id: 1 } });
      const missing = [...(await employeeNames(tx, pending.map((r) => r.employee_id))).values()].map((e) => ({ name: e.name })).sort(byName);
      if (missing.length) {
        throw Errors.conflict('manager_reviews_missing', `Manager reviews are still missing for ${missing.slice(0, 5).map((m) => m.name).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}. Wait for them, or exclude those people from the cycle.`);
      }
      const reviews = tx.collection('reviews');
      for (const rv of await reviews.find({ cycle_id: id, excluded: false }, { projection: { manager_rating: 1 } })) {
        await reviews.updateOne({ id: rv.id }, { $set: { final_rating: rv.manager_rating ?? null } });
      }
      const all = await reviews.distinct<string>('id', { cycle_id: id });
      await tx.collection('review_feedback').update({ review_id: { $in: all }, status: 'requested' }, { $set: { status: 'withdrawn' } });
      await tx.collection('review_cycles').updateOne({ id }, { $set: { status: 'calibration', calibration_started_at: new Date() } });
      await this.audit.record(tx, { action: 'review_cycle.calibration_started', resourceType: 'review_cycle', resourceId: id });
      return { status: 'calibration' };
    });
  }

  async release(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'calibration') throw Errors.conflict('invalid_state', 'Results are released after calibration');
      const reviews = tx.collection('reviews');
      const toRelease = await reviews.find({ cycle_id: id, excluded: false }, { projection: { employee_id: 1 } });
      await reviews.update({ id: { $in: toRelease.map((x) => x.id) } }, { $set: { released_at: new Date() } });
      const owners = await employeeNames(tx, toRelease.map((x) => x.employee_id));
      const released = toRelease.map((x) => ({ membership_id: owners.get(x.employee_id)?.membershipId ?? null }));
      await tx.collection('review_cycles').updateOne({ id }, { $set: { status: 'released', released_at: new Date() } });
      await this.notifications.notify(tx, { membershipIds: released.map((r) => r.membership_id), kind: 'review.released', title: `${c.name}: your review is ready to read`, link: '/reviews' });
      await this.audit.record(tx, { action: 'review_cycle.released', resourceType: 'review_cycle', resourceId: id, metadata: { reviews: released.length } });
      return { released: released.length };
    });
  }

  // Reviews ------------------------------------------------------------------------------------------------------

  async list(view: 'mine' | 'team' | 'feedback') {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) return [];
      if (view === 'feedback') {
        const rows = await tx.collection('review_feedback').find({ reviewer_employee_id: s.employeeId, status: { $ne: 'withdrawn' } });
        const reviews = new Map((await tx.collection('reviews').find({ id: { $in: rows.map((f) => f.review_id) } }, { projection: { cycle_id: 1, employee_id: 1 } })).map((x) => [x.id as string, x]));
        const cycles = new Map((await tx.collection('review_cycles').find({ id: { $in: [...reviews.values()].map((x) => x.cycle_id) } }, { projection: { name: 1, status: 1 } })).map((x) => [x.id as string, x]));
        const names = await employeeNames(tx, [...reviews.values()].map((x) => x.employee_id));
        rows.sort((a, b) => Number(b.status === 'requested') - Number(a.status === 'requested') || new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        return rows.slice(0, 200).map((f) => {
          const rv = reviews.get(f.review_id)!;
          const c = cycles.get(rv.cycle_id)!;
          return { id: f.id, status: f.status, reviewId: f.review_id, employeeName: names.get(rv.employee_id)?.name ?? '', cycleName: c.name, cycleStatus: c.status, requestedAt: f.created_at, submittedAt: f.submitted_at ?? null };
        });
      }
      const team = view === 'team';
      const rows = await tx.collection('reviews').find({ [team ? 'manager_employee_id' : 'employee_id']: s.employeeId, ...(team ? {} : { excluded: false }) });
      const cycles = new Map((await tx.collection('review_cycles').find({ id: { $in: [...new Set(rows.map((x) => x.cycle_id))] }, status: { $ne: 'draft' } })).map((x) => [x.id as string, x]));
      const names = await employeeNames(tx, rows.flatMap((x) => [x.employee_id, x.manager_employee_id]));
      const out = rows
        .filter((x) => cycles.has(x.cycle_id))
        .map((x) => {
          const c = cycles.get(x.cycle_id)!;
          return {
            id: x.id, cycleId: c.id, cycleName: c.name, cycleStatus: c.status, employeeName: names.get(x.employee_id)?.name ?? '', managerName: names.get(x.manager_employee_id)?.name ?? null,
            selfReview: c.self_review, selfStatus: x.self_status, managerStatus: x.manager_status, excluded: x.excluded, selfDue: c.self_due ?? null, managerDue: c.manager_due ?? null,
            finalRating: x.released_at || team ? (x.final_rating ?? null) : null, releasedAt: x.released_at ?? null, acknowledgedAt: x.acknowledged_at ?? null,
            _created: new Date(c.created_at).getTime(),
          };
        })
        .sort((a, b) => b._created - a._created || a.employeeName.localeCompare(b.employeeName))
        .slice(0, 300);
      return out.map(({ _created, ...rest }) => rest);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id);
      const { role } = await this.roleFor(tx, r);
      const c = await this.cycle(tx, r.cycle_id);
      const x = (await tx.collection('reviews').findOne({ id }))!;
      const names = await employeeNames(tx, [x.employee_id, x.manager_employee_id]);
      const full = {
        id: x.id, employeeId: x.employee_id, employeeName: names.get(x.employee_id)?.name ?? '', managerEmployeeId: x.manager_employee_id ?? null,
        managerName: names.get(x.manager_employee_id)?.name ?? null, selfStatus: x.self_status, selfAnswers: x.self_answers ?? {}, selfRating: x.self_rating ?? null,
        selfSubmittedAt: x.self_submitted_at ?? null, managerStatus: x.manager_status, managerAnswers: x.manager_answers ?? {}, managerRating: x.manager_rating ?? null,
        managerSubmittedAt: x.manager_submitted_at ?? null, finalRating: x.final_rating ?? null, excluded: x.excluded, excludedReason: x.excluded_reason ?? null,
        releasedAt: x.released_at ?? null, acknowledgedAt: x.acknowledged_at ?? null, employeeComment: x.employee_comment ?? null,
      };
      const released = Boolean(r.released_at);
      // Drafts stay private to their writer; the person sees the manager review once results are released.
      const seesManager = role === 'manager' ? true : role === 'employee' ? released : full.managerStatus === 'submitted';
      const seesSelf = role === 'employee' || full.selfStatus === 'submitted';
      const fbRows = await tx.collection('review_feedback').find({ review_id: id, status: { $ne: 'withdrawn' } }, { sort: { created_at: 1 } });
      const reviewers = await employeeNames(tx, fbRows.map((f) => f.reviewer_employee_id));
      const feedback = fbRows
        .filter((f) => reviewers.has(f.reviewer_employee_id))
        .map((f) => ({
          id: f.id as string, reviewerEmployeeId: f.reviewer_employee_id as string, reviewerName: reviewers.get(f.reviewer_employee_id)!.name, status: f.status as string,
          answers: (f.answers ?? {}) as Record<string, string>, submittedAt: f.submitted_at ?? null,
        }));
      let peer: unknown;
      if (role === 'employee') {
        const submitted = feedback.filter((f) => f.status === 'submitted');
        peer = !released
          ? { shown: false, reason: 'Shown after results are released' }
          : submitted.length < PEER_ANONYMITY_MIN
            ? { shown: false, reason: `Peer feedback is shared, without names, when at least ${PEER_ANONYMITY_MIN} colleagues answer. ${submitted.length} did.` }
            : { shown: true, answers: PEER_QUESTIONS.map((q) => ({ ...q, comments: submitted.map((f) => f.answers[q.id]).filter(Boolean).sort() })) };
      } else {
        peer = { shown: true, requests: feedback };
      }
      let calibrations: unknown[] = [];
      if (role === 'hr') {
        const ks = await tx.collection('review_calibrations').find({ review_id: id }, { sort: { created_at: 1 } });
        const by = await membershipUserNames(tx, ks.map((k) => k.by_membership_id));
        calibrations = ks.filter((k) => by.has(k.by_membership_id)).map((k) => ({ fromRating: k.from_rating ?? null, toRating: k.to_rating, reason: k.reason, createdAt: k.created_at, byName: by.get(k.by_membership_id) ?? null }));
      }
      const goals = (await tx.collection('goals').find(
        { employee_id: r.employee_id, status: { $ne: 'cancelled' }, period_start: { $lte: c.period_end }, period_end: { $gte: c.period_start } },
        { sort: { period_end: 1 } },
      )).map((g) => ({ id: g.id, title: g.title, progress: Number(g.progress), status: g.status, weight: g.weight }));
      const writable = c.status === 'active' && !r.excluded;
      return {
        ...full,
        selfAnswers: seesSelf ? full.selfAnswers : {},
        selfRating: seesSelf ? full.selfRating : null,
        managerAnswers: seesManager ? full.managerAnswers : {},
        managerRating: seesManager ? full.managerRating : null,
        finalRating: released || role === 'hr' ? full.finalRating : null,
        cycle: { id: c.id, name: c.name, status: c.status, questions: c.questions, ratingScale: c.rating_scale, selfReview: c.self_review, peerFeedback: c.peer_feedback, periodStart: c.period_start, periodEnd: c.period_end },
        role,
        peer,
        peerQuestions: PEER_QUESTIONS,
        calibrations,
        goals,
        can: {
          writeSelf: role === 'employee' && writable && full.selfStatus === 'pending',
          writeManager: writable && full.managerStatus === 'pending' && (role === 'manager' || (role === 'hr' && !r.manager_employee_id)),
          requestFeedback: writable && c.peer_feedback && (role === 'manager' || role === 'hr'),
          calibrate: role === 'hr' && c.status === 'calibration' && !r.excluded,
          exclude: role === 'hr' && (c.status === 'active' || c.status === 'calibration') && !r.excluded,
          acknowledge: role === 'employee' && released && !r.acknowledged_at,
        },
      };
    });
  }

  private requireComplete(questions: { id: string; text: string }[], answers: Record<string, string>, rating: number | null, scale: RatingLevel[]) {
    const missing = questions.filter((q) => !answers[q.id]?.trim());
    if (missing.length) throw Errors.badRequest('answers_missing', `Answer every question before submitting. Missing: ${missing.map((q) => `"${q.text}"`).join(', ')}`);
    if (rating == null) throw Errors.badRequest('rating_missing', 'Choose a rating before submitting');
    if (!scale.some((l) => l.value === rating)) throw Errors.badRequest('invalid_rating', 'Choose a rating from the scale');
  }

  async writeSelf(id: string, input: ReviewWriteInput) {
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id, true);
      const { role } = await this.roleFor(tx, r);
      if (role !== 'employee') throw Errors.forbidden('Only the person being reviewed writes the self review');
      const c = await this.cycle(tx, r.cycle_id);
      if (c.status !== 'active' || r.excluded) throw Errors.conflict('invalid_state', 'This review is closed for writing');
      if (r.self_status !== 'pending') throw Errors.conflict('invalid_state', r.self_status === 'submitted' ? 'Your self review is already submitted' : 'This cycle has no self review');
      const answers = pickAnswers(c.questions, input.answers);
      if (input.rating != null && !c.rating_scale.some((l) => l.value === input.rating)) throw Errors.badRequest('invalid_rating', 'Choose a rating from the scale');
      if (input.submit) this.requireComplete(c.questions, answers, input.rating, c.rating_scale);
      await tx.collection('reviews').updateOne({ id }, {
        $set: { self_answers: answers, self_rating: input.rating ?? null, self_submitted_at: input.submit ? new Date() : null, ...(input.submit ? { self_status: 'submitted' } : {}) },
      });
      if (input.submit) {
        await this.audit.record(tx, { action: 'review.self_submitted', resourceType: 'review', resourceId: id });
        const e = await talentEmployee(tx, r.employee_id);
        const mgr = r.manager_employee_id ? await talentEmployee(tx, r.manager_employee_id) : null;
        await this.notifications.notify(tx, { membershipIds: [mgr?.membership_id ?? null], kind: 'review.self_submitted', title: `${e.name} submitted their self review for ${c.name}`, link: `/reviews/${id}` });
      }
      return { selfStatus: input.submit ? 'submitted' : 'pending' };
    });
  }

  async writeManager(id: string, input: ReviewWriteInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id, true);
      const { role } = await this.roleFor(tx, r);
      if (!(role === 'manager' || (role === 'hr' && !r.manager_employee_id))) throw Errors.forbidden("Only the person's reviewing manager writes the manager review");
      const c = await this.cycle(tx, r.cycle_id);
      if (c.status !== 'active' || r.excluded) throw Errors.conflict('invalid_state', 'This review is closed for writing');
      if (r.manager_status !== 'pending') throw Errors.conflict('invalid_state', 'The manager review is already submitted');
      const answers = pickAnswers(c.questions, input.answers);
      if (input.rating != null && !c.rating_scale.some((l) => l.value === input.rating)) throw Errors.badRequest('invalid_rating', 'Choose a rating from the scale');
      if (input.submit) this.requireComplete(c.questions, answers, input.rating, c.rating_scale);
      await tx.collection('reviews').updateOne({ id }, {
        $set: {
          manager_answers: answers, manager_rating: input.rating ?? null, manager_submitted_at: input.submit ? new Date() : null,
          manager_submitted_by: input.submit ? actor.membershipId : null, ...(input.submit ? { manager_status: 'submitted' } : {}),
        },
      });
      if (input.submit) await this.audit.record(tx, { action: 'review.manager_submitted', resourceType: 'review', resourceId: id });
      return { managerStatus: input.submit ? 'submitted' : 'pending' };
    });
  }

  async requestFeedback(id: string, reviewerIds: string[]) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id, true);
      const { role } = await this.roleFor(tx, r);
      if (role !== 'manager' && role !== 'hr') throw Errors.forbidden('The reviewing manager or HR asks for peer feedback');
      const c = await this.cycle(tx, r.cycle_id);
      if (!c.peer_feedback) throw Errors.badRequest('no_peer_feedback', 'This cycle does not collect peer feedback');
      if (c.status !== 'active' || r.excluded) throw Errors.conflict('invalid_state', 'This review is closed for feedback');
      const e = await talentEmployee(tx, r.employee_id);
      const reviewers = [];
      for (const rid of new Set(reviewerIds)) {
        if (rid === r.employee_id || rid === r.manager_employee_id) throw Errors.badRequest('invalid_reviewer', 'Choose colleagues other than the person and their manager');
        const p = await talentEmployee(tx, rid, 'Colleague');
        if (p.status === 'exited') throw Errors.badRequest('invalid_reviewer', `${p.name} has left`);
        const table = tx.collection('review_feedback');
        if (!(await table.exists({ review_id: id, reviewer_employee_id: rid }))) {
          await table.insert({ review_id: id, reviewer_employee_id: rid, requested_by_membership_id: actor.membershipId });
          reviewers.push(p);
        }
      }
      await this.notifications.notify(tx, {
        membershipIds: reviewers.map((p) => p.membership_id), kind: 'review.feedback_requested', title: `Share feedback on ${e.name} for ${c.name}`, link: '/reviews?view=feedback',
      });
      await this.audit.record(tx, { action: 'review.feedback_requested', resourceType: 'review', resourceId: id, metadata: { reviewers: reviewers.map((p) => p.id) } });
      return { requested: reviewers.length };
    });
  }

  async withdrawFeedback(reviewId: string, feedbackId: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, reviewId);
      const { role } = await this.roleFor(tx, r);
      if (role !== 'manager' && role !== 'hr') throw Errors.forbidden();
      const table = tx.collection('review_feedback');
      await table.lock({ id: feedbackId, review_id: reviewId });
      const f = await table.findOne({ id: feedbackId, review_id: reviewId }, { projection: { status: 1 } });
      if (!f) throw Errors.notFound('Feedback request');
      if (f.status !== 'requested') throw Errors.conflict('invalid_state', `This feedback was ${f.status}`);
      await table.updateOne({ id: feedbackId }, { $set: { status: 'withdrawn' } });
      await this.audit.record(tx, { action: 'review.feedback_withdrawn', resourceType: 'review', resourceId: reviewId, metadata: { feedbackId } });
    });
  }

  private async feedbackForReviewer(tx: TenantTx, id: string, lock = false) {
    const s = await this.authz.subject(tx);
    const table = tx.collection('review_feedback');
    if (lock) await table.lock({ id, reviewer_employee_id: s.employeeId ?? null });
    const row = await table.findOne({ id, reviewer_employee_id: s.employeeId ?? null });
    if (!row) throw Errors.notFound('Feedback request');
    const rv = (await tx.collection('reviews').findOne({ id: row.review_id }, { projection: { cycle_id: 1, employee_id: 1 } }))!;
    const c = (await tx.collection('review_cycles').findOne({ id: rv.cycle_id }, { projection: { status: 1, name: 1 } }))!;
    const names = await employeeNames(tx, [rv.employee_id]);
    return {
      id: row.id as string, status: row.status as string, review_id: row.review_id as string, answers: (row.answers ?? {}) as Record<string, string>, cycle_status: c.status as string,
      employee_name: names.get(rv.employee_id)?.name ?? '', cycle_name: c.name as string,
    };
  }

  async getFeedback(id: string) {
    return this.db.tenant(async (tx) => {
      const f = await this.feedbackForReviewer(tx, id);
      return {
        id: f.id, status: f.status, employeeName: f.employee_name, cycleName: f.cycle_name, answers: f.answers, questions: PEER_QUESTIONS,
        can: { write: f.status === 'requested' && f.cycle_status === 'active' },
        notice: 'Your name is shown to their manager and HR. The person sees peer feedback without names, and only when enough colleagues answer.',
      };
    });
  }

  async writeFeedback(id: string, answers: Record<string, string>, submit: boolean) {
    return this.db.tenant(async (tx) => {
      const f = await this.feedbackForReviewer(tx, id, true);
      if (f.status !== 'requested' || f.cycle_status !== 'active') throw Errors.conflict('invalid_state', 'This feedback request is closed');
      const clean = pickAnswers([...PEER_QUESTIONS], answers);
      if (submit && PEER_QUESTIONS.some((q) => !clean[q.id])) throw Errors.badRequest('answers_missing', 'Answer both questions before submitting');
      await tx.collection('review_feedback').updateOne({ id }, { $set: { answers: clean, submitted_at: submit ? new Date() : null, ...(submit ? { status: 'submitted' } : {}) } });
      if (submit) await this.audit.record(tx, { action: 'review.feedback_submitted', resourceType: 'review', resourceId: f.review_id, metadata: { feedbackId: id } });
      return { status: submit ? 'submitted' : 'requested' };
    });
  }

  async declineFeedback(id: string) {
    return this.db.tenant(async (tx) => {
      const f = await this.feedbackForReviewer(tx, id, true);
      if (f.status !== 'requested') throw Errors.conflict('invalid_state', 'This feedback request is closed');
      await tx.collection('review_feedback').updateOne({ id }, { $set: { status: 'declined', answers: {} } });
      await this.audit.record(tx, { action: 'review.feedback_declined', resourceType: 'review', resourceId: f.review_id, metadata: { feedbackId: id } });
      return { status: 'declined' };
    });
  }

  async calibrate(id: string, finalRating: number, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id, true);
      const { role } = await this.roleFor(tx, r);
      if (role !== 'hr') {
        // A manager or the person themselves never calibrates their own review, even if they also hold HR rights.
        throw Errors.forbidden(role === 'employee' || role === 'manager' ? 'You cannot calibrate a review you are part of' : undefined);
      }
      const c = await this.cycle(tx, r.cycle_id);
      if (c.status !== 'calibration' || r.excluded) throw Errors.conflict('invalid_state', 'Ratings are calibrated while the cycle is in calibration');
      if (!c.rating_scale.some((l) => l.value === finalRating)) throw Errors.badRequest('invalid_rating', 'Choose a rating from the scale');
      if (finalRating === r.final_rating) return { finalRating };
      await tx.collection('reviews').updateOne({ id }, { $set: { final_rating: finalRating, calibrated_at: new Date() } });
      await tx.collection('review_calibrations').insert({ review_id: id, from_rating: r.final_rating, to_rating: finalRating, reason, by_membership_id: actor.membershipId });
      await this.audit.record(tx, { action: 'review.calibrated', resourceType: 'review', resourceId: id, changes: { from: r.final_rating, to: finalRating, reason } });
      return { finalRating };
    });
  }

  async exclude(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id, true);
      const s = await this.authz.subject(tx);
      if (!this.isHr(s)) throw Errors.forbidden();
      const c = await this.cycle(tx, r.cycle_id);
      if (!['active', 'calibration'].includes(c.status) || r.excluded) throw Errors.conflict('invalid_state', 'This review cannot be excluded now');
      await tx.collection('reviews').updateOne({ id }, { $set: { excluded: true, excluded_reason: reason, final_rating: null } });
      await tx.collection('review_feedback').update({ review_id: id, status: 'requested' }, { $set: { status: 'withdrawn' } });
      await this.audit.record(tx, { action: 'review.excluded', resourceType: 'review', resourceId: id, metadata: { reason } });
      return { excluded: true };
    });
  }

  async reassignManager(id: string, managerEmployeeId: string | null) {
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id, true);
      const s = await this.authz.subject(tx);
      if (!this.isHr(s)) throw Errors.forbidden();
      const c = await this.cycle(tx, r.cycle_id);
      if (c.status !== 'active' || r.manager_status !== 'pending') throw Errors.conflict('invalid_state', 'The reviewer can change only before the manager review is submitted');
      if (managerEmployeeId === r.employee_id) throw Errors.badRequest('invalid_manager', 'Choose someone other than the person being reviewed');
      const m = managerEmployeeId ? await talentEmployee(tx, managerEmployeeId, 'Manager') : null;
      // A draft written by the previous manager is not passed to the new one.
      await tx.collection('reviews').updateOne({ id }, { $set: { manager_employee_id: managerEmployeeId, manager_answers: {}, manager_rating: null } });
      if (m) {
        const e = await talentEmployee(tx, r.employee_id);
        await this.notifications.notify(tx, { membershipIds: [m.membership_id], kind: 'review.manager_requested', title: `${c.name}: write a review for ${e.name}`, link: `/reviews/${id}` });
      }
      await this.audit.record(tx, { action: 'review.manager_changed', resourceType: 'review', resourceId: id, changes: { from: r.manager_employee_id, to: managerEmployeeId } });
      return { managerEmployeeId };
    });
  }

  async acknowledge(id: string, comment: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id, true);
      const { role } = await this.roleFor(tx, r);
      if (role !== 'employee') throw Errors.forbidden('Only the person reviewed can acknowledge it');
      if (!r.released_at) throw Errors.conflict('invalid_state', 'This review has not been released yet');
      if (r.acknowledged_at) throw Errors.conflict('invalid_state', 'You already acknowledged this review');
      await tx.collection('reviews').updateOne({ id }, { $set: { acknowledged_at: new Date(), employee_comment: comment || null } });
      await this.audit.record(tx, { action: 'review.acknowledged', resourceType: 'review', resourceId: id });
      return { acknowledged: true };
    });
  }

  /** Colleagues the caller can pick as peer reviewers: current employees, by name. */
  async colleagues(q: string) {
    return this.db.tenant(async (tx) => {
      needEmployee((await this.authz.subject(tx)).employeeId);
      return this.peopleList(tx, { status: { $ne: 'exited' } }, q, 20);
    });
  }

  /** Employees matching `filter` (and a name search), with their department, sorted by name. */
  private async peopleList(tx: TenantTx, filter: Doc, q: string | undefined, limit: number) {
    const rows = await tx.collection('employees').find(filter, { projection: { preferred_name: 1, first_name: 1, last_name: 1, current_department_id: 1 } });
    const needle = q?.toLowerCase();
    const named = rows.map((e) => ({ e, name: displayName(e as never) })).filter((x) => !needle || x.name.toLowerCase().includes(needle)).sort(byName).slice(0, limit);
    const depts = await fieldById(tx, 'departments', named.map((x) => x.e.current_department_id));
    return named.map((x) => ({ id: x.e.id as string, name: x.name, departmentName: depts.get(x.e.current_department_id) ?? null }));
  }

  /** People the caller manages for performance or learning (their `:manage` scope), to pick goal owners or learners. */
  async managed(kind: 'performance' | 'learning') {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const scope = await this.authz.filter(`${kind}:manage`, EMPLOYEE_FIELDS, tx);
      return this.peopleList(tx, { $and: [scope, { status: { $ne: 'exited' } }, ...(s.employeeId ? [{ id: { $ne: s.employeeId } }] : [])] }, undefined, 1000);
    });
  }
}

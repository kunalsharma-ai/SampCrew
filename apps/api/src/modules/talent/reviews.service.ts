import { Injectable } from '@nestjs/common';
import { type CycleInput, PEER_ANONYMITY_MIN, PEER_QUESTIONS, type RatingLevel, type ReviewWriteInput, talentMath } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, hasPermission, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { attrsOf, nameOf, needEmployee, pickAnswers, talentEmployee } from './talent-common';

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

const CYCLE_SELECT = `id, name, status, self_review, peer_feedback, questions, rating_scale, to_char(period_start, 'YYYY-MM-DD') as period_start,
  to_char(period_end, 'YYYY-MM-DD') as period_end, legal_entity_id, department_id`;

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

  private async cycle(tx: Tx, id: string, lock = false) {
    const c = await one<CycleRow>(tx, `select ${CYCLE_SELECT} from review_cycles where id = $1${lock ? ' for update' : ''}`, [id]);
    if (!c) throw Errors.notFound('Review cycle');
    return c;
  }

  private async review(tx: Tx, id: string, lock = false) {
    const r = await one<ReviewRow>(
      tx,
      `select id, cycle_id, employee_id, manager_employee_id, self_status, manager_status, manager_rating, final_rating, excluded, released_at, acknowledged_at
         from reviews where id = $1${lock ? ' for update' : ''}`,
      [id],
    );
    if (!r) throw Errors.notFound('Review');
    return r;
  }

  /** How the caller relates to a review. Anyone else gets 404. */
  private async roleFor(tx: Tx, r: ReviewRow): Promise<{ role: Role; s: Subject }> {
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
    return this.db.tenant((tx) =>
      many(
        tx,
        `select c.id, c.name, c.status, to_char(c.period_start, 'YYYY-MM-DD') as "periodStart", to_char(c.period_end, 'YYYY-MM-DD') as "periodEnd",
                c.self_review as "selfReview", c.peer_feedback as "peerFeedback", le.name as "legalEntityName", d.name as "departmentName",
                to_char(c.self_due, 'YYYY-MM-DD') as "selfDue", to_char(c.manager_due, 'YYYY-MM-DD') as "managerDue", c.launched_at as "launchedAt", c.released_at as "releasedAt",
                (select count(*)::int from reviews r where r.cycle_id = c.id and not r.excluded) as participants,
                (select count(*)::int from reviews r where r.cycle_id = c.id and not r.excluded and r.manager_status = 'submitted') as "managerDone",
                (select count(*)::int from reviews r where r.cycle_id = c.id and not r.excluded and r.self_status = 'submitted') as "selfDone"
           from review_cycles c left join legal_entities le on le.id = c.legal_entity_id left join departments d on d.id = c.department_id
          order by c.created_at desc limit 200`,
      ),
    );
  }

  async getCycle(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id);
      const full = await one<Record<string, unknown>>(
        tx,
        `select c.id, c.name, c.status, to_char(c.period_start, 'YYYY-MM-DD') as "periodStart", to_char(c.period_end, 'YYYY-MM-DD') as "periodEnd",
                c.self_review as "selfReview", c.peer_feedback as "peerFeedback", c.questions, c.rating_scale as "ratingScale",
                c.legal_entity_id as "legalEntityId", le.name as "legalEntityName", c.department_id as "departmentId", d.name as "departmentName",
                to_char(c.self_due, 'YYYY-MM-DD') as "selfDue", to_char(c.manager_due, 'YYYY-MM-DD') as "managerDue",
                c.launched_at as "launchedAt", c.calibration_started_at as "calibrationStartedAt", c.released_at as "releasedAt"
           from review_cycles c left join legal_entities le on le.id = c.legal_entity_id left join departments d on d.id = c.department_id where c.id = $1`,
        [id],
      );
      const reviews = await many<{ excluded: boolean; managerRating: number | null; finalRating: number | null }>(
        tx,
        `select r.id, r.employee_id as "employeeId", ${nameOf('e')} as "employeeName", e.employee_code as "employeeCode", dep.name as "departmentName",
                r.manager_employee_id as "managerEmployeeId", ${nameOf('m')} as "managerName", r.self_status as "selfStatus", r.manager_status as "managerStatus",
                r.self_rating as "selfRating", r.manager_rating as "managerRating", r.final_rating as "finalRating", r.excluded, r.excluded_reason as "excludedReason",
                r.acknowledged_at as "acknowledgedAt",
                (select count(*)::int from review_feedback f where f.review_id = r.id and f.status = 'submitted') as "peerSubmitted",
                (select count(*)::int from review_feedback f where f.review_id = r.id and f.status in ('requested', 'submitted')) as "peerRequested",
                (select count(*)::int from review_calibrations k where k.review_id = r.id) as "calibrationChanges"
           from reviews r join employees e on e.id = r.employee_id left join employees m on m.id = r.manager_employee_id
           left join departments dep on dep.id = e.current_department_id
          where r.cycle_id = $1 order by r.excluded, ${nameOf('e')}`,
        [id],
      );
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
  private participants(tx: Tx, c: CycleRow) {
    return many<{ id: string; name: string; manager_employee_id: string | null; manager_name: string | null; membership_id: string | null; manager_membership_id: string | null }>(
      tx,
      `with recursive deps(id) as (select $3::uuid where $3::uuid is not null union select d.id from departments d join deps on d.parent_id = deps.id)
       select e.id, ${nameOf('e')} as name, e.current_manager_employee_id as manager_employee_id, ${nameOf('m')} as manager_name, e.membership_id, m.membership_id as manager_membership_id
         from employees e left join employees m on m.id = e.current_manager_employee_id
        where e.status in ('probation', 'active', 'notice') and e.date_of_joining <= $1::date
          and ($2::uuid is null or e.current_legal_entity_id = $2) and ($3::uuid is null or e.current_department_id in (select id from deps))
        order by name`,
      [c.period_end, c.legal_entity_id, c.department_id],
    );
  }

  async createCycle(input: CycleInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const row = (await one<{ id: string }>(
        tx,
        `insert into review_cycles (tenant_id, name, period_start, period_end, self_review, peer_feedback, questions, rating_scale, legal_entity_id, department_id,
                                    self_due, manager_due, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [input.name, input.periodStart, input.periodEnd, input.selfReview, input.peerFeedback, JSON.stringify(input.questions), JSON.stringify(input.ratingScale),
          input.legalEntityId, input.departmentId, input.selfDue, input.managerDue, actor.membershipId],
      ))!;
      await this.audit.record(tx, { action: 'review_cycle.created', resourceType: 'review_cycle', resourceId: row.id, changes: input });
      return { id: row.id };
    });
  }

  async updateCycle(id: string, input: CycleInput) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft cycle can be changed');
      await tx.query(
        `update review_cycles set name = $2, period_start = $3, period_end = $4, self_review = $5, peer_feedback = $6, questions = $7, rating_scale = $8,
                legal_entity_id = $9, department_id = $10, self_due = $11, manager_due = $12 where id = $1`,
        [id, input.name, input.periodStart, input.periodEnd, input.selfReview, input.peerFeedback, JSON.stringify(input.questions), JSON.stringify(input.ratingScale),
          input.legalEntityId, input.departmentId, input.selfDue, input.managerDue],
      );
      await this.audit.record(tx, { action: 'review_cycle.updated', resourceType: 'review_cycle', resourceId: id, changes: input });
      return { id };
    });
  }

  async removeCycle(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'draft') throw Errors.conflict('invalid_state', 'Only a draft cycle can be deleted');
      await tx.query('delete from review_cycles where id = $1', [id]);
      await this.audit.record(tx, { action: 'review_cycle.deleted', resourceType: 'review_cycle', resourceId: id });
    });
  }

  async launch(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'draft') throw Errors.conflict('invalid_state', 'This cycle has already been launched');
      const people = await this.participants(tx, c);
      if (!people.length) throw Errors.badRequest('no_participants', 'Nobody matches this cycle. Check its legal entity, department and dates.');
      for (const p of people) {
        await tx.query(
          `insert into reviews (tenant_id, cycle_id, employee_id, manager_employee_id, self_status) values (app_tenant_id(), $1, $2, $3, $4)`,
          [id, p.id, p.manager_employee_id, c.self_review ? 'pending' : 'not_required'],
        );
      }
      await tx.query(`update review_cycles set status = 'active', launched_at = now() where id = $1`, [id]);
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
      const missing = await many<{ name: string }>(
        tx,
        `select ${nameOf('e')} as name from reviews r join employees e on e.id = r.employee_id where r.cycle_id = $1 and not r.excluded and r.manager_status <> 'submitted' order by 1`,
        [id],
      );
      if (missing.length) {
        throw Errors.conflict('manager_reviews_missing', `Manager reviews are still missing for ${missing.slice(0, 5).map((m) => m.name).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}. Wait for them, or exclude those people from the cycle.`);
      }
      await tx.query(`update reviews set final_rating = manager_rating where cycle_id = $1 and not excluded`, [id]);
      await tx.query(`update review_feedback f set status = 'withdrawn' from reviews r where r.id = f.review_id and r.cycle_id = $1 and f.status = 'requested'`, [id]);
      await tx.query(`update review_cycles set status = 'calibration', calibration_started_at = now() where id = $1`, [id]);
      await this.audit.record(tx, { action: 'review_cycle.calibration_started', resourceType: 'review_cycle', resourceId: id });
      return { status: 'calibration' };
    });
  }

  async release(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await this.cycle(tx, id, true);
      if (c.status !== 'calibration') throw Errors.conflict('invalid_state', 'Results are released after calibration');
      const released = await many<{ membership_id: string | null }>(
        tx,
        `update reviews r set released_at = now() from employees e where e.id = r.employee_id and r.cycle_id = $1 and not r.excluded returning e.membership_id`,
        [id],
      );
      await tx.query(`update review_cycles set status = 'released', released_at = now() where id = $1`, [id]);
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
        return many(
          tx,
          `select f.id, f.status, r.id as "reviewId", ${nameOf('e')} as "employeeName", c.name as "cycleName", c.status as "cycleStatus", f.created_at as "requestedAt", f.submitted_at as "submittedAt"
             from review_feedback f join reviews r on r.id = f.review_id join review_cycles c on c.id = r.cycle_id join employees e on e.id = r.employee_id
            where f.reviewer_employee_id = $1 and f.status <> 'withdrawn' order by f.status = 'requested' desc, f.created_at desc limit 200`,
          [s.employeeId],
        );
      }
      const where = view === 'mine' ? 'r.employee_id = $1' : 'r.manager_employee_id = $1';
      return many(
        tx,
        `select r.id, c.id as "cycleId", c.name as "cycleName", c.status as "cycleStatus", ${nameOf('e')} as "employeeName", ${nameOf('m')} as "managerName",
                c.self_review as "selfReview", r.self_status as "selfStatus", r.manager_status as "managerStatus", r.excluded,
                to_char(c.self_due, 'YYYY-MM-DD') as "selfDue", to_char(c.manager_due, 'YYYY-MM-DD') as "managerDue",
                case when r.released_at is not null or $2 then r.final_rating end as "finalRating", r.released_at as "releasedAt", r.acknowledged_at as "acknowledgedAt"
           from reviews r join review_cycles c on c.id = r.cycle_id join employees e on e.id = r.employee_id left join employees m on m.id = r.manager_employee_id
          where ${where} and c.status <> 'draft' and (not r.excluded or $2) order by c.created_at desc, ${nameOf('e')} limit 300`,
        [s.employeeId, view === 'team'],
      );
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.review(tx, id);
      const { role } = await this.roleFor(tx, r);
      const c = await this.cycle(tx, r.cycle_id);
      const full = (await one<Record<string, any>>(
        tx,
        `select r.id, r.employee_id as "employeeId", ${nameOf('e')} as "employeeName", r.manager_employee_id as "managerEmployeeId", ${nameOf('m')} as "managerName",
                r.self_status as "selfStatus", r.self_answers as "selfAnswers", r.self_rating as "selfRating", r.self_submitted_at as "selfSubmittedAt",
                r.manager_status as "managerStatus", r.manager_answers as "managerAnswers", r.manager_rating as "managerRating", r.manager_submitted_at as "managerSubmittedAt",
                r.final_rating as "finalRating", r.excluded, r.excluded_reason as "excludedReason", r.released_at as "releasedAt",
                r.acknowledged_at as "acknowledgedAt", r.employee_comment as "employeeComment"
           from reviews r join employees e on e.id = r.employee_id left join employees m on m.id = r.manager_employee_id where r.id = $1`,
        [id],
      ))!;
      const released = Boolean(r.released_at);
      // Drafts stay private to their writer; the person sees the manager review once results are released.
      const seesManager = role === 'manager' ? true : role === 'employee' ? released : full.managerStatus === 'submitted';
      const seesSelf = role === 'employee' || full.selfStatus === 'submitted';
      const feedback = await many<{ reviewerName: string; status: string; answers: Record<string, string>; id: string; reviewerEmployeeId: string }>(
        tx,
        `select f.id, f.reviewer_employee_id as "reviewerEmployeeId", ${nameOf('e')} as "reviewerName", f.status, f.answers, f.submitted_at as "submittedAt"
           from review_feedback f join employees e on e.id = f.reviewer_employee_id where f.review_id = $1 and f.status <> 'withdrawn' order by f.created_at`,
        [id],
      );
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
      const calibrations = role === 'hr'
        ? await many(tx, `select k.from_rating as "fromRating", k.to_rating as "toRating", k.reason, k.created_at as "createdAt", u.full_name as "byName"
                            from review_calibrations k join memberships m on m.id = k.by_membership_id join users u on u.id = m.user_id where k.review_id = $1 order by k.created_at`, [id])
        : [];
      const goals = await many(
        tx,
        `select id, title, progress::float8 as progress, status, weight from goals where employee_id = $1 and status <> 'cancelled' and period_start <= $3::date and period_end >= $2::date order by period_end`,
        [r.employee_id, c.period_start, c.period_end],
      );
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
      await tx.query(
        `update reviews set self_answers = $2, self_rating = $3, self_status = case when $4 then 'submitted' else self_status end,
                self_submitted_at = case when $4 then now() end where id = $1`,
        [id, JSON.stringify(answers), input.rating, input.submit],
      );
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
      await tx.query(
        `update reviews set manager_answers = $2, manager_rating = $3, manager_status = case when $4 then 'submitted' else manager_status end,
                manager_submitted_at = case when $4 then now() end, manager_submitted_by = case when $4 then $5::uuid end where id = $1`,
        [id, JSON.stringify(answers), input.rating, input.submit, actor.membershipId],
      );
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
        const ins = await one(
          tx,
          `insert into review_feedback (tenant_id, review_id, reviewer_employee_id, requested_by_membership_id) values (app_tenant_id(), $1, $2, $3)
           on conflict (tenant_id, review_id, reviewer_employee_id) do nothing returning id`,
          [id, rid, actor.membershipId],
        );
        if (ins) reviewers.push(p);
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
      const f = await one<{ status: string }>(tx, 'select status from review_feedback where id = $1 and review_id = $2 for update', [feedbackId, reviewId]);
      if (!f) throw Errors.notFound('Feedback request');
      if (f.status !== 'requested') throw Errors.conflict('invalid_state', `This feedback was ${f.status}`);
      await tx.query(`update review_feedback set status = 'withdrawn' where id = $1`, [feedbackId]);
      await this.audit.record(tx, { action: 'review.feedback_withdrawn', resourceType: 'review', resourceId: reviewId, metadata: { feedbackId } });
    });
  }

  private async feedbackForReviewer(tx: Tx, id: string, lock = false) {
    const s = await this.authz.subject(tx);
    const f = await one<{ id: string; status: string; review_id: string; answers: Record<string, string>; cycle_status: string; employee_name: string; cycle_name: string }>(
      tx,
      `select f.id, f.status, f.review_id, f.answers, c.status as cycle_status, ${nameOf('e')} as employee_name, c.name as cycle_name
         from review_feedback f join reviews r on r.id = f.review_id join review_cycles c on c.id = r.cycle_id join employees e on e.id = r.employee_id
        where f.id = $1 and f.reviewer_employee_id = $2${lock ? ' for update of f' : ''}`,
      [id, s.employeeId ?? null],
    );
    if (!f) throw Errors.notFound('Feedback request');
    return f;
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
      await tx.query(
        `update review_feedback set answers = $2, status = case when $3 then 'submitted' else status end, submitted_at = case when $3 then now() end where id = $1`,
        [id, JSON.stringify(clean), submit],
      );
      if (submit) await this.audit.record(tx, { action: 'review.feedback_submitted', resourceType: 'review', resourceId: f.review_id, metadata: { feedbackId: id } });
      return { status: submit ? 'submitted' : 'requested' };
    });
  }

  async declineFeedback(id: string) {
    return this.db.tenant(async (tx) => {
      const f = await this.feedbackForReviewer(tx, id, true);
      if (f.status !== 'requested') throw Errors.conflict('invalid_state', 'This feedback request is closed');
      await tx.query(`update review_feedback set status = 'declined', answers = '{}' where id = $1`, [id]);
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
      await tx.query('update reviews set final_rating = $2, calibrated_at = now() where id = $1', [id, finalRating]);
      await tx.query(
        `insert into review_calibrations (tenant_id, review_id, from_rating, to_rating, reason, by_membership_id) values (app_tenant_id(), $1, $2, $3, $4, $5)`,
        [id, r.final_rating, finalRating, reason, actor.membershipId],
      );
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
      await tx.query('update reviews set excluded = true, excluded_reason = $2, final_rating = null where id = $1', [id, reason]);
      await tx.query(`update review_feedback set status = 'withdrawn' where review_id = $1 and status = 'requested'`, [id]);
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
      await tx.query(`update reviews set manager_employee_id = $2, manager_answers = '{}', manager_rating = null where id = $1`, [id, managerEmployeeId]);
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
      await tx.query('update reviews set acknowledged_at = now(), employee_comment = $2 where id = $1', [id, comment || null]);
      await this.audit.record(tx, { action: 'review.acknowledged', resourceType: 'review', resourceId: id });
      return { acknowledged: true };
    });
  }

  /** Colleagues the caller can pick as peer reviewers: current employees, by name. */
  async colleagues(q: string) {
    return this.db.tenant(async (tx) => {
      needEmployee((await this.authz.subject(tx)).employeeId);
      return many(
        tx,
        `select e.id, ${nameOf('e')} as name, d.name as "departmentName" from employees e left join departments d on d.id = e.current_department_id
          where e.status <> 'exited' and ($1::text is null or ${nameOf('e')} ilike $1) order by 2 limit 20`,
        [q ? `%${q}%` : null],
      );
    });
  }

  /** People the caller manages for performance or learning (their `:manage` scope), to pick goal owners or learners. */
  async managed(kind: 'performance' | 'learning') {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const params: unknown[] = [s.employeeId ?? null];
      const pred = await this.authz.predicate(`${kind}:manage`, EMPLOYEE_SCOPE, params, tx);
      return many(
        tx,
        `select e.id, ${nameOf('e')} as name, d.name as "departmentName" from employees e left join departments d on d.id = e.current_department_id
          where ${pred} and e.status <> 'exited' and e.id is distinct from $1 order by 2 limit 1000`,
        params,
      );
    });
  }
}

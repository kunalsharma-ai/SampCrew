import { Injectable } from '@nestjs/common';
import type { AssignInput, CourseInput, PathInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { attrsOf, nameOf, needEmployee, talentEmployee } from './talent-common';

interface AssignmentRow {
  id: string;
  employee_id: string;
  course_id: string;
  status: string;
  source: string;
  format: string;
  validity_months: number | null;
  title: string;
}

const COURSE_COLS = `c.id, c.title, c.description, c.format, c.content_url as "contentUrl", c.duration_minutes as "durationMinutes",
  c.validity_months as "validityMonths", c.category, c.self_enrol as "selfEnrol", c.archived_at as "archivedAt"`;

const ASSIGNMENT_COLS = `a.id, a.employee_id as "employeeId", ${nameOf('e')} as "employeeName", a.course_id as "courseId", c.title as "courseTitle", c.format,
  c.content_url as "contentUrl", c.duration_minutes as "durationMinutes", a.path_id as "pathId", p.title as "pathTitle", a.source,
  to_char(a.due_on, 'YYYY-MM-DD') as "dueOn", a.status, a.started_at as "startedAt", to_char(a.completed_on, 'YYYY-MM-DD') as "completedOn",
  a.completion_note as "completionNote", to_char(a.expires_on, 'YYYY-MM-DD') as "expiresOn", a.created_at as "createdAt",
  (a.status in ('assigned', 'in_progress') and a.due_on < current_date) as overdue,
  (a.status = 'completed' and a.expires_on < current_date) as expired`;
const ASSIGNMENT_FROM = `course_assignments a join employees e on e.id = a.employee_id join courses c on c.id = a.course_id left join learning_paths p on p.id = a.path_id`;

/**
 * Learning: a course catalogue and learning paths (HR), assignments by managers and HR to people in their
 * `learning:manage` scope, self-enrolment, and completion records. Completions are facts and cannot be edited;
 * courses with a validity period expire and can be assigned again.
 */
@Injectable()
export class LearningService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  // Catalogue ----------------------------------------------------------------------------------------------------

  async courses(includeArchived: boolean) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const all = includeArchived && hasPermission(s, 'learning:configure').allowed;
      return many(
        tx,
        `select ${COURSE_COLS},
                (select a.status from course_assignments a where a.course_id = c.id and a.employee_id = $2 order by a.created_at desc limit 1) as "myStatus",
                (select count(*)::int from course_assignments a where a.course_id = c.id and a.status = 'completed') as completions
           from courses c where ($1 or c.archived_at is null) order by c.archived_at is not null, c.category, c.title`,
        [all, s.employeeId ?? null],
      );
    });
  }

  createCourse(input: CourseInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = (await one<{ id: string }>(
        tx,
        `insert into courses (tenant_id, title, description, format, content_url, duration_minutes, validity_months, category, self_enrol, created_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [input.title, input.description, input.format, input.contentUrl, input.durationMinutes, input.validityMonths, input.category, input.selfEnrol, actor.membershipId],
      ))!;
      await this.audit.record(tx, { action: 'course.created', resourceType: 'course', resourceId: r.id, changes: input });
      return { id: r.id };
    });
  }

  updateCourse(id: string, input: CourseInput) {
    return this.db.tenant(async (tx) => {
      const r = await one(
        tx,
        `update courses set title = $2, description = $3, format = $4, content_url = $5, duration_minutes = $6, validity_months = $7, category = $8, self_enrol = $9
          where id = $1 and archived_at is null returning id`,
        [id, input.title, input.description, input.format, input.contentUrl, input.durationMinutes, input.validityMonths, input.category, input.selfEnrol],
      );
      if (!r) throw Errors.notFound('Course');
      await this.audit.record(tx, { action: 'course.updated', resourceType: 'course', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveCourse(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one(tx, 'update courses set archived_at = now() where id = $1 and archived_at is null returning id', [id]);
      if (!r) throw Errors.notFound('Course');
      // Open assignments stay so people keep their record; nobody new can be assigned.
      await this.audit.record(tx, { action: 'course.archived', resourceType: 'course', resourceId: id });
    });
  }

  paths() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select p.id, p.title, p.description,
                coalesce((select json_agg(json_build_object('id', c.id, 'title', c.title, 'format', c.format, 'durationMinutes', c.duration_minutes) order by pc.position)
                            from learning_path_courses pc join courses c on c.id = pc.course_id where pc.path_id = p.id), '[]') as courses
           from learning_paths p where p.archived_at is null order by p.title`,
      ),
    );
  }

  private async writePathCourses(tx: Tx, pathId: string, courseIds: string[]) {
    const found = await many<{ id: string }>(tx, 'select id from courses where id = any($1::uuid[]) and archived_at is null', [courseIds]);
    if (found.length !== courseIds.length) throw Errors.badRequest('unknown_course', 'Choose courses from the catalogue');
    await tx.query('delete from learning_path_courses where path_id = $1', [pathId]);
    for (const [i, c] of courseIds.entries()) {
      await tx.query('insert into learning_path_courses (tenant_id, path_id, course_id, position) values (app_tenant_id(), $1, $2, $3)', [pathId, c, i + 1]);
    }
  }

  createPath(input: PathInput) {
    return this.db.tenant(async (tx) => {
      const r = (await one<{ id: string }>(tx, 'insert into learning_paths (tenant_id, title, description) values (app_tenant_id(), $1, $2) returning id', [input.title, input.description]))!;
      await this.writePathCourses(tx, r.id, input.courseIds);
      await this.audit.record(tx, { action: 'learning_path.created', resourceType: 'learning_path', resourceId: r.id, changes: input });
      return { id: r.id };
    });
  }

  updatePath(id: string, input: PathInput) {
    return this.db.tenant(async (tx) => {
      const r = await one(tx, 'update learning_paths set title = $2, description = $3 where id = $1 and archived_at is null returning id', [id, input.title, input.description]);
      if (!r) throw Errors.notFound('Learning path');
      await this.writePathCourses(tx, id, input.courseIds);
      await this.audit.record(tx, { action: 'learning_path.updated', resourceType: 'learning_path', resourceId: id, changes: input });
      return { id };
    });
  }

  archivePath(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one(tx, 'update learning_paths set archived_at = now() where id = $1 and archived_at is null returning id', [id]);
      if (!r) throw Errors.notFound('Learning path');
      await this.audit.record(tx, { action: 'learning_path.archived', resourceType: 'learning_path', resourceId: id });
    });
  }

  // Assignments --------------------------------------------------------------------------------------------------

  async assignments(q: { view: 'mine' | 'team'; status?: string; courseId?: string }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (q.view === 'mine') {
        if (!s.employeeId) return [];
        return many(tx, `select ${ASSIGNMENT_COLS} from ${ASSIGNMENT_FROM} where a.employee_id = $1 and a.status <> 'cancelled'
                          order by a.status = 'completed', a.due_on nulls last, a.created_at desc`, [s.employeeId]);
      }
      const params: unknown[] = [q.status ?? null, q.courseId ?? null, s.employeeId ?? null];
      const pred = await this.authz.predicate('learning:manage', EMPLOYEE_SCOPE, params, tx);
      return many(
        tx,
        `select ${ASSIGNMENT_COLS} from ${ASSIGNMENT_FROM}
          where ${pred} and e.id is distinct from $3 and ($2::uuid is null or a.course_id = $2)
            and (case when $1::text = 'overdue' then a.status in ('assigned', 'in_progress') and a.due_on < current_date
                      when $1::text is null then a.status <> 'cancelled' else a.status = $1 end)
          order by ${nameOf('e')}, a.created_at desc limit 1000`,
        params,
      );
    });
  }

  async assign(input: AssignInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const courses = input.pathId
        ? await many<{ id: string; title: string }>(
            tx,
            `select c.id, c.title from learning_path_courses pc join courses c on c.id = pc.course_id join learning_paths p on p.id = pc.path_id
              where pc.path_id = $1 and p.archived_at is null and c.archived_at is null order by pc.position`,
            [input.pathId],
          )
        : await many<{ id: string; title: string }>(tx, 'select id, title from courses where id = $1 and archived_at is null', [input.courseId]);
      if (!courses.length) throw Errors.notFound(input.pathId ? 'Learning path' : 'Course');
      const today = new Date().toISOString().slice(0, 10);
      if (input.dueOn && input.dueOn < today) throw Errors.badRequest('past_due_date', 'The due date cannot be in the past');
      let created = 0;
      const skipped: string[] = [];
      for (const employeeId of new Set(input.employeeIds)) {
        const e = await talentEmployee(tx, employeeId);
        const d = can(s, 'learning:manage', attrsOf(e));
        if (!d.allowed) throw Errors.forbidden(`You cannot assign learning to ${e.name}`);
        if (e.status === 'exited') {
          skipped.push(`${e.name} (left)`);
          continue;
        }
        let mine = 0;
        for (const c of courses) {
          const r = await one(
            tx,
            `insert into course_assignments (tenant_id, employee_id, course_id, path_id, source, assigned_by_membership_id, due_on)
             values (app_tenant_id(), $1, $2, $3, 'assigned', $4, $5) on conflict (tenant_id, employee_id, course_id) where status in ('assigned', 'in_progress') do nothing returning id`,
            [e.id, c.id, input.pathId ?? null, actor.membershipId, input.dueOn],
          );
          if (r) mine++;
          else skipped.push(`${e.name}: ${c.title} (already assigned)`);
        }
        created += mine;
        if (mine) {
          await this.notifications.notify(tx, {
            membershipIds: [e.membership_id], kind: 'learning.assigned',
            title: `New learning for you: ${courses.length === 1 ? courses[0]!.title : `${mine} courses`}${input.dueOn ? `, due ${input.dueOn}` : ''}`, link: '/learning',
          });
        }
      }
      await this.audit.record(tx, { action: 'learning.assigned', resourceType: input.pathId ? 'learning_path' : 'course', resourceId: input.pathId ?? input.courseId!, metadata: { employees: input.employeeIds.length, created, dueOn: input.dueOn } });
      return { created, skipped };
    });
  }

  async enrol(courseId: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const e = await talentEmployee(tx, needEmployee(s.employeeId));
      await this.authz.require('learning:read', attrsOf(e), tx);
      const c = await one<{ title: string; self_enrol: boolean }>(tx, 'select title, self_enrol from courses where id = $1 and archived_at is null', [courseId]);
      if (!c) throw Errors.notFound('Course');
      if (!c.self_enrol) throw Errors.forbidden('This course is assigned by your manager or HR');
      const r = await one<{ id: string }>(
        tx,
        `insert into course_assignments (tenant_id, employee_id, course_id, source, status, started_at) values (app_tenant_id(), $1, $2, 'self_enrolled', 'in_progress', now())
         on conflict (tenant_id, employee_id, course_id) where status in ('assigned', 'in_progress') do nothing returning id`,
        [e.id, courseId],
      );
      if (!r) throw Errors.conflict('already_enrolled', 'You already have this course in progress');
      await this.audit.record(tx, { action: 'learning.enrolled', resourceType: 'course', resourceId: courseId });
      return { id: r.id };
    });
  }

  private async assignment(tx: Tx, id: string) {
    const a = await one<AssignmentRow>(
      tx,
      `select a.id, a.employee_id, a.course_id, a.status, a.source, c.format, c.validity_months, c.title
         from course_assignments a join courses c on c.id = a.course_id where a.id = $1 for update of a`,
      [id],
    );
    if (!a) throw Errors.notFound('Assignment');
    const s = await this.authz.subject(tx);
    const e = await talentEmployee(tx, a.employee_id);
    const own = s.employeeId === e.id;
    const manages = can(s, 'learning:manage', attrsOf(e)).allowed && !own;
    if (!own && !manages && !can(s, 'learning:read', attrsOf(e)).allowed) throw Errors.notFound('Assignment');
    return { a, e, own, manages };
  }

  async start(id: string) {
    return this.db.tenant(async (tx) => {
      const { a, own } = await this.assignment(tx, id);
      if (!own) throw Errors.forbidden('Only the learner starts a course');
      if (a.status !== 'assigned') throw Errors.conflict('invalid_state', `This course is ${a.status.replace('_', ' ')}`);
      await tx.query(`update course_assignments set status = 'in_progress', started_at = now() where id = $1`, [id]);
      return { status: 'in_progress' };
    });
  }

  async complete(id: string, note: string, completedOn?: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const { a, e, own, manages } = await this.assignment(tx, id);
      if (!own && !manages) throw Errors.forbidden();
      // Classroom attendance is confirmed by a manager or HR, not self-reported.
      if (a.format === 'classroom' && !manages) throw Errors.forbidden('Your manager or HR confirms classroom attendance');
      if (!['assigned', 'in_progress'].includes(a.status)) throw Errors.conflict('invalid_state', `This course is ${a.status.replace('_', ' ')}`);
      const today = new Date().toISOString().slice(0, 10);
      const on = completedOn ?? today;
      if (on > today) throw Errors.badRequest('future_date', 'The completion date cannot be in the future');
      await tx.query(
        `update course_assignments set status = 'completed', completed_on = $2, completion_note = $3, completed_by_membership_id = $4,
                started_at = coalesce(started_at, now()), expires_on = case when $5::int is null then null else ($2::date + make_interval(months => $5::int))::date end
          where id = $1`,
        [id, on, note || null, actor.membershipId, a.validity_months],
      );
      await this.audit.record(tx, { action: 'learning.completed', resourceType: 'course_assignment', resourceId: id, metadata: { courseId: a.course_id, completedOn: on, confirmedBy: own ? 'learner' : 'manager' } });
      if (!own) await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'learning.completed', title: `Your completion of ${a.title} was recorded`, link: '/learning' });
      return { status: 'completed' };
    });
  }

  async cancel(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const { a, own, manages } = await this.assignment(tx, id);
      if (!(manages || (own && a.source === 'self_enrolled'))) throw Errors.forbidden('Ask your manager to remove an assigned course');
      if (!['assigned', 'in_progress'].includes(a.status)) throw Errors.conflict('invalid_state', `This course is ${a.status.replace('_', ' ')}`);
      await tx.query(`update course_assignments set status = 'cancelled', cancelled_reason = $2 where id = $1`, [id, reason]);
      await this.audit.record(tx, { action: 'learning.cancelled', resourceType: 'course_assignment', resourceId: id, metadata: { reason } });
      return { status: 'cancelled' };
    });
  }
}

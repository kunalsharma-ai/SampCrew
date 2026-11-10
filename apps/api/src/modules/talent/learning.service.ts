import { Injectable } from '@nestjs/common';
import type { AssignInput, CourseInput, PathInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, hasPermission } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { employeeNames, fieldById } from '../employees/employee-view';
import { attrsOf, needEmployee, talentEmployee } from './talent-common';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const courseView = (c: Doc) => ({
  id: c.id as string, title: c.title as string, description: c.description, format: c.format, contentUrl: c.content_url ?? null, durationMinutes: c.duration_minutes ?? null,
  validityMonths: c.validity_months ?? null, category: c.category, selfEnrol: c.self_enrol, archivedAt: c.archived_at ?? null,
});

/** A date `months` later, as PostgreSQL's `date + interval 'n months'` (the day is clamped to the end of the month). */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Assignments as the API returns them (the SQL ASSIGNMENT_COLS), in the order given. */
async function assignmentViews(tx: TenantTx, rows: Doc[]) {
  if (!rows.length) return [];
  const names = await employeeNames(tx, rows.map((a) => a.employee_id));
  const courses = new Map((await tx.collection('courses').find({ id: { $in: [...new Set(rows.map((a) => a.course_id))] } })).map((c) => [c.id as string, c]));
  const paths = await fieldById(tx, 'learning_paths', rows.map((a) => a.path_id), 'title');
  const now = today();
  return rows.map((a) => {
    const c = courses.get(a.course_id) ?? {};
    return {
      id: a.id as string, employeeId: a.employee_id as string, employeeName: names.get(a.employee_id)?.name ?? '', courseId: a.course_id, courseTitle: c.title, format: c.format,
      contentUrl: c.content_url ?? null, durationMinutes: c.duration_minutes ?? null, pathId: a.path_id ?? null, pathTitle: paths.get(a.path_id) ?? null, source: a.source,
      dueOn: a.due_on ?? null, status: a.status as string, startedAt: a.started_at ?? null, completedOn: a.completed_on ?? null, completionNote: a.completion_note ?? null,
      expiresOn: a.expires_on ?? null, createdAt: a.created_at,
      overdue: ['assigned', 'in_progress'].includes(a.status) && !!a.due_on && a.due_on < now,
      expired: a.status === 'completed' && !!a.expires_on && a.expires_on < now,
    };
  });
}

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
      const courses = await tx.collection('courses').find(all ? {} : { archived_at: null });
      courses.sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at) || String(a.category).localeCompare(String(b.category)) || String(a.title).localeCompare(String(b.title)));
      const ids = courses.map((c) => c.id as string);
      const completions = await countBy(tx, 'course_assignments', 'course_id', ids, { status: 'completed' });
      const mine = s.employeeId ? await tx.collection('course_assignments').find({ employee_id: s.employeeId, course_id: { $in: ids } }, { sort: { created_at: -1 }, projection: { course_id: 1, status: 1 } }) : [];
      return courses.map((c) => ({ ...courseView(c), myStatus: (mine.find((a) => a.course_id === c.id)?.status as string | undefined) ?? null, completions: completions.get(c.id) ?? 0 }));
    });
  }

  createCourse(input: CourseInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('courses').insert({
        title: input.title, description: input.description, format: input.format, content_url: input.contentUrl, duration_minutes: input.durationMinutes,
        validity_months: input.validityMonths, category: input.category, self_enrol: input.selfEnrol, created_by_membership_id: actor.membershipId,
      });
      await this.audit.record(tx, { action: 'course.created', resourceType: 'course', resourceId: r.id, changes: input });
      return { id: r.id as string };
    });
  }

  updateCourse(id: string, input: CourseInput) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('courses').updateOne({ id, archived_at: null }, {
        $set: {
          title: input.title, description: input.description, format: input.format, content_url: input.contentUrl, duration_minutes: input.durationMinutes,
          validity_months: input.validityMonths, category: input.category, self_enrol: input.selfEnrol,
        },
      });
      if (!r) throw Errors.notFound('Course');
      await this.audit.record(tx, { action: 'course.updated', resourceType: 'course', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveCourse(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('courses').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } });
      if (!r) throw Errors.notFound('Course');
      // Open assignments stay so people keep their record; nobody new can be assigned.
      await this.audit.record(tx, { action: 'course.archived', resourceType: 'course', resourceId: id });
    });
  }

  paths() {
    return this.db.tenant(async (tx) => {
      const paths = await tx.collection('learning_paths').find({ archived_at: null });
      paths.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      const links = await tx.collection('learning_path_courses').find({ path_id: { $in: paths.map((p) => p.id) } }, { sort: { position: 1 } });
      const courses = new Map((await tx.collection('courses').find({ id: { $in: [...new Set(links.map((l) => l.course_id))] } })).map((c) => [c.id as string, c]));
      return paths.map((p) => ({
        id: p.id, title: p.title, description: p.description,
        courses: links.filter((l) => l.path_id === p.id && courses.has(l.course_id)).map((l) => {
          const c = courses.get(l.course_id)!;
          return { id: c.id, title: c.title, format: c.format, durationMinutes: c.duration_minutes ?? null };
        }),
      }));
    });
  }

  private async writePathCourses(tx: TenantTx, pathId: string, courseIds: string[]) {
    const found = await tx.collection('courses').count({ id: { $in: courseIds }, archived_at: null });
    if (found !== courseIds.length) throw Errors.badRequest('unknown_course', 'Choose courses from the catalogue');
    const links = tx.collection('learning_path_courses');
    await links.delete({ path_id: pathId });
    await links.insertMany(courseIds.map((c, i) => ({ path_id: pathId, course_id: c, position: i + 1 })));
  }

  createPath(input: PathInput) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('learning_paths').insert({ title: input.title, description: input.description });
      await this.writePathCourses(tx, r.id, input.courseIds);
      await this.audit.record(tx, { action: 'learning_path.created', resourceType: 'learning_path', resourceId: r.id, changes: input });
      return { id: r.id as string };
    });
  }

  updatePath(id: string, input: PathInput) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('learning_paths').updateOne({ id, archived_at: null }, { $set: { title: input.title, description: input.description } });
      if (!r) throw Errors.notFound('Learning path');
      await this.writePathCourses(tx, id, input.courseIds);
      await this.audit.record(tx, { action: 'learning_path.updated', resourceType: 'learning_path', resourceId: id, changes: input });
      return { id };
    });
  }

  archivePath(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('learning_paths').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } });
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
        const rows = await tx.collection('course_assignments').find({ employee_id: s.employeeId, status: { $ne: 'cancelled' } });
        rows.sort((a, b) =>
          Number(a.status === 'completed') - Number(b.status === 'completed') ||
          (a.due_on ?? '\uffff').localeCompare(b.due_on ?? '\uffff') ||
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        return assignmentViews(tx, rows);
      }
      const people = (await tx.collection('employees').distinct<string>('id', await this.authz.filter('learning:manage', EMPLOYEE_FIELDS, tx))).filter((id) => id !== s.employeeId);
      const filter: Doc = { employee_id: { $in: people } };
      if (q.courseId) filter.course_id = q.courseId;
      if (q.status === 'overdue') Object.assign(filter, { status: { $in: ['assigned', 'in_progress'] }, due_on: { $lt: today() } });
      else filter.status = q.status ? q.status : { $ne: 'cancelled' };
      const views = await assignmentViews(tx, await tx.collection('course_assignments').find(filter));
      views.sort((a, b) => a.employeeName.localeCompare(b.employeeName) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      return views.slice(0, 1000);
    });
  }

  async assign(input: AssignInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      let courses: { id: string; title: string }[] = [];
      if (input.pathId) {
        if (await tx.collection('learning_paths').exists({ id: input.pathId, archived_at: null })) {
          const links = await tx.collection('learning_path_courses').find({ path_id: input.pathId }, { sort: { position: 1 } });
          const live = new Map((await tx.collection('courses').find({ id: { $in: links.map((l) => l.course_id) }, archived_at: null })).map((c) => [c.id as string, c.title as string]));
          courses = links.filter((l) => live.has(l.course_id)).map((l) => ({ id: l.course_id as string, title: live.get(l.course_id)! }));
        }
      } else {
        const c = await tx.collection('courses').findOne({ id: input.courseId, archived_at: null }, { projection: { title: 1 } });
        if (c) courses = [{ id: c.id, title: c.title }];
      }
      if (!courses.length) throw Errors.notFound(input.pathId ? 'Learning path' : 'Course');
      if (input.dueOn && input.dueOn < today()) throw Errors.badRequest('past_due_date', 'The due date cannot be in the past');
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
          const table = tx.collection('course_assignments');
          const open = await table.exists({ employee_id: e.id, course_id: c.id, status: { $in: ['assigned', 'in_progress'] } });
          if (!open) {
            await table.insert({ employee_id: e.id, course_id: c.id, path_id: input.pathId ?? null, source: 'assigned', assigned_by_membership_id: actor.membershipId, due_on: input.dueOn ?? null });
            mine++;
          } else skipped.push(`${e.name}: ${c.title} (already assigned)`);
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
      const c = await tx.collection('courses').findOne({ id: courseId, archived_at: null }, { projection: { title: 1, self_enrol: 1 } });
      if (!c) throw Errors.notFound('Course');
      if (!c.self_enrol) throw Errors.forbidden('This course is assigned by your manager or HR');
      const table = tx.collection('course_assignments');
      if (await table.exists({ employee_id: e.id, course_id: courseId, status: { $in: ['assigned', 'in_progress'] } })) {
        throw Errors.conflict('already_enrolled', 'You already have this course in progress');
      }
      const r = await table.insert({ employee_id: e.id, course_id: courseId, source: 'self_enrolled', status: 'in_progress', started_at: new Date() });
      await this.audit.record(tx, { action: 'learning.enrolled', resourceType: 'course', resourceId: courseId });
      return { id: r.id as string };
    });
  }

  private async assignment(tx: TenantTx, id: string) {
    const table = tx.collection('course_assignments');
    await table.lock({ id });
    const row = await table.findOne({ id });
    if (!row) throw Errors.notFound('Assignment');
    const course = (await tx.collection('courses').findOne({ id: row.course_id }))!;
    const a: AssignmentRow = {
      id: row.id, employee_id: row.employee_id, course_id: row.course_id, status: row.status, source: row.source, format: course.format,
      validity_months: course.validity_months ?? null, title: course.title,
    };
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
      await tx.collection('course_assignments').updateOne({ id }, { $set: { status: 'in_progress', started_at: new Date() } });
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
      const now = today();
      const on = completedOn ?? now;
      if (on > now) throw Errors.badRequest('future_date', 'The completion date cannot be in the future');
      const table = tx.collection('course_assignments');
      const started = (await table.findOne({ id }, { projection: { started_at: 1 } }))?.started_at ?? new Date();
      await table.updateOne({ id }, {
        $set: {
          status: 'completed', completed_on: on, completion_note: note || null, completed_by_membership_id: actor.membershipId, started_at: started,
          expires_on: a.validity_months === null ? null : addMonths(on, a.validity_months),
        },
      });
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
      await tx.collection('course_assignments').updateOne({ id }, { $set: { status: 'cancelled', cancelled_reason: reason } });
      await this.audit.record(tx, { action: 'learning.cancelled', resourceType: 'course_assignment', resourceId: id, metadata: { reason } });
      return { status: 'cancelled' };
    });
  }
}

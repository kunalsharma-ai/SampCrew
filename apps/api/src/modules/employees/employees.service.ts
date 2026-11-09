import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { PHOTO_MAX_BYTES, PHOTO_TYPES } from '@crew/contracts';
import type {
  attendanceRegistrationInput,
  confirmInput,
  CreateEmployeeInput,
  employeeLoginActionInput,
  employeeLoginInput,
  designationInput,
  duplicateCheckInput,
  EmployeeColumn,
  employeeDraftInput,
  employeeExportQuery,
  employeeListQuery,
  exitInput,
  extendProbationInput,
  sensitiveInput,
  transferInput,
  updateEmployeeInput,
} from '@crew/contracts';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { decryptField, encryptField, hashPassword, temporaryPasswordValue } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { countBy, MongoService as DatabaseService, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { decodeCursor, page } from '../../platform/http/pagination';
import { NotificationService } from '../../platform/notify/notification.service';
import { sniffMatches, StorageService } from '../../platform/storage/storage.service';
import { DevicesService } from '../attendance/devices.service';
import { LeaveService } from '../leave/leave.service';
import { MembersService } from '../members/members.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { EMPLOYEE_FIELDS, EMPLOYEE_SCOPE, employeeAttrs } from './employee-attrs';
import { applyCurrentPlacement, displayName, type EmployeeRow, employeeNames, employeeViews, fieldById, managerCycle, syncMembership } from './employee-view';

export { employeeAttrs, type EmployeeRow };

/** Columns the ABAC scope predicate uses for employee rows (aliased e). */
export { EMPLOYEE_SCOPE };

type ListQuery = Omit<z.infer<typeof employeeListQuery>, 'cursor' | 'limit'>;

const SORT_KEYS: Record<z.infer<typeof employeeListQuery>['sort'], (e: EmployeeRow) => string> = {
  name: (e) => `${e.firstName} ${e.lastName}`.toLowerCase(),
  code: (e) => e.employeeCode.toLowerCase(),
  joined: (e) => e.dateOfJoining,
  department: (e) => String(e.departmentName ?? '').toLowerCase(),
  location: (e) => String(e.locationName ?? '').toLowerCase(),
  status: (e) => e.status,
};

const EXPORT_HEADERS: Record<EmployeeColumn, string> = {
  name: 'Name', code: 'Employee code', designation: 'Designation', department: 'Department', location: 'Location', entity: 'Legal entity',
  manager: 'Manager', workEmail: 'Work email', type: 'Employment type', joined: 'Date of joining', status: 'Status',
};
function exportValue(r: EmployeeRow, c: EmployeeColumn): unknown {
  switch (c) {
    case 'name': return r.displayName;
    case 'code': return r.employeeCode;
    case 'designation': return r.designationName;
    case 'department': return r.departmentName;
    case 'location': return r.locationName;
    case 'entity': return r.legalEntityName;
    case 'manager': return r.managerName;
    case 'workEmail': return r.workEmail;
    case 'type': return r.employmentType;
    case 'joined': return r.dateOfJoining;
    case 'status': return r.status;
  }
}

const PROFILE_COLUMNS: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', preferredName: 'preferred_name', workEmail: 'work_email', personalEmail: 'personal_email',
  phone: 'phone', dateOfBirth: 'date_of_birth', gender: 'gender',
};
const OWN_FIELDS = new Set(['preferredName', 'personalEmail', 'phone']);
const SENSITIVE_COLUMNS = { bankAccount: 'bank_account_enc', bankRouting: 'bank_routing_enc', taxId: 'tax_id_enc', nationalId: 'national_id_enc' } as const;

const LIFECYCLE_KIND: Record<string, string> = { transfer: 'transferred', promotion: 'promoted', manager_change: 'manager_changed', correction: 'transferred', other: 'transferred' };

const today = () => new Date().toISOString().slice(0, 10);
const DAY = 86_400_000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
/** date + n months, clamped to the end of a shorter month (PostgreSQL interval arithmetic). */
function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const digitsOf = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/**
 * Employee records. The employee is the person record HR manages; a SampCrew login (membership) is optional and
 * linked 1:1. Job placement lives in effective-dated employment_records; employees.current_* is derived from
 * the record in effect today, and the membership (which drives access scopes) follows it.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationService,
    private readonly members: MembersService,
    private readonly onboarding: OnboardingService,
    private readonly leave: LeaveService,
    private readonly storage: StorageService,
    private readonly devices: DevicesService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------------------------------------
  // Designations
  // ---------------------------------------------------------------------------------------------------------

  listDesignations() {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('designations').find({ archived_at: null });
      const counts = await countBy(tx, 'employees', 'current_designation_id', rows.map((r) => r.id), { status: { $ne: 'exited' } });
      return rows
        .sort((a, b) => (a.level ?? Infinity) - (b.level ?? Infinity) || String(a.name).localeCompare(String(b.name)))
        .map((r) => ({ id: r.id, name: r.name, code: r.code ?? null, level: r.level ?? null, employeeCount: counts.get(r.id) ?? 0 }));
    });
  }

  createDesignation(input: z.infer<typeof designationInput>) {
    return this.db.tenant(async (tx) => {
      const row = await tx
        .collection('designations')
        .insert({ name: input.name, code: input.code ?? null, level: input.level ?? null })
        .catch(uniqueAs('designation_exists', 'A designation with this name already exists'));
      await this.audit.record(tx, { action: 'designation.created', resourceType: 'designation', resourceId: row.id, changes: input });
      return { id: row.id, name: row.name, code: row.code ?? null, level: row.level ?? null };
    });
  }

  updateDesignation(id: string, input: Partial<z.infer<typeof designationInput>>) {
    return this.db.tenant(async (tx) => {
      const found = await tx.collection('designations').findOne({ id, archived_at: null });
      if (!found) throw Errors.notFound('Designation');
      const before = { name: found.name, code: found.code ?? null, level: found.level ?? null };
      const after = { name: input.name ?? before.name, code: input.code !== undefined ? input.code : before.code, level: input.level !== undefined ? input.level : before.level };
      await tx
        .collection('designations')
        .updateOne({ id }, { $set: after })
        .catch(uniqueAs('designation_exists', 'A designation with this name already exists'));
      // Logins show the designation as their title.
      if (after.name !== before.name) {
        const holders = await tx.collection('employees').find({ current_designation_id: id, membership_id: { $ne: null } }, { projection: { membership_id: 1 } });
        if (holders.length) await tx.collection('memberships').update({ id: { $in: holders.map((h) => h.membership_id) } }, { $set: { title: after.name } });
      }
      await this.audit.record(tx, { action: 'designation.updated', resourceType: 'designation', resourceId: id, changes: diff(before, after) });
      return { id, ...after };
    });
  }

  archiveDesignation(id: string) {
    return this.db.tenant(async (tx) => {
      if (await tx.collection('employees').exists({ current_designation_id: id, status: { $ne: 'exited' } })) {
        throw Errors.conflict('designation_in_use', 'Employees still hold this designation');
      }
      if (!(await tx.collection('designations').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } }))) throw Errors.notFound('Designation');
      await this.audit.record(tx, { action: 'designation.archived', resourceType: 'designation', resourceId: id });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Directory and profile
  // ---------------------------------------------------------------------------------------------------------

  /** The directory: people the caller may see that match the filters, as views, in the chosen order. */
  private async directory(tx: TenantTx, q: ListQuery): Promise<EmployeeRow[]> {
    const filter: Record<string, unknown> = { ...(await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx)) };
    const and: Record<string, unknown>[] = [filter];
    if (q.status) and.push({ status: q.status });
    else if (q.includeExited !== 'true') and.push({ status: { $ne: 'exited' } });
    if (q.departmentId) and.push({ current_department_id: q.departmentId });
    if (q.legalEntityId) and.push({ current_legal_entity_id: q.legalEntityId });
    let rows = await employeeViews(tx, await tx.collection('employees').find({ $and: and }));
    if (q.q) {
      const needle = q.q.toLowerCase();
      rows = rows.filter((e) =>
        [`${e.firstName} ${e.lastName}`, e.preferredName ?? '', e.employeeCode, e.workEmail ?? ''].some((v) => String(v).toLowerCase().includes(needle)),
      );
    }
    // Ordered on (sort key, id), in either direction, which is also the keyset for pagination.
    const key = SORT_KEYS[q.sort];
    const sign = q.dir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => sign * (cmp(key(a), key(b)) || cmp(a.id, b.id)));
  }

  async list(q: z.infer<typeof employeeListQuery>) {
    return this.db.tenant(async (tx) => {
      const all = await this.directory(tx, q);
      const key = SORT_KEYS[q.sort];
      const cursor = decodeCursor(q.cursor);
      const sign = q.dir === 'desc' ? -1 : 1;
      const after = cursor ? all.filter((e) => sign * (cmp(key(e), cursor[0]) || cmp(e.id, cursor[1])) > 0) : all;
      // Personal contact details are not part of the directory listing.
      const items = after
        .slice(0, q.limit + 1)
        .map(({ personalEmail: _p, phone: _ph, dateOfBirth: _d, gender: _g, exitReason: _x, ...rest }) => ({ ...rest, sortKey: key(rest as EmployeeRow) }));
      const out = page(items as (EmployeeRow & { sortKey: string })[], q.limit, (r) => r.sortKey);
      return { ...out, items: out.items.map(({ sortKey: _k, ...r }) => r), total: all.length };
    });
  }

  /** The directory as CSV with the chosen columns, same scope and filters as the list. Audited. */
  async exportCsv(q: z.infer<typeof employeeExportQuery>, format: 'csv' | 'xlsx' = 'csv') {
    return this.db.tenant(async (tx) => {
      const rows = await this.directory(tx, q);
      if (rows.length > 20000) throw Errors.badRequest('export_too_large', 'More than 20,000 people match. Narrow the filters and export again.');
      const cell = (v: unknown) => {
        let t = v === null || v === undefined ? '' : String(v);
        // Neutralise spreadsheet formulas (CSV injection).
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const lines = [q.columns.map((c) => EXPORT_HEADERS[c]).join(',')];
      for (const r of rows) lines.push(q.columns.map((c) => cell(exportValue(r, c))).join(','));
      await this.audit.record(tx, { action: 'employee.directory_exported', resourceType: 'employee', resourceId: null, changes: { format, rows: rows.length, columns: q.columns, filters: { q: q.q ?? null, status: q.status ?? null, departmentId: q.departmentId ?? null } } });
      return { fileName: `employees-${new Date().toISOString().slice(0, 10)}.csv`, content: `﻿${lines.join('\r\n')}\r\n` };
    });
  }

  /** People who may already have a record, so a hire is not entered twice. */
  async duplicates(input: z.infer<typeof duplicateCheckInput>) {
    return this.db.tenant(async (tx) => {
      const tests: { reason: string; test: (e: Record<string, unknown>) => boolean }[] = [];
      const eq = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
      if (input.workEmail?.includes('@')) tests.push({ reason: 'Same work email', test: (e) => eq(e.work_email, input.workEmail!) });
      if (input.personalEmail?.includes('@')) tests.push({ reason: 'Same personal email', test: (e) => eq(e.personal_email, input.personalEmail!) });
      const digits = digitsOf(input.phone);
      if (digits.length >= 7) tests.push({ reason: 'Same phone number', test: (e) => digitsOf(e.phone).slice(-10) === digits.slice(-10) });
      if (input.firstName && input.lastName) {
        const sameName = (e: Record<string, unknown>) => eq(e.first_name, input.firstName!) && eq(e.last_name, input.lastName!);
        if (input.dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)) {
          tests.push({ reason: 'Same name and date of birth', test: (e) => sameName(e) && e.date_of_birth === input.dateOfBirth });
        }
        tests.push({ reason: 'Same name', test: sameName });
      }
      if (!tests.length) return { matches: [] };
      const scope = await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
      const found = (await tx.collection('employees').find(scope))
        .map((e) => ({ e, reasons: tests.filter((t) => t.test(e)).map((t) => t.reason) }))
        .filter((x) => x.reasons.length)
        .sort((a, b) => Number(a.e.status === 'exited') - Number(b.e.status === 'exited') || cmp(b.e.date_of_joining, a.e.date_of_joining))
        .slice(0, 5);
      const departments = await fieldById(tx, 'departments', found.map((x) => x.e.current_department_id));
      return {
        matches: found.map(({ e, reasons }) => ({
          id: e.id,
          displayName: displayName(e as never),
          employeeCode: e.employee_code,
          status: e.status,
          departmentName: departments.get(e.current_department_id) ?? null,
          reasons,
        })),
      };
    });
  }

  // Hire drafts -----------------------------------------------------------------------------------------------

  async drafts() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => (await tx.collection('employee_drafts').find({ membership_id: me }, { sort: { updated_at: -1 }, limit: 20 })).map(draftView));
  }

  async saveDraft(id: string | null, input: z.infer<typeof employeeDraftInput>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      if (id) {
        const r = await tx.collection('employee_drafts').updateAndGet({ id, membership_id: me }, { $set: { step: input.step, data: input.data } });
        if (!r) throw Errors.notFound('Draft');
        return draftView(r);
      }
      const n = await tx.collection('employee_drafts').count({ membership_id: me });
      if (n >= 20) throw Errors.conflict('too_many_drafts', 'You have 20 unfinished hires. Finish or discard one first.');
      return draftView(await tx.collection('employee_drafts').insert({ membership_id: me, step: input.step, data: input.data }));
    });
  }

  async deleteDraft(id: string) {
    const me = requestContext.tenantActor().membershipId;
    const n = await this.db.tenant((tx) => tx.collection('employee_drafts').deleteOne({ id, membership_id: me }));
    if (!n) throw Errors.notFound('Draft');
  }

  async load(tx: TenantTx, id: string): Promise<EmployeeRow> {
    const doc = await tx.collection('employees').findOne({ id });
    if (!doc) throw Errors.notFound('Employee');
    return (await employeeViews(tx, [doc]))[0]!;
  }

  /** Profile plus what the caller may do with it, so the UI only shows working actions. */
  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:read', employeeAttrs(e), tx);
      const s = await this.authz.subject(tx);
      const a = employeeAttrs(e);
      const covers = (perm: string, broadOnly = false) => grantsFor(s, perm).some((g) => (!broadOnly || g.scope !== 'own') && grantCovers(s, g, a));
      const isSelf = !!s.employeeId && s.employeeId === e.id;
      const features = (await this.entitlements.current(tx)).features;
      return {
        ...e,
        isSelf,
        can: {
          update: covers('employees:update', true),
          updateOwn: isSelf && covers('employees:update'),
          viewSensitive: covers('employees:sensitive:read'),
          lifecycle: covers('employees:lifecycle'),
          readDocuments: features.has('documents') && covers('documents:read'),
          manageDocuments: features.has('documents') && covers('documents:manage'),
          readLeave: features.has('leave') && covers('leave:read'),
          onboarding: features.has('onboarding'),
        },
      };
    });
  }

  async me() {
    const actor = requestContext.tenantActor();
    const row = await this.db.tenant((tx) => tx.collection('employees').findOne({ membership_id: actor.membershipId }, { projection: { _id: 1 } }));
    if (!row) return { employee: null };
    return { employee: await this.get(row.id) };
  }

  /**
   * The Employee 360 summary: one figure or short list per area (attendance, leave, pay, performance, learning,
   * recognition, requests, documents) and a merged activity timeline. Each area is included only when the plan has
   * the module and the caller's own permissions cover this employee for it, exactly as the area's own pages check;
   * an area left out is null, so the page can say it is hidden rather than empty.
   */
  async summary360(id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:read', employeeAttrs(e), tx);
      const s = await this.authz.subject(tx);
      const a = employeeAttrs(e);
      const covers = (perm: string, broadOnly = false) => grantsFor(s, perm).some((g) => (!broadOnly || g.scope !== 'own') && grantCovers(s, g, a));
      const isSelf = !!s.employeeId && s.employeeId === e.id;
      const f = (await this.entitlements.current(tx)).features;
      const day = today();
      const timeline: { at: string | Date; kind: string; title: string; detail: string | null; link: string | null }[] = [];

      const first = await tx.collection('employment_records').findOne({ employee_id: id }, { sort: { effective_from: 1 } });
      const tenure = first ? { joined: first.effective_from as string, days: daysBetween(first.effective_from, day) } : null;

      let attendance = null;
      if (f.has('attendance_basic') && covers('attendance:read')) {
        const days = await tx.collection('attendance_days').find({ employee_id: id, work_date: { $gte: addDays(day, -29), $lte: day } });
        const worked = days.filter((d) => ['present', 'half_day'].includes(d.status));
        attendance = {
          from: new Date(Date.now() - 29 * DAY).toISOString().slice(0, 10),
          to: day,
          present: worked.length,
          absent: days.filter((d) => d.status === 'absent').length,
          missingPunch: days.filter((d) => d.status === 'missing_punch').length,
          onLeave: days.filter((d) => ['on_leave', 'half_day_leave'].includes(d.status)).length,
          late: days.filter((d) => d.late_minutes > 0).length,
          workingDays: days.filter((d) => d.day_type === 'working' && !['in_progress', 'not_joined'].includes(d.status)).length,
          avgWorkedMinutes: worked.length ? Math.round(worked.reduce((t, d) => t + (d.worked_minutes ?? 0), 0) / worked.length) : 0,
          overtimeMinutes: days.reduce((t, d) => t + (d.approved_overtime_minutes ?? 0), 0),
        };
      }

      let leave = null;
      if (f.has('leave') && covers('leave:read')) {
        const requests = await tx.collection('leave_requests').find({ employee_id: id }, { sort: { created_at: -1 } });
        const types = await fieldById(tx, 'leave_types', requests.map((r) => r.leave_type_id));
        const reqs = requests
          .filter((r) => types.has(r.leave_type_id))
          .slice(0, 20)
          .map((r) => ({ id: r.id, type: types.get(r.leave_type_id)!, startDate: r.start_date, endDate: r.end_date, days: r.days as string, status: r.status, createdAt: r.created_at }));
        const year = day.slice(0, 4);
        const taken = requests.filter((r) => r.status === 'approved' && String(r.start_date).startsWith(year)).reduce((t, r) => t + Number(r.days), 0);
        leave = {
          pending: reqs.filter((r) => r.status === 'pending').length,
          takenThisYear: taken.toFixed(2).replace(/\.?0+$/, '') || '0',
          next: reqs.filter((r) => r.status === 'approved' && r.startDate >= day).sort((x, y) => x.startDate.localeCompare(y.startDate))[0] ?? null,
        };
        for (const r of reqs.slice(0, 8)) timeline.push({ at: r.createdAt, kind: 'leave', title: `${r.type}: ${r.days} day${Number(r.days) === 1 ? '' : 's'} from ${r.startDate}`, detail: r.status, link: null });
      }

      // Pay is sensitive: only people whose payroll access covers this employee see salary; the employee sees their own payslips.
      let pay = null;
      if (f.has('payroll') && (covers('payroll:read') || (isSelf && covers('payslips:read')))) {
        const salaryRow = covers('payroll:read') ? await tx.collection('employee_salaries').findOne({ employee_id: id, effective_from: { $lte: day } }, { sort: { effective_from: -1 } }) : undefined;
        const items = await tx.collection('payroll_items').find({ employee_id: id });
        const runs = await tx.collection('payroll_runs').find({ id: { $in: items.map((i) => i.run_id) }, status: 'finalised' }, { sort: { period_end: -1 } });
        const run = runs[0];
        const item = run && items.find((i) => i.run_id === run.id);
        pay = {
          salary: salaryRow ? { annualCtc: salaryRow.annual_ctc, currency: salaryRow.currency, effectiveFrom: salaryRow.effective_from } : null,
          lastPayslip: run && item ? { periodEnd: run.period_end, net: item.net, currency: run.currency, payDate: run.pay_date ?? null } : null,
        };
      }

      let performance = null;
      if (f.has('performance') && covers('performance:read')) {
        const goals = (await tx.collection('goals').find({ employee_id: id, status: { $ne: 'cancelled' } }))
          .sort((x, y) => Number(y.status === 'active') - Number(x.status === 'active') || cmp(y.period_end, x.period_end))
          .slice(0, 20)
          .map((g) => ({ title: g.title, status: g.status, progress: g.progress as string, confidence: g.confidence ?? null, periodEnd: g.period_end, updatedAt: g.updated_at }));
        // Ratings: managers and HR see the latest finalised rating; the employee only once it is released to them.
        const broad = covers('performance:read', true) && !isSelf;
        const reviews = await tx.collection('reviews').find({ employee_id: id, excluded: false, final_rating: { $ne: null }, ...(broad ? {} : { released_at: { $ne: null } }) });
        const cycles = new Map((await tx.collection('review_cycles').find({ id: { $in: reviews.map((r) => r.cycle_id) } })).map((c) => [c.id, c]));
        const latest = reviews.filter((r) => cycles.has(r.cycle_id)).sort((x, y) => cycles.get(y.cycle_id)!.created_at - cycles.get(x.cycle_id)!.created_at)[0];
        const active = goals.filter((g) => g.status === 'active');
        performance = {
          activeGoals: active.length,
          completedGoals: goals.filter((g) => g.status === 'completed').length,
          atRisk: active.filter((g) => g.confidence === 'at_risk' || g.confidence === 'off_track').length,
          averageProgress: active.length ? (active.reduce((t, g) => t + Number(g.progress), 0) / active.length).toFixed(0) : null,
          goals: active.slice(0, 5).map(({ updatedAt: _u, ...g }) => g),
          latestReview: latest ? { cycle: cycles.get(latest.cycle_id)!.name, rating: latest.final_rating, releasedAt: latest.released_at ?? null } : null,
        };
        for (const g of goals.slice(0, 5)) timeline.push({ at: g.updatedAt, kind: 'goal', title: `Goal: ${g.title}`, detail: g.status === 'completed' ? 'completed' : `${Number(g.progress).toFixed(0)}%`, link: null });
      }

      let learning = null;
      if (f.has('learning') && covers('learning:read')) {
        const all = await tx.collection('course_assignments').find({ employee_id: id });
        const open = all.filter((x) => ['assigned', 'in_progress'].includes(x.status));
        const completed = all.filter((x) => x.status === 'completed');
        const recentDone = completed.sort((x, y) => cmp(y.completed_on, x.completed_on)).slice(0, 5);
        const titles = await fieldById(tx, 'courses', recentDone.map((x) => x.course_id), 'title');
        const done = recentDone.filter((x) => titles.has(x.course_id)).map((x) => ({ title: titles.get(x.course_id)!, completedOn: x.completed_on ?? null }));
        learning = {
          open: open.length,
          completed: completed.length,
          overdue: open.filter((x) => x.due_on && x.due_on < day).length,
          expired: completed.filter((x) => x.expires_on && x.expires_on < day).length,
          recent: done,
        };
        for (const d of done) timeline.push({ at: `${d.completedOn}T12:00:00Z`, kind: 'learning', title: `Completed ${d.title}`, detail: null, link: null });
      }

      // Recognition is posted to the whole workspace, so anyone who may see the employee may see what they received.
      let recognition = null;
      if (f.has('engagement')) {
        const received = await tx.collection('recognitions').find({ to_employee_id: id, hidden_at: null }, { sort: { created_at: -1 } });
        const top = received.slice(0, 5);
        const senders = await employeeNames(tx, top.map((r) => r.from_employee_id));
        const values = await fieldById(tx, 'company_values', top.map((r) => r.value_id));
        const recent = top
          .filter((r) => senders.has(r.from_employee_id))
          .map((r) => {
            const from = senders.get(r.from_employee_id)!.doc;
            return { from: `${from.preferred_name ?? from.first_name} ${from.last_name}`, value: values.get(r.value_id) ?? null, message: r.message, createdAt: r.created_at };
          });
        const since = new Date(Date.now() - 90 * DAY);
        recognition = { last90Days: received.filter((r) => r.created_at > since).length, recent };
        for (const r of recent) timeline.push({ at: r.createdAt, kind: 'recognition', title: `Recognised by ${r.from}${r.value ? ` for ${r.value}` : ''}`, detail: r.message, link: null });
      }

      // Requests: helpdesk handlers see non-confidential cases; the employee sees all of their own.
      let requests = null;
      if (isSelf || covers('helpdesk:manage')) {
        const cases = (await tx.collection('helpdesk_cases').find({ employee_id: id, ...(isSelf ? {} : { confidential: false }) }, { sort: { created_at: -1 }, limit: 10 })).map((c) => ({
          id: c.id as string,
          number: c.number as number,
          subject: c.subject as string,
          status: c.status as string,
          createdAt: c.created_at as Date,
        }));
        requests = { open: cases.filter((c) => !['resolved', 'closed'].includes(c.status)).length, recent: cases.slice(0, 5) };
        for (const c of cases.slice(0, 5)) timeline.push({ at: c.createdAt, kind: 'request', title: `Request #${c.number}: ${c.subject}`, detail: c.status.replace(/_/g, ' '), link: `/helpdesk/${c.id}` });
      }

      let documents = null;
      if (f.has('documents') && covers('documents:read')) {
        const docs = await tx.collection('employee_documents').find({ employee_id: id, archived_at: null }, { sort: { created_at: -1 }, limit: 20 });
        documents = { count: docs.length, categories: [...new Set(docs.map((d) => d.category as string))] };
        for (const d of docs.slice(0, 5)) timeline.push({ at: d.created_at, kind: 'document', title: `Document added: ${d.title}`, detail: String(d.category).replace(/_/g, ' '), link: null });
      }

      const events = await tx.collection('lifecycle_events').find({ employee_id: id }, { sort: { created_at: -1 }, limit: 10 });
      for (const ev of events) {
        timeline.push({ at: `${ev.effective_on}T09:00:00Z`, kind: 'job', title: String(ev.kind).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), detail: `effective ${ev.effective_on}`, link: null });
      }

      timeline.sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime());
      return {
        employeeId: id, isSelf, joinedOn: tenure?.joined ?? null, tenureDays: tenure?.days ?? null,
        attendance, leave, pay, performance, learning, recognition, requests, documents,
        timeline: timeline.slice(0, 30),
      };
    });
  }

  /** Job history and lifecycle events, newest first. */
  async history(id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:read', employeeAttrs(e), tx);
      const rows = await tx.collection('employment_records').find({ employee_id: id }, { sort: { effective_from: -1 } });
      const [entities, departments, locations, designations, managers] = await Promise.all([
        fieldById(tx, 'legal_entities', rows.map((r) => r.legal_entity_id)),
        fieldById(tx, 'departments', rows.map((r) => r.department_id)),
        fieldById(tx, 'locations', rows.map((r) => r.location_id)),
        fieldById(tx, 'designations', rows.map((r) => r.designation_id)),
        employeeNames(tx, rows.map((r) => r.manager_employee_id)),
      ]);
      const day = today();
      const records = rows.map((r) => ({
        id: r.id,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to ?? null,
        reason: r.change_reason,
        note: r.note ?? null,
        legalEntityName: entities.get(r.legal_entity_id) ?? null,
        departmentName: departments.get(r.department_id) ?? null,
        locationName: locations.get(r.location_id) ?? null,
        designationName: designations.get(r.designation_id) ?? null,
        managerName: managers.get(r.manager_employee_id)?.name ?? null,
        grade: r.grade ?? null,
        employmentType: r.employment_type,
        scheduled: r.effective_from > day,
      }));
      const evs = (await tx.collection('lifecycle_events').find({ employee_id: id })).sort((x, y) => cmp(y.effective_on, x.effective_on) || y.created_at - x.created_at);
      const creators = await (await usersTable(tx)).find({ id: { $in: [...new Set(evs.map((ev) => ev.created_by).filter(Boolean))] } }, { projection: { full_name: 1 } });
      const by = new Map(creators.map((u) => [u.id, u.full_name ?? null]));
      const events = evs.map((ev) => ({ id: ev.id, kind: ev.kind, effectiveOn: ev.effective_on, details: ev.details, createdAt: ev.created_at, by: by.get(ev.created_by) ?? null }));
      return { records, events };
    });
  }

  /** Direct reports, for the profile and org views. */
  async reports(id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:read', employeeAttrs(e), tx);
      const scope = await this.authz.filter('employees:read', EMPLOYEE_FIELDS, tx);
      const docs = await tx.collection('employees').find({ $and: [scope, { current_manager_employee_id: id, status: { $ne: 'exited' } }] }, { sort: { first_name: 1 } });
      return employeeViews(tx, docs);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Hiring
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Hires an employee. `within` runs in the same transaction after the record exists, so a caller such as
   * recruitment can mark its own records (application hired, opening filled) atomically with the hire.
   */
  async create(input: CreateEmployeeInput, within?: (tx: TenantTx, employeeId: string) => Promise<void>) {
    const actor = requestContext.tenantActor();
    let inviteToken: string | undefined;
    let temporaryPassword: string | undefined;
    const created = await this.db.tenant(async (tx) => {
      inviteToken = undefined;
      temporaryPassword = undefined;
      await this.authz.require('employees:create', { legalEntityId: input.legalEntityId }, tx);
      const count = await tx.collection('employees').count({ status: { $ne: 'exited' } });
      await this.entitlements.requireWithinLimit('max_employees', count, tx);
      await this.checkPlacement(tx, input, null);

      const code = await this.nextEmployeeCode(tx);
      const startsLater = input.dateOfJoining > today();
      const status = startsLater ? 'pre_boarding' : input.probationMonths > 0 ? 'probation' : 'active';
      const row = await tx
        .collection('employees')
        .insert({
          employee_code: code,
          first_name: input.firstName,
          last_name: input.lastName,
          preferred_name: input.preferredName ?? null,
          work_email: input.workEmail ?? null,
          personal_email: input.personalEmail ?? null,
          phone: input.phone ?? null,
          date_of_birth: input.dateOfBirth ?? null,
          gender: input.gender ?? null,
          date_of_joining: input.dateOfJoining,
          probation_end_date: input.probationMonths > 0 ? addDays(addMonths(input.dateOfJoining, input.probationMonths), -1) : null,
          confirmation_date: input.probationMonths === 0 ? input.dateOfJoining : null,
          employment_type: input.employmentType,
          status,
          current_legal_entity_id: input.legalEntityId,
          current_department_id: input.departmentId ?? null,
          current_location_id: input.locationId ?? null,
          current_designation_id: input.designationId ?? null,
          current_manager_employee_id: input.managerEmployeeId ?? null,
          current_grade: input.grade ?? null,
        })
        .catch(uniqueAs('work_email_taken', 'Another current employee already uses this work email'));
      await tx.collection('employment_records').insert({
        employee_id: row.id,
        effective_from: input.dateOfJoining,
        legal_entity_id: input.legalEntityId,
        department_id: input.departmentId ?? null,
        location_id: input.locationId ?? null,
        designation_id: input.designationId ?? null,
        manager_employee_id: input.managerEmployeeId ?? null,
        grade: input.grade ?? null,
        employment_type: input.employmentType,
        change_reason: 'hire',
        created_by: actor.userId,
      });
      await this.event(tx, row.id, 'hired', input.dateOfJoining, { employeeCode: code });

      const loginMode = input.loginMode ?? (input.inviteToCrew ? 'invite' : 'none');
      if (input.membershipId) {
        await this.linkMembership(tx, row.id, input.membershipId);
      } else if (loginMode !== 'none' && input.workEmail) {
        const login = await this.giveLogin(tx, row.id, loginMode, input.initialPassword);
        inviteToken = login.inviteToken;
        temporaryPassword = login.temporaryPassword;
      }
      await this.registerAttendance(tx, row.id, { defaultShiftId: input.defaultShiftId ?? null, enrolments: input.attendanceEnrolments ?? [] }, true);

      // Onboarding checklists are a plan module: without it the joiner is hired with no checklist.
      const onboardingOn = (await this.entitlements.current(tx)).features.has('onboarding');
      const templateId = !onboardingOn
        ? undefined
        : input.onboardingTemplateId === undefined
          ? ((await tx.collection('onboarding_templates').findOne({ is_default: true, archived_at: null }))?.id as string | undefined)
          : input.onboardingTemplateId;
      if (templateId) await this.onboarding.instantiate(tx, row.id, templateId);
      // Credit leave already due (e.g. an up-front annual entitlement) so balances are right from day one.
      await this.leave.runAccruals(tx, today(), row.id);

      if (within) await within(tx, row.id);
      const e = await this.load(tx, row.id);
      await this.audit.record(tx, {
        action: 'employee.created', resourceType: 'employee', resourceId: row.id,
        changes: { employeeCode: code, name: e.displayName, legalEntityId: e.legalEntityId, departmentId: e.departmentId, dateOfJoining: e.dateOfJoining },
      });
      await this.outbox.publish(tx, actor.tenantId, 'employee.created', { employeeId: row.id });
      if (input.managerEmployeeId) {
        const mgr = await tx.collection('employees').findOne({ id: input.managerEmployeeId });
        await this.notifications.notify(tx, {
          membershipIds: [mgr?.membership_id],
          kind: 'employee.joining',
          title: `${e.displayName} joins your team on ${e.dateOfJoining}`,
          link: `/employees/${row.id}`,
          email: true,
        });
      }
      return e;
    });
    const invite = inviteToken && !this.config.isProductionLike ? `${this.config.WEB_PUBLIC_URL}/accept-invite?token=${inviteToken}` : undefined;
    return { employee: created, inviteUrl: invite, ...(temporaryPassword ? { login: { email: created.workEmail, temporaryPassword } } : {}) };
  }

  /**
   * Gives an employee a SampCrew login with the Employee baseline role, placed like their job record: an emailed
   * invitation, or a login that works now with a temporary password. A password SampCrew generates is returned once,
   * so HR can hand it over; one HR typed is not echoed back.
   */
  private async giveLogin(tx: TenantTx, employeeId: string, mode: 'invite' | 'password', typedPassword?: string) {
    const e = await this.load(tx, employeeId);
    if (!e.workEmail) throw Errors.badRequest('work_email_required', 'Add a work email first: it is the sign-in name');
    const manager = e.managerEmployeeId ? await tx.collection('employees').findOne({ id: e.managerEmployeeId }) : undefined;
    const placement = {
      email: e.workEmail,
      fullName: `${e.firstName} ${e.lastName}`.trim(),
      roleKeys: ['employee'],
      legalEntityId: e.legalEntityId ?? undefined,
      departmentId: e.departmentId,
      locationId: e.locationId,
      managerMembershipId: (manager?.membership_id as string | null | undefined) ?? null,
    };
    if (mode === 'invite') {
      const inv = await this.members.createInvitation(tx, placement);
      await this.setMembership(tx, employeeId, inv.membershipId);
      await this.event(tx, employeeId, 'linked_login', today(), { membershipId: inv.membershipId, via: 'invitation' });
      return { inviteToken: inv.token, temporaryPassword: undefined };
    }
    const generated = typedPassword ? undefined : temporaryPasswordValue();
    const m = await this.members.createLoginWithPassword(tx, placement, typedPassword ?? generated!);
    await this.setMembership(tx, employeeId, m.membershipId);
    await this.onboarding.assignEmployeeTasks(tx, employeeId, m.membershipId);
    await this.event(tx, employeeId, 'linked_login', today(), { membershipId: m.membershipId, via: 'temporary_password' });
    return { inviteToken: undefined, temporaryPassword: generated };
  }

  /** Links a login to the employee; the membership then follows the employee's placement. */
  private async setMembership(tx: TenantTx, employeeId: string, membershipId: string) {
    await tx.collection('employees').updateOne({ id: employeeId }, { $set: { membership_id: membershipId } });
    await syncMembership(tx, employeeId);
  }

  /** Creates a SampCrew login for an employee who has none (from their profile). */
  async createLogin(id: string, input: z.infer<typeof employeeLoginInput>) {
    let inviteToken: string | undefined;
    let temporaryPassword: string | undefined;
    const employee = await this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:update', employeeAttrs(e), tx);
      await this.authz.require('users:manage', { legalEntityId: e.legalEntityId, departmentId: e.departmentId, locationId: e.locationId }, tx);
      if (e.membershipId) throw Errors.conflict('already_linked', 'This employee already has a SampCrew login');
      if (e.status === 'exited') throw Errors.conflict('employee_exited', 'This person has left; they cannot be given a login');
      const r = await this.giveLogin(tx, id, input.mode, input.initialPassword);
      inviteToken = r.inviteToken;
      temporaryPassword = r.temporaryPassword;
      await this.audit.record(tx, { action: 'employee.login_created', resourceType: 'employee', resourceId: id, metadata: { mode: input.mode } });
      return this.load(tx, id);
    });
    const inviteUrl = inviteToken && !this.config.isProductionLike ? `${this.config.WEB_PUBLIC_URL}/accept-invite?token=${inviteToken}` : undefined;
    return { employee, inviteUrl, ...(temporaryPassword ? { login: { email: employee.workEmail, temporaryPassword } } : {}) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Login details and control for workspace admins
  // ---------------------------------------------------------------------------------------------------------

  private async loginTarget(tx: TenantTx, id: string) {
    const e = await this.load(tx, id);
    await this.authz.require('employees:read', employeeAttrs(e), tx);
    if (!e.membershipId) throw Errors.notFound('SampCrew login');
    const membership = (await tx.collection('memberships').findOne({ id: e.membershipId }))!;
    const ownerRole = await tx.collection('roles').findOne({ key: 'tenant_owner' });
    const owner = !!ownerRole && (await tx.collection('role_assignments').exists({ membership_id: e.membershipId, role_id: ownerRole.id }));
    return { e, m: { user_id: membership.user_id as string, status: membership.status as string, owner } };
  }

  /** The login ID (work email) and sign-in state. Never a password: only its one-way hash is stored. */
  async loginDetails(id: string) {
    return this.db.tenant(async (tx) => {
      const { e, m } = await this.loginTarget(tx, id);
      await this.authz.require('users:manage', { legalEntityId: e.legalEntityId, departmentId: e.departmentId, locationId: e.locationId }, tx);
      const tenantId = requestContext.tenantActor().tenantId;
      const now = new Date();
      // The account and its sessions are global records: read in this transaction, for this one member only.
      const u = await tx.unscoped('users').findOne({ id: m.user_id });
      const details = u && {
        loginId: u.email,
        accountStatus: u.status,
        mfaEnabled: u.mfa_enabled,
        lastLoginAt: u.last_login_at ?? null,
        mustChangePassword: u.must_change_password,
        hasPassword: u.password_hash != null,
        lockedUntil: u.locked_until && u.locked_until > now ? u.locked_until : null,
        otherWorkspaces: await tx.unscoped('memberships').count({ user_id: m.user_id, tenant_id: { $ne: tenantId }, status: 'active' }),
        openSessions: await tx.unscoped('sessions').count({ user_id: m.user_id, tenant_id: tenantId, revoked_at: null, expires_at: { $gt: now } }),
      };
      return { membershipId: e.membershipId, membershipStatus: m.status, ...details };
    });
  }

  async loginAction(id: string, input: z.infer<typeof employeeLoginActionInput>) {
    const actor = requestContext.tenantActor();
    // Hashing is slow on purpose, so it happens before the transaction.
    const generated = input.action === 'reset_password' && !input.initialPassword ? temporaryPasswordValue() : undefined;
    const hash = input.action === 'reset_password' ? await hashPassword(input.initialPassword ?? generated!) : null;
    await this.db.tenant(async (tx) => {
      const { e, m } = await this.loginTarget(tx, id);
      await this.authz.require('employees:update', employeeAttrs(e), tx);
      await this.authz.require('users:manage', { legalEntityId: e.legalEntityId, departmentId: e.departmentId, locationId: e.locationId }, tx);
      if (m.user_id === actor.userId) throw Errors.badRequest('own_login', 'Change your own password and sessions under Settings, Security.');
      if (m.owner) {
        const s = await this.authz.subject(tx);
        if (!s.grants.some((g) => g.roleKey === 'tenant_owner')) throw Errors.forbidden('Only a workspace owner can change another owner\'s login');
      }
      if (m.status === 'invited' && input.action !== 'sign_out') throw Errors.badRequest('not_joined', 'This person has not accepted their invitation yet.');
      // The account, its password and its sessions are global records; they change in this same transaction.
      const users = tx.unscoped('users');
      const shared = await tx.unscoped('memberships').count({ user_id: m.user_id, tenant_id: { $ne: actor.tenantId }, status: 'active' });
      const endSessions = (reason: string, everywhere = false) =>
        tx.unscoped('sessions').update({ user_id: m.user_id, ...(everywhere ? {} : { tenant_id: actor.tenantId }), revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: reason } });
      let detail: Record<string, unknown> = {};
      switch (input.action) {
        case 'reset_password':
        case 'force_password_change':
          // The password belongs to the person's account, which another company's workspace may also use.
          if (shared) throw Errors.conflict('shared_account', 'This person also uses this SampCrew account in another company\'s workspace, so their password cannot be changed from here. They can change it themselves, or SAMPLEDGE support can reset it.');
          await users.updateOne(
            { id: m.user_id },
            { $set: input.action === 'reset_password' ? { password_hash: hash, must_change_password: true, failed_login_count: 0, locked_until: null } : { must_change_password: true } },
          );
          detail = { sessionsEnded: await endSessions(input.action === 'reset_password' ? 'password_reset_by_admin' : 'password_change_forced_by_admin', true), typedByAdmin: !!input.initialPassword };
          break;
        case 'lock':
          if (m.status !== 'active') throw Errors.badRequest('not_active', 'This login is already locked.');
          await tx.collection('memberships').updateOne({ id: e.membershipId }, { $set: { status: 'suspended' } });
          detail = { sessionsEnded: await endSessions('locked_by_admin') };
          break;
        case 'unlock': {
          const u = (await users.findOne({ id: m.user_id }))!;
          const locked = !!u.locked_until && u.locked_until > new Date();
          if (m.status !== 'suspended' && !locked) throw Errors.badRequest('not_locked', 'This login is not locked.');
          if (m.status === 'suspended') await tx.collection('memberships').updateOne({ id: e.membershipId }, { $set: { status: 'active' } });
          // A lock after too many wrong passwords is cleared too. An account SAMPLEDGE locked stays locked.
          if (locked) await users.updateOne({ id: m.user_id }, { $set: { failed_login_count: 0, locked_until: null } });
          detail = { accountLockedBySampledge: u.status === 'locked' };
          break;
        }
        case 'sign_out':
          detail = { sessionsEnded: await endSessions('signed_out_by_admin') };
          break;
      }
      await this.audit.record(tx, { action: `employee.login_${input.action}`, resourceType: 'employee', resourceId: id, changes: { loginId: e.workEmail, ...detail } });
    });
    return { ...(await this.loginDetails(id)), ...(generated ? { temporaryPassword: generated } : {}) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Attendance registration: usual shift and attendance-machine enrolment numbers
  // ---------------------------------------------------------------------------------------------------------

  async attendanceRegistration(id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('attendance:read', employeeAttrs(e), tx);
      return this.registrationOf(tx, id);
    });
  }

  private async registrationOf(tx: TenantTx, id: string) {
    const e = await tx.collection('employees').findOne({ id });
    const s = e?.default_shift_id ? await tx.collection('shift_templates').findOne({ id: e.default_shift_id }) : undefined;
    const shift = s && { id: s.id, name: s.name, code: s.code, startTime: String(s.start_time).slice(0, 5), endTime: String(s.end_time).slice(0, 5) };
    const mappings = await tx.collection('device_user_mappings').find({ employee_id: id }, { sort: { created_at: 1 } });
    const devices = await fieldById(tx, 'attendance_devices', mappings.map((m) => m.device_id));
    const enrolments = mappings.map((m) => ({ id: m.id as string, deviceUserId: m.device_user_id as string, deviceId: (m.device_id as string | null) ?? null, deviceName: devices.get(m.device_id) ?? null }));
    return { defaultShift: shift ?? null, enrolments, registered: !!shift || enrolments.length > 0 };
  }

  /** Replaces the usual shift and enrolment numbers. Punches already received from a newly mapped number are applied. */
  async saveAttendanceRegistration(id: string, input: z.infer<typeof attendanceRegistrationInput>) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:update', employeeAttrs(e), tx);
      const before = await this.registrationOf(tx, id);
      // Enrolment numbers belong to the attendance machines; changing them needs the device permission.
      const sig = (list: { deviceUserId: string; deviceId: string | null }[]) => list.map((x) => `${x.deviceId ?? '*'}:${x.deviceUserId.toLowerCase()}`).sort().join(',');
      if (sig(before.enrolments) !== sig(input.enrolments)) await this.authz.require('devices:manage', { legalEntityId: e.legalEntityId }, tx);
      await this.registerAttendance(tx, id, input, false);
      const after = await this.registrationOf(tx, id);
      await this.audit.record(tx, {
        action: 'employee.attendance_registration_updated', resourceType: 'employee', resourceId: id,
        changes: { defaultShift: { from: before.defaultShift?.name ?? null, to: after.defaultShift?.name ?? null }, enrolments: { from: before.enrolments.map((x) => x.deviceUserId), to: after.enrolments.map((x) => x.deviceUserId) } },
      });
      return after;
    });
  }

  private async registerAttendance(tx: TenantTx, employeeId: string, input: z.infer<typeof attendanceRegistrationInput>, atHire: boolean) {
    if (atHire && !input.defaultShiftId && !input.enrolments.length) return;
    if (input.defaultShiftId && !(await tx.collection('shift_templates').exists({ id: input.defaultShiftId, archived_at: null }))) {
      throw Errors.badRequest('invalid_shift', 'Shift not found');
    }
    await tx.collection('employees').updateOne({ id: employeeId }, { $set: { default_shift_id: input.defaultShiftId ?? null } });
    const seen = new Set<string>();
    for (const x of input.enrolments) {
      const key = `${x.deviceId ?? '*'}:${x.deviceUserId.toLowerCase()}`;
      if (seen.has(key)) throw Errors.badRequest('duplicate_enrolment', `Enrolment number ${x.deviceUserId} is listed twice`);
      seen.add(key);
      if (x.deviceId && !(await tx.collection('attendance_devices').exists({ id: x.deviceId, archived_at: null }))) {
        throw Errors.badRequest('invalid_device', 'Attendance machine not found');
      }
    }
    const mappings = tx.collection('device_user_mappings');
    const old = await mappings.find({ employee_id: employeeId }, { projection: { device_user_id: 1, device_id: 1 } });
    await mappings.delete({ employee_id: employeeId });
    const actor = requestContext.tenantActor();
    for (const x of input.enrolments) {
      // A number on one machine, or on every machine (no device), cannot belong to two people.
      const taken = await mappings.findOne({ device_user_id: x.deviceUserId, ...(x.deviceId ? { $or: [{ device_id: x.deviceId }, { device_id: null }] } : {}) });
      if (taken) {
        const who = (await employeeNames(tx, [taken.employee_id])).get(taken.employee_id)?.name ?? 'someone else';
        throw Errors.conflict('already_mapped', `Enrolment number ${x.deviceUserId} is already used by ${who}`);
      }
      await mappings.insert({ device_id: x.deviceId ?? null, device_user_id: x.deviceUserId, employee_id: employeeId, created_by: actor.userId });
    }
    // Days already worked are recomputed so the new shift and any punches from these numbers count.
    if (!atHire) {
      const touched = [...old.map((o) => ({ deviceUserId: o.device_user_id as string, deviceId: (o.device_id as string | null) ?? null })), ...input.enrolments];
      for (const t of touched) await this.devices.recomputeMapped(tx, employeeId, t.deviceUserId, t.deviceId ?? null);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Photo
  // ---------------------------------------------------------------------------------------------------------

  /** HR (employees:update over this person) or the employee themselves can set the photo. */
  async setPhoto(id: string, file: { mimetype: string; size: number; buffer: Buffer } | undefined) {
    if (!file) throw Errors.badRequest('file_required', 'Choose a photo');
    if (!(PHOTO_TYPES as readonly string[]).includes(file.mimetype)) throw Errors.badRequest('unsupported_type', 'Use a PNG, JPEG or WebP image');
    if (file.size <= 0 || file.size > PHOTO_MAX_BYTES) throw Errors.badRequest('file_too_large', 'Photos can be up to 5 MB');
    if (!sniffMatches(file.mimetype, file.buffer.subarray(0, 512))) throw Errors.badRequest('content_mismatch', 'The file is not the image type it claims to be');
    const actor = requestContext.tenantActor();
    const key = this.storage.newKey(actor.tenantId);
    const old = await this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.requirePhotoEdit(tx, e);
      return ((await tx.collection('employees').findOne({ id }))!.photo_key as string | null) ?? null;
    });
    await this.storage.put(key, file.buffer, { upload: true });
    const e = await this.db.tenant(async (tx) => {
      await tx.collection('employees').updateOne({ id }, { $set: { photo_key: key, photo_content_type: file.mimetype, photo_updated_at: new Date() } });
      await this.audit.record(tx, { action: 'employee.photo_updated', resourceType: 'employee', resourceId: id, metadata: { contentType: file.mimetype, sizeBytes: file.size } });
      return this.load(tx, id);
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
    return { photoUpdatedAt: e.photoUpdatedAt };
  }

  async removePhoto(id: string) {
    const old = await this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.requirePhotoEdit(tx, e);
      const r = (await tx.collection('employees').findOne({ id }))!;
      await tx.collection('employees').updateOne({ id }, { $set: { photo_key: null, photo_content_type: null, photo_updated_at: null } });
      if (r.photo_key) await this.audit.record(tx, { action: 'employee.photo_removed', resourceType: 'employee', resourceId: id });
      return (r.photo_key as string | null) ?? null;
    });
    if (old) await this.storage.remove(old).catch(() => undefined);
  }

  /** Anyone who can see the employee record can see their photo. */
  async openPhoto(id: string) {
    const row = await this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:read', employeeAttrs(e), tx);
      return tx.collection('employees').findOne({ id }, { projection: { photo_key: 1, photo_content_type: 1 } });
    });
    if (!row?.photo_key || !row.photo_content_type) throw Errors.notFound('Photo');
    const f = await this.storage.open(row.photo_key).catch(() => { throw Errors.notFound('Photo'); });
    return { ...f, contentType: row.photo_content_type as string };
  }

  private async requirePhotoEdit(tx: TenantTx, e: EmployeeRow) {
    const s = await this.authz.subject(tx);
    if (s.employeeId === e.id) return;
    await this.authz.require('employees:update', employeeAttrs(e), tx);
  }

  /** Allocates the next code from the tenant's series, skipping codes already used (e.g. by imported records). */
  private async nextEmployeeCode(tx: TenantTx): Promise<string> {
    const series = tx.collection('employee_number_series');
    await series.upsert({}, {});
    for (let i = 0; i < 1000; i++) {
      const s = (await series.updateAndGet({}, { $inc: { next_value: 1 } }))!;
      const code = `${s.prefix}${String(s.next_value - 1).padStart(s.padding, '0')}`;
      if (!(await tx.collection('employees').exists({ employee_code: code }))) return code;
    }
    throw Errors.conflict('employee_code_exhausted', 'Could not allocate an employee code. Check the numbering settings.');
  }

  /** Links an existing workspace member's login to this employee record. */
  private async linkMembership(tx: TenantTx, employeeId: string, membershipId: string) {
    const m = await tx.collection('memberships').findOne({ id: membershipId });
    if (!m) throw Errors.badRequest('invalid_member', 'Workspace member not found');
    if (m.employee_id || (await tx.collection('employees').exists({ membership_id: membershipId }))) {
      throw Errors.conflict('member_already_linked', 'This member is already linked to an employee record');
    }
    await this.setMembership(tx, employeeId, membershipId);
    await this.onboarding.assignEmployeeTasks(tx, employeeId, membershipId);
    await this.event(tx, employeeId, 'linked_login', today(), { membershipId });
  }

  async link(id: string, membershipId: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:update', employeeAttrs(e), tx);
      await this.authz.require('users:manage', { membershipId, legalEntityId: e.legalEntityId, departmentId: e.departmentId, locationId: e.locationId }, tx);
      if (e.membershipId) throw Errors.conflict('already_linked', 'This employee already has a SampCrew login');
      await this.linkMembership(tx, id, membershipId);
      await this.audit.record(tx, { action: 'employee.login_linked', resourceType: 'employee', resourceId: id, metadata: { membershipId } });
      return this.load(tx, id);
    });
  }

  /** Validates references in a placement. Out-of-scope or archived targets read as not found. */
  private async checkPlacement(
    tx: TenantTx,
    p: { legalEntityId?: string; departmentId?: string | null; locationId?: string | null; designationId?: string | null; managerEmployeeId?: string | null },
    employeeId: string | null,
  ) {
    const exists = async (table: string, id: string | null | undefined, code: string, msg: string, filter: Record<string, unknown> = { archived_at: null }) => {
      if (id && !(await tx.collection(table).exists({ id, ...filter }))) throw Errors.badRequest(code, msg);
    };
    await exists('legal_entities', p.legalEntityId, 'invalid_legal_entity', 'Legal entity not found');
    await exists('departments', p.departmentId, 'invalid_department', 'Department not found');
    await exists('locations', p.locationId, 'invalid_location', 'Location not found');
    await exists('designations', p.designationId, 'invalid_designation', 'Designation not found');
    await exists('employees', p.managerEmployeeId, 'invalid_manager', 'Manager not found among current employees', { status: { $ne: 'exited' } });
    if (employeeId && p.managerEmployeeId) {
      if (p.managerEmployeeId === employeeId) throw Errors.badRequest('invalid_manager', 'An employee cannot report to themselves');
      if (await managerCycle(tx, employeeId, p.managerEmployeeId)) throw Errors.badRequest('invalid_manager', 'This would create a reporting loop');
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Profile changes
  // ---------------------------------------------------------------------------------------------------------

  async update(id: string, input: z.infer<typeof updateEmployeeInput>) {
    return this.db.tenant(async (tx) => {
      const before = await this.load(tx, id);
      await this.authz.require('employees:update', employeeAttrs(before), tx);
      const s = await this.authz.subject(tx);
      const broad = grantsFor(s, 'employees:update').some((g) => g.scope !== 'own' && grantCovers(s, g, employeeAttrs(before)));
      const keys = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
      if (!broad) {
        const blocked = keys.filter((k) => !OWN_FIELDS.has(k));
        if (blocked.length) throw Errors.forbidden(`HR maintains these fields: ${blocked.join(', ')}`);
      }
      if (!keys.length) return before;
      await tx
        .collection('employees')
        .updateOne({ id }, { $set: Object.fromEntries(keys.map((k) => [PROFILE_COLUMNS[k]!, input[k as keyof typeof input]])) })
        .catch(uniqueAs('work_email_taken', 'Another current employee already uses this work email'));
      const after = await this.load(tx, id);
      const changes = diff(before, Object.fromEntries(keys.map((k) => [k, after[k]])));
      if (Object.keys(changes).length) {
        await this.audit.record(tx, { action: 'employee.updated', resourceType: 'employee', resourceId: id, changes });
        await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'employee.changed', { employeeId: id, fields: Object.keys(changes) });
      }
      return after;
    });
  }

  /** Bank, tax and national ID details. Decrypting them needs MFA, and every view is audited. */
  async getSensitive(id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:sensitive:read', employeeAttrs(e), tx);
      const row = await tx.collection('employee_sensitive').findOne({ employee_id: id });
      await this.audit.record(tx, { action: 'employee.sensitive_viewed', resourceType: 'employee', resourceId: id });
      const dec = (v: string | null | undefined) => (v ? decryptField(v, this.config.fieldKeys) : null);
      return {
        bankName: row?.bank_name ?? null,
        bankAccount: dec(row?.bank_account_enc),
        bankRouting: dec(row?.bank_routing_enc),
        taxId: dec(row?.tax_id_enc),
        nationalId: dec(row?.national_id_enc),
        updatedAt: row?.updated_at ?? null,
      };
    });
  }

  async putSensitive(id: string, input: z.infer<typeof sensitiveInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:update', employeeAttrs(e), tx);
      await this.authz.require('employees:sensitive:read', employeeAttrs(e), tx);
      const enc = (v: string | null | undefined) => (v ? encryptField(v.replace(/\s+/g, ' '), this.config.fieldKeys) : null);
      const set: Record<string, unknown> = {};
      if (input.bankName !== undefined) set.bank_name = input.bankName;
      for (const [k, col] of Object.entries(SENSITIVE_COLUMNS)) {
        const v = input[k as keyof typeof SENSITIVE_COLUMNS];
        if (v !== undefined) set[col] = enc(v);
      }
      const changed = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
      if (Object.keys(set).length) {
        const stamp = { ...set, updated_by: actor.userId, updated_at: new Date() };
        await tx.collection('employee_sensitive').upsert({ employee_id: id }, { employee_id: id, ...stamp }, { $set: stamp });
        // Only field names are audited, never the values.
        await this.audit.record(tx, { action: 'employee.sensitive_updated', resourceType: 'employee', resourceId: id, metadata: { fields: changed } });
        if (e.membershipId && e.membershipId !== actor.membershipId) {
          await this.notifications.notify(tx, {
            membershipIds: [e.membershipId],
            kind: 'employee.sensitive_changed',
            title: 'Your bank or tax details were changed',
            body: `${actor.label} updated: ${changed.join(', ')}. If you did not expect this, contact HR.`,
            link: `/employees/${id}`,
            email: true,
          });
        }
      }
      return { updated: changed };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------

  /** Transfer, promotion, manager change or correction, effective on a date (today, past or future). */
  async changeJob(id: string, input: z.infer<typeof transferInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:lifecycle', employeeAttrs(e), tx);
      if (e.status === 'exited') throw Errors.conflict('employee_exited', 'This person has left. Rehire them first.');
      if (input.effectiveFrom < e.dateOfJoining) throw Errors.badRequest('before_joining', 'The change cannot take effect before the joining date');
      if (e.lastWorkingDay && input.effectiveFrom > e.lastWorkingDay) throw Errors.badRequest('after_exit', 'The change cannot take effect after the last working day');

      const records = tx.collection('employment_records');
      if (await records.exists({ employee_id: id, effective_from: { $gt: input.effectiveFrom } })) {
        throw Errors.conflict('later_change_scheduled', 'A later change is already recorded. Correct that one first.');
      }
      const current = await records.findOne({ employee_id: id, effective_from: { $lte: input.effectiveFrom } }, { sort: { effective_from: -1 } });
      if (!current) throw Errors.conflict('no_record', 'No job record covers that date');

      const pick = <T>(v: T | undefined, fallback: unknown) => (v === undefined ? fallback : v);
      const next = {
        legal_entity_id: pick(input.legalEntityId, current.legal_entity_id) as string,
        department_id: pick(input.departmentId, current.department_id ?? null),
        location_id: pick(input.locationId, current.location_id ?? null),
        designation_id: pick(input.designationId, current.designation_id ?? null),
        manager_employee_id: pick(input.managerEmployeeId, current.manager_employee_id ?? null),
        grade: pick(input.grade, current.grade ?? null),
        employment_type: pick(input.employmentType, current.employment_type),
      };
      const changedCols = Object.keys(next).filter((k) => (next as Record<string, unknown>)[k] !== (current[k] ?? null));
      if (!changedCols.length) throw Errors.badRequest('no_change', 'Nothing changes with these values');
      await this.checkPlacement(tx, {
        legalEntityId: input.legalEntityId, departmentId: input.departmentId, locationId: input.locationId,
        designationId: input.designationId, managerEmployeeId: next.manager_employee_id as string | null,
      }, id);
      // Moving someone into another entity or department needs scope over the destination too.
      await this.authz.require('employees:lifecycle', {
        employeeId: undefined, membershipId: undefined, legalEntityId: next.legal_entity_id,
        departmentId: next.department_id as string | null, locationId: next.location_id as string | null,
      }, tx);

      if (current.effective_from === input.effectiveFrom) {
        await records.updateOne(
          { id: current.id },
          { $set: { ...next, change_reason: current.change_reason === 'hire' ? 'hire' : input.reason, ...(input.note != null ? { note: input.note } : {}) } },
        );
      } else {
        await records.updateOne({ id: current.id }, { $set: { effective_to: addDays(input.effectiveFrom, -1) } });
        await records.insert({
          employee_id: id,
          effective_from: input.effectiveFrom,
          effective_to: current.effective_to ?? null,
          ...next,
          change_reason: input.reason,
          note: input.note ?? null,
          created_by: actor.userId,
        });
      }
      await applyCurrentPlacement(tx, today(), [id]);
      const kind = input.reason === 'promotion' ? 'promoted' : changedCols.length === 1 && changedCols[0] === 'manager_employee_id' ? 'manager_changed' : LIFECYCLE_KIND[input.reason]!;
      await this.event(tx, id, kind, input.effectiveFrom, { reason: input.reason, changed: changedCols, note: input.note ?? null });
      const after = await this.load(tx, id);
      await this.audit.record(tx, {
        action: `employee.job_changed`, resourceType: 'employee', resourceId: id,
        changes: Object.fromEntries(changedCols.map((c) => [c, { from: current[c] ?? null, to: (next as Record<string, unknown>)[c] ?? null }])),
        metadata: { effectiveFrom: input.effectiveFrom, reason: input.reason },
      });
      await this.outbox.publish(tx, actor.tenantId, 'employee.job_changed', { employeeId: id, effectiveFrom: input.effectiveFrom, changed: changedCols });
      const newManager = next.manager_employee_id ? await tx.collection('employees').findOne({ id: next.manager_employee_id }) : undefined;
      await this.notifications.notify(tx, {
        membershipIds: [e.membershipId, changedCols.includes('manager_employee_id') ? newManager?.membership_id : null],
        kind: 'employee.job_changed',
        title: `Job change for ${e.displayName} from ${input.effectiveFrom}`,
        body: `Reason: ${input.reason.replace('_', ' ')}.`,
        link: `/employees/${id}`,
      });
      return after;
    });
  }

  async confirm(id: string, input: z.infer<typeof confirmInput>) {
    return this.lifecycle(id, async (tx, e) => {
      if (e.status !== 'probation') throw Errors.conflict('invalid_state', 'Only employees on probation can be confirmed');
      if (input.effectiveOn < e.dateOfJoining) throw Errors.badRequest('before_joining', 'Confirmation cannot be before the joining date');
      await tx.collection('employees').updateOne({ id }, { $set: { status: 'active', confirmation_date: input.effectiveOn } });
      await this.event(tx, id, 'confirmed', input.effectiveOn, { note: input.note ?? null });
      await this.notifications.notify(tx, { membershipIds: [e.membershipId], kind: 'employee.confirmed', title: 'Your employment has been confirmed', link: `/employees/${id}`, email: true });
      return { action: 'employee.confirmed', changes: { status: { from: 'probation', to: 'active' }, confirmationDate: input.effectiveOn } };
    });
  }

  async extendProbation(id: string, input: z.infer<typeof extendProbationInput>) {
    return this.lifecycle(id, async (tx, e) => {
      if (e.status !== 'probation') throw Errors.conflict('invalid_state', 'Only employees on probation can have it extended');
      if (e.probationEndDate && input.newEndDate <= e.probationEndDate) throw Errors.badRequest('not_later', 'The new end date must be after the current one');
      await tx.collection('employees').updateOne({ id }, { $set: { probation_end_date: input.newEndDate } });
      await this.event(tx, id, 'probation_extended', today(), { from: e.probationEndDate, to: input.newEndDate, note: input.note ?? null });
      return { action: 'employee.probation_extended', changes: { probationEndDate: { from: e.probationEndDate, to: input.newEndDate } } };
    });
  }

  /** Records a resignation or termination. The person keeps access until the last working day passes. */
  async scheduleExit(id: string, input: z.infer<typeof exitInput>) {
    return this.lifecycle(id, async (tx, e) => {
      if (e.status === 'exited' || e.status === 'notice') throw Errors.conflict('invalid_state', e.status === 'notice' ? 'An exit is already scheduled' : 'This person has already left');
      if (input.lastWorkingDay < e.dateOfJoining) throw Errors.badRequest('before_joining', 'The last working day cannot be before the joining date');
      if (await tx.collection('employment_records').exists({ employee_id: id, effective_from: { $gt: input.lastWorkingDay } })) {
        throw Errors.conflict('later_change_scheduled', 'A job change is scheduled after the last working day. Correct it first.');
      }
      await tx.collection('employees').updateOne(
        { id },
        { $set: { status: 'notice', exit_type: input.exitType, resignation_date: input.resignationDate ?? null, last_working_day: input.lastWorkingDay, exit_reason: input.reason ?? null } },
      );
      await tx.collection('employment_records').update(
        { employee_id: id, effective_from: { $lte: input.lastWorkingDay }, $or: [{ effective_to: null }, { effective_to: { $gt: input.lastWorkingDay } }] },
        { $set: { effective_to: input.lastWorkingDay } },
      );
      if (input.resignationDate) await this.event(tx, id, 'resigned', input.resignationDate, {});
      await this.event(tx, id, 'exit_scheduled', input.lastWorkingDay, { exitType: input.exitType });
      const mgr = e.managerEmployeeId ? await tx.collection('employees').findOne({ id: e.managerEmployeeId }) : undefined;
      await this.notifications.notify(tx, {
        membershipIds: [mgr?.membership_id], kind: 'employee.exit_scheduled', title: `${e.displayName}'s last working day is ${input.lastWorkingDay}`, link: `/employees/${id}`,
      });
      return { action: 'employee.exit_scheduled', changes: { status: { from: e.status, to: 'notice' }, lastWorkingDay: input.lastWorkingDay, exitType: input.exitType } };
    }).then(async (r) => {
      // A last working day in the past takes effect straight away.
      if (input.lastWorkingDay < today()) return this.db.tenant(async (tx) => (await this.finaliseExits(tx, today()), this.load(tx, id)));
      return r;
    });
  }

  async withdrawExit(id: string) {
    return this.lifecycle(id, async (tx, e) => {
      if (e.status !== 'notice') throw Errors.conflict('invalid_state', 'There is no scheduled exit to withdraw');
      const status = !e.confirmationDate && e.probationEndDate && e.probationEndDate >= today() ? 'probation' : e.confirmationDate || !e.probationEndDate ? 'active' : 'probation';
      await tx.collection('employees').updateOne({ id }, { $set: { status, exit_type: null, resignation_date: null, last_working_day: null, exit_reason: null } });
      await tx.collection('employment_records').update({ employee_id: id, effective_to: e.lastWorkingDay }, { $set: { effective_to: null } });
      await this.event(tx, id, 'exit_withdrawn', today(), { lastWorkingDay: e.lastWorkingDay });
      return { action: 'employee.exit_withdrawn', changes: { status: { from: 'notice', to: status } } };
    });
  }

  private async lifecycle(id: string, fn: (tx: TenantTx, e: EmployeeRow) => Promise<{ action: string; changes: Record<string, unknown> }>) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:lifecycle', employeeAttrs(e), tx);
      const r = await fn(tx, e);
      await this.audit.record(tx, { action: r.action, resourceType: 'employee', resourceId: id, changes: r.changes });
      await this.outbox.publish(tx, requestContext.tenantActor().tenantId, r.action, { employeeId: id });
      return this.load(tx, id);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Scheduled transitions (called by the daily HR job and after back-dated changes)
  // ---------------------------------------------------------------------------------------------------------

  /** Starts employees whose joining date has arrived. */
  async startJoiners(tx: TenantTx, asOf: string): Promise<number> {
    const due = await tx.collection('employees').find({ status: 'pre_boarding', date_of_joining: { $lte: asOf } }, { projection: { probation_end_date: 1 } });
    for (const e of due) await tx.collection('employees').updateOne({ id: e.id, status: 'pre_boarding' }, { $set: { status: e.probation_end_date ? 'probation' : 'active' } });
    return due.length;
  }

  /** Copies each employee's job record in effect on `asOf` into their current placement. */
  applyCurrent(tx: TenantTx, asOf: string): Promise<number> {
    return applyCurrentPlacement(tx, asOf);
  }

  /** Completes exits whose last working day has passed: the login is suspended and sessions are revoked. */
  async finaliseExits(tx: TenantTx, asOf: string): Promise<number> {
    const due = await tx.collection('employees').find({ status: 'notice', last_working_day: { $lt: asOf } });
    for (const e of due) {
      await tx.collection('employees').updateOne({ id: e.id }, { $set: { status: 'exited' } });
      await this.event(tx, e.id, 'exited', e.last_working_day, {});
      // Open leave after the last day can no longer be taken.
      const open = await tx.collection('leave_requests').find({ employee_id: e.id, status: 'pending' });
      for (const l of open) {
        await tx.collection('leave_requests').updateOne({ id: l.id }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: 'Employee left' } });
        if (l.approval_request_id) {
          await tx.collection('approval_steps').update({ request_id: l.approval_request_id, status: { $in: ['pending', 'waiting'] } }, { $set: { status: 'cancelled' } });
          await tx.collection('approval_requests').updateOne({ id: l.approval_request_id }, { $set: { status: 'cancelled', decided_at: new Date() } });
        }
      }
      if (e.membership_id) {
        const m = await tx.collection('memberships').findOne({ id: e.membership_id });
        if (m && m.status !== 'suspended') {
          await tx.collection('memberships').updateOne({ id: e.membership_id }, { $set: { status: 'suspended' } });
          // Sessions are global records; only this workspace's are ended, in the same transaction.
          await tx.unscoped('sessions').update({ user_id: m.user_id, tenant_id: e.tenant_id, revoked_at: null }, { $set: { revoked_at: new Date(), revoked_reason: 'employee_exited' } });
        }
      }
      await this.audit.record(tx, { action: 'employee.exited', resourceType: 'employee', resourceId: e.id, metadata: { lastWorkingDay: e.last_working_day }, tenantId: e.tenant_id });
      await this.outbox.publish(tx, e.tenant_id, 'employee.exited', { employeeId: e.id });
    }
    return due.length;
  }

  private async event(tx: TenantTx, employeeId: string, kind: string, effectiveOn: string, details: Record<string, unknown>) {
    const actor = requestContext.get()?.actor;
    await tx.collection('lifecycle_events').insert({ employee_id: employeeId, kind, effective_on: effectiveOn, details, created_by: actor?.kind === 'user' ? actor.userId : null });
  }
}

function cmp(a: unknown, b: unknown): number {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

function draftView(d: Record<string, unknown>) {
  return { id: d.id, step: d.step, data: d.data, updatedAt: d.updated_at };
}

/** Turns a unique-constraint violation into a readable 409. */
export function uniqueAs(code: string, message: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === '23505') throw Errors.conflict(code, message);
    throw err;
  };
}

export { temporaryPasswordValue };

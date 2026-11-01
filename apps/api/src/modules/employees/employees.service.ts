import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  confirmInput,
  CreateEmployeeInput,
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
import { decryptField, encryptField } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { decodeCursor, page } from '../../platform/http/pagination';
import { NotificationService } from '../../platform/notify/notification.service';
import { LeaveService } from '../leave/leave.service';
import { MembersService } from '../members/members.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { EMPLOYEE_SCOPE, employeeAttrs } from './employee-attrs';

export { employeeAttrs };

export const EMPLOYEE_COLUMNS = `e.id, e.employee_code as "employeeCode", e.first_name as "firstName", e.last_name as "lastName",
  e.preferred_name as "preferredName", trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "displayName",
  e.work_email::text as "workEmail", e.personal_email::text as "personalEmail", e.phone, e.date_of_birth as "dateOfBirth", e.gender,
  e.date_of_joining as "dateOfJoining", e.probation_end_date as "probationEndDate", e.confirmation_date as "confirmationDate",
  e.employment_type as "employmentType", e.status, e.resignation_date as "resignationDate", e.last_working_day as "lastWorkingDay",
  e.exit_type as "exitType", e.exit_reason as "exitReason",
  e.current_legal_entity_id as "legalEntityId", le.name as "legalEntityName", e.current_department_id as "departmentId", d.name as "departmentName",
  e.current_location_id as "locationId", l.name as "locationName", e.current_designation_id as "designationId", ds.name as "designationName",
  e.current_manager_employee_id as "managerEmployeeId", trim(coalesce(mgr.preferred_name, mgr.first_name) || ' ' || mgr.last_name) as "managerName",
  e.current_grade as "grade", e.membership_id as "membershipId", m.status as "loginStatus", e.created_at as "createdAt"`;

const SORT_KEYS: Record<z.infer<typeof employeeListQuery>['sort'], string> = {
  name: `lower(e.first_name || ' ' || e.last_name)`,
  code: 'lower(e.employee_code)',
  joined: `to_char(e.date_of_joining, 'YYYY-MM-DD')`,
  department: `lower(coalesce(d.name, ''))`,
  location: `lower(coalesce(l.name, ''))`,
  status: 'e.status',
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

export const EMPLOYEE_FROM = `from employees e
  left join legal_entities le on le.id = e.current_legal_entity_id
  left join departments d on d.id = e.current_department_id
  left join locations l on l.id = e.current_location_id
  left join designations ds on ds.id = e.current_designation_id
  left join employees mgr on mgr.id = e.current_manager_employee_id
  left join memberships m on m.id = e.membership_id`;

/** Columns the ABAC scope predicate uses for employee rows (aliased e). */
export { EMPLOYEE_SCOPE };

export interface EmployeeRow {
  id: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  displayName: string;
  workEmail: string | null;
  status: string;
  dateOfJoining: string;
  probationEndDate: string | null;
  confirmationDate: string | null;
  lastWorkingDay: string | null;
  legalEntityId: string | null;
  departmentId: string | null;
  locationId: string | null;
  designationId: string | null;
  managerEmployeeId: string | null;
  grade: string | null;
  employmentType: string;
  membershipId: string | null;
  [key: string]: unknown;
}


const PROFILE_COLUMNS: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', preferredName: 'preferred_name', workEmail: 'work_email', personalEmail: 'personal_email',
  phone: 'phone', dateOfBirth: 'date_of_birth', gender: 'gender',
};
const OWN_FIELDS = new Set(['preferredName', 'personalEmail', 'phone']);
const SENSITIVE_COLUMNS = { bankAccount: 'bank_account_enc', bankRouting: 'bank_routing_enc', taxId: 'tax_id_enc', nationalId: 'national_id_enc' } as const;

const LIFECYCLE_KIND: Record<string, string> = { transfer: 'transferred', promotion: 'promoted', manager_change: 'manager_changed', correction: 'transferred', other: 'transferred' };

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Employee records. The employee is the person record HR manages; a CREW login (membership) is optional and
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
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------------------------------------------------
  // Designations
  // ---------------------------------------------------------------------------------------------------------

  listDesignations() {
    return this.db.tenant((tx) =>
      many(tx, `select id, name, code, level, (select count(*)::int from employees e where e.current_designation_id = designations.id and e.status <> 'exited') as "employeeCount"
                  from designations where archived_at is null order by level nulls last, name`),
    );
  }

  createDesignation(input: z.infer<typeof designationInput>) {
    return this.db.tenant(async (tx) => {
      const row = await one<{ id: string }>(
        tx, `insert into designations (tenant_id, name, code, level) values (app_tenant_id(), $1, $2, $3) returning id, name, code, level`,
        [input.name, input.code ?? null, input.level ?? null],
      ).catch(uniqueAs('designation_exists', 'A designation with this name already exists'));
      await this.audit.record(tx, { action: 'designation.created', resourceType: 'designation', resourceId: row!.id, changes: input });
      return row;
    });
  }

  updateDesignation(id: string, input: Partial<z.infer<typeof designationInput>>) {
    return this.db.tenant(async (tx) => {
      const before = await one<Record<string, unknown>>(tx, 'select name, code, level from designations where id = $1 and archived_at is null for update', [id]);
      if (!before) throw Errors.notFound('Designation');
      const after = { name: input.name ?? before.name, code: input.code !== undefined ? input.code : before.code, level: input.level !== undefined ? input.level : before.level };
      await tx.query('update designations set name = $2, code = $3, level = $4 where id = $1', [id, after.name, after.code, after.level])
        .catch(uniqueAs('designation_exists', 'A designation with this name already exists'));
      await this.audit.record(tx, { action: 'designation.updated', resourceType: 'designation', resourceId: id, changes: diff(before, after) });
      return { id, ...after };
    });
  }

  archiveDesignation(id: string) {
    return this.db.tenant(async (tx) => {
      const used = await one(tx, `select 1 from employees where current_designation_id = $1 and status <> 'exited' limit 1`, [id]);
      if (used) throw Errors.conflict('designation_in_use', 'Employees still hold this designation');
      const r = await tx.query('update designations set archived_at = now() where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Designation');
      await this.audit.record(tx, { action: 'designation.archived', resourceType: 'designation', resourceId: id });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Directory and profile
  // ---------------------------------------------------------------------------------------------------------

  /** Directory filters shared by the list and the CSV export. */
  private async directoryWhere(tx: Tx, q: Omit<z.infer<typeof employeeListQuery>, 'cursor' | 'limit'>, params: unknown[]) {
    const where = [await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx)];
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(`(lower(e.first_name || ' ' || e.last_name) like ${p} or lower(coalesce(e.preferred_name, '')) like ${p} or lower(e.employee_code) like ${p} or lower(coalesce(e.work_email::text, '')) like ${p})`);
    }
    if (q.status) {
      params.push(q.status);
      where.push(`e.status = $${params.length}`);
    } else if (q.includeExited !== 'true') {
      where.push(`e.status <> 'exited'`);
    }
    if (q.departmentId) {
      params.push(q.departmentId);
      where.push(`e.current_department_id = $${params.length}`);
    }
    if (q.legalEntityId) {
      params.push(q.legalEntityId);
      where.push(`e.current_legal_entity_id = $${params.length}`);
    }
    return where;
  }

  async list(q: z.infer<typeof employeeListQuery>) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const where = await this.directoryWhere(tx, q, params);
      const total = (await one<{ n: number }>(tx, `select count(*)::int as n from employees e where ${where.join(' and ')}`, params))!.n;
      // Keyset pagination on (sort key as text, id), in either direction.
      const key = SORT_KEYS[q.sort];
      const cmp = q.dir === 'desc' ? '<' : '>';
      const cursor = decodeCursor(q.cursor);
      if (cursor) {
        params.push(String(cursor[0]), cursor[1]);
        where.push(`(${key}, e.id) ${cmp} ($${params.length - 1}, $${params.length}::uuid)`);
      }
      params.push(q.limit + 1);
      const rows = await many<EmployeeRow & { sortKey: string }>(
        tx,
        `select ${EMPLOYEE_COLUMNS}, ${key} as "sortKey" ${EMPLOYEE_FROM} where ${where.join(' and ')} order by ${key} ${q.dir}, e.id ${q.dir} limit $${params.length}`,
        params,
      );
      // Personal contact details are not part of the directory listing.
      const items = rows.map(({ personalEmail: _p, phone: _ph, dateOfBirth: _d, gender: _g, exitReason: _x, ...rest }) => rest);
      const out = page(items as (EmployeeRow & { sortKey: string })[], q.limit, (r) => r.sortKey);
      return { ...out, items: out.items.map(({ sortKey: _k, ...r }) => r), total };
    });
  }

  /** The directory as CSV with the chosen columns, same scope and filters as the list. Audited. */
  async exportCsv(q: z.infer<typeof employeeExportQuery>) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const where = await this.directoryWhere(tx, q, params);
      const key = SORT_KEYS[q.sort];
      const rows = await many<EmployeeRow>(tx, `select ${EMPLOYEE_COLUMNS} ${EMPLOYEE_FROM} where ${where.join(' and ')} order by ${key} ${q.dir}, e.id ${q.dir} limit 20001`, params);
      if (rows.length > 20000) throw Errors.badRequest('export_too_large', 'More than 20,000 people match. Narrow the filters and export again.');
      const cell = (v: unknown) => {
        let t = v === null || v === undefined ? '' : String(v);
        // Neutralise spreadsheet formulas (CSV injection).
        if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
        return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
      };
      const lines = [q.columns.map((c) => EXPORT_HEADERS[c]).join(',')];
      for (const r of rows) lines.push(q.columns.map((c) => cell(exportValue(r, c))).join(','));
      await this.audit.record(tx, { action: 'employee.directory_exported', resourceType: 'employee', resourceId: null, changes: { rows: rows.length, columns: q.columns, filters: { q: q.q ?? null, status: q.status ?? null, departmentId: q.departmentId ?? null } } });
      return { fileName: `employees-${new Date().toISOString().slice(0, 10)}.csv`, content: `\ufeff${lines.join('\r\n')}\r\n` };
    });
  }

  /** People who may already have a record, so a hire is not entered twice. */
  async duplicates(input: z.infer<typeof duplicateCheckInput>) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
      const conds: string[] = [];
      const reasons: string[] = [];
      const add = (sql: string, value: unknown, reason: string) => {
        params.push(value);
        conds.push(sql.replace('$x', `$${params.length}`));
        reasons.push(`case when ${sql.replace('$x', `$${params.length}`)} then '${reason}' end`);
      };
      if (input.workEmail?.includes('@')) add('lower(e.work_email::text) = lower($x)', input.workEmail, 'Same work email');
      if (input.personalEmail?.includes('@')) add('lower(e.personal_email::text) = lower($x)', input.personalEmail, 'Same personal email');
      const digits = (input.phone ?? '').replace(/\D/g, '');
      if (digits.length >= 7) add(`right(regexp_replace(coalesce(e.phone, ''), '\\D', '', 'g'), 10) = right($x, 10)`, digits, 'Same phone number');
      if (input.firstName && input.lastName) {
        params.push(input.firstName.toLowerCase(), input.lastName.toLowerCase());
        const nameSql = `(lower(e.first_name) = $${params.length - 1} and lower(e.last_name) = $${params.length})`;
        if (input.dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)) {
          params.push(input.dateOfBirth);
          const both = `(${nameSql} and e.date_of_birth = $${params.length}::date)`;
          conds.push(both);
          reasons.push(`case when ${both} then 'Same name and date of birth' end`);
        }
        conds.push(nameSql);
        reasons.push(`case when ${nameSql} then 'Same name' end`);
      }
      if (!conds.length) return { matches: [] };
      const matches = await many<{ id: string; displayName: string; employeeCode: string; status: string; departmentName: string | null; reasons: string[] }>(
        tx,
        `select e.id, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "displayName", e.employee_code as "employeeCode", e.status,
                d.name as "departmentName", array_remove(array[${reasons.join(', ')}], null) as reasons
           from employees e left join departments d on d.id = e.current_department_id
          where ${scope} and (${conds.join(' or ')}) order by e.status = 'exited', e.date_of_joining desc limit 5`,
        params,
      );
      return { matches };
    });
  }

  // Hire drafts -----------------------------------------------------------------------------------------------

  async drafts() {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant((tx) => many(tx, `select id, step, data, updated_at as "updatedAt" from employee_drafts where membership_id = $1 order by updated_at desc limit 20`, [me]));
  }

  async saveDraft(id: string | null, input: z.infer<typeof employeeDraftInput>) {
    const me = requestContext.tenantActor().membershipId;
    return this.db.tenant(async (tx) => {
      if (id) {
        const r = await one(tx, `update employee_drafts set step = $3, data = $4 where id = $1 and membership_id = $2 returning id, step, data, updated_at as "updatedAt"`, [id, me, input.step, input.data]);
        if (!r) throw Errors.notFound('Draft');
        return r;
      }
      const n = (await one<{ n: number }>(tx, 'select count(*)::int as n from employee_drafts where membership_id = $1', [me]))!.n;
      if (n >= 20) throw Errors.conflict('too_many_drafts', 'You have 20 unfinished hires. Finish or discard one first.');
      return one(tx, `insert into employee_drafts (tenant_id, membership_id, step, data) values (app_tenant_id(), $1, $2, $3) returning id, step, data, updated_at as "updatedAt"`, [me, input.step, input.data]);
    });
  }

  async deleteDraft(id: string) {
    const me = requestContext.tenantActor().membershipId;
    const r = await this.db.tenant((tx) => tx.query('delete from employee_drafts where id = $1 and membership_id = $2', [id, me]));
    if (!r.rowCount) throw Errors.notFound('Draft');
  }

  async load(tx: Tx, id: string): Promise<EmployeeRow> {
    const row = await one<EmployeeRow>(tx, `select ${EMPLOYEE_COLUMNS} ${EMPLOYEE_FROM} where e.id = $1`, [id]);
    if (!row) throw Errors.notFound('Employee');
    return row;
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
      return {
        ...e,
        isSelf,
        can: {
          update: covers('employees:update', true),
          updateOwn: isSelf && covers('employees:update'),
          viewSensitive: covers('employees:sensitive:read'),
          lifecycle: covers('employees:lifecycle'),
          readDocuments: covers('documents:read'),
          manageDocuments: covers('documents:manage'),
          readLeave: covers('leave:read'),
        },
      };
    });
  }

  async me() {
    const actor = requestContext.tenantActor();
    const row = await this.db.tenant((tx) => one<{ id: string }>(tx, 'select id from employees where membership_id = $1', [actor.membershipId]));
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
      const today = new Date().toISOString().slice(0, 10);
      const timeline: { at: string; kind: string; title: string; detail: string | null; link: string | null }[] = [];

      const tenure = await one<{ joined: string | null; days: number | null }>(
        tx, `select to_char(min(effective_from), 'YYYY-MM-DD') as joined, (current_date - min(effective_from))::int as days from employment_records where employee_id = $1`, [id],
      );

      let attendance = null;
      if (f.has('attendance_basic') && covers('attendance:read')) {
        const r = (await one<Record<string, number>>(
          tx,
          `select count(*) filter (where status in ('present', 'half_day'))::int as present, count(*) filter (where status = 'absent')::int as absent,
                  count(*) filter (where status = 'missing_punch')::int as "missingPunch", count(*) filter (where status in ('on_leave', 'half_day_leave'))::int as "onLeave",
                  count(*) filter (where late_minutes > 0)::int as late, count(*) filter (where day_type = 'working' and status not in ('in_progress', 'not_joined'))::int as "workingDays",
                  coalesce(round(avg(worked_minutes) filter (where status in ('present', 'half_day'))), 0)::int as "avgWorkedMinutes",
                  coalesce(sum(approved_overtime_minutes), 0)::int as "overtimeMinutes"
             from attendance_days where employee_id = $1 and work_date between current_date - 29 and current_date`,
          [id],
        ))!;
        attendance = { from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10), to: today, ...r };
      }

      let leave = null;
      if (f.has('leave') && covers('leave:read')) {
        const reqs = await many<{ id: string; type: string; startDate: string; endDate: string; days: string; status: string; createdAt: string }>(
          tx,
          `select r.id, t.name as type, to_char(r.start_date, 'YYYY-MM-DD') as "startDate", to_char(r.end_date, 'YYYY-MM-DD') as "endDate", r.days::text, r.status, r.created_at as "createdAt"
             from leave_requests r join leave_types t on t.id = r.leave_type_id where r.employee_id = $1 order by r.created_at desc limit 20`,
          [id],
        );
        const taken = (await one<{ d: string }>(tx, `select coalesce(sum(days), 0)::text as d from leave_requests where employee_id = $1 and status = 'approved' and date_part('year', start_date) = date_part('year', current_date)`, [id]))!.d;
        leave = {
          pending: reqs.filter((r) => r.status === 'pending').length,
          takenThisYear: taken,
          next: reqs.filter((r) => r.status === 'approved' && r.startDate >= today).sort((x, y) => x.startDate.localeCompare(y.startDate))[0] ?? null,
        };
        for (const r of reqs.slice(0, 8)) timeline.push({ at: r.createdAt, kind: 'leave', title: `${r.type}: ${r.days} day${r.days === '1.00' ? '' : 's'} from ${r.startDate}`, detail: r.status, link: null });
      }

      // Pay is sensitive: only people whose payroll access covers this employee see salary; the employee sees their own payslips.
      let pay = null;
      if (f.has('payroll') && (covers('payroll:read') || (isSelf && covers('payslips:read')))) {
        const salary = covers('payroll:read')
          ? await one<{ annualCtc: string; currency: string; effectiveFrom: string }>(
            tx, `select annual_ctc::text as "annualCtc", currency, to_char(effective_from, 'YYYY-MM-DD') as "effectiveFrom" from employee_salaries where employee_id = $1 and effective_from <= current_date order by effective_from desc limit 1`, [id],
          )
          : null;
        const payslip = await one<{ periodEnd: string; net: string; currency: string; payDate: string }>(
          tx,
          `select to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd", i.net::text as net, r.currency, to_char(r.pay_date, 'YYYY-MM-DD') as "payDate"
             from payroll_items i join payroll_runs r on r.id = i.run_id where i.employee_id = $1 and r.status = 'finalised' order by r.period_end desc limit 1`,
          [id],
        );
        pay = { salary: salary ?? null, lastPayslip: payslip ?? null };
      }

      let performance = null;
      if (f.has('talent') && covers('performance:read')) {
        const goals = await many<{ title: string; status: string; progress: string; confidence: string | null; periodEnd: string; updatedAt: string }>(
          tx,
          `select title, status, progress::text, confidence, to_char(period_end, 'YYYY-MM-DD') as "periodEnd", updated_at as "updatedAt" from goals
            where employee_id = $1 and status <> 'cancelled' order by (status = 'active') desc, period_end desc limit 20`,
          [id],
        );
        // Ratings: managers and HR see the latest finalised rating; the employee only once it is released to them.
        const broad = covers('performance:read', true) && !isSelf;
        const review = await one<{ cycle: string; rating: number | null; releasedAt: string | null }>(
          tx,
          `select c.name as cycle, r.final_rating as rating, r.released_at as "releasedAt" from reviews r join review_cycles c on c.id = r.cycle_id
            where r.employee_id = $1 and not r.excluded and r.final_rating is not null ${broad ? '' : 'and r.released_at is not null'} order by c.created_at desc limit 1`,
          [id],
        );
        const active = goals.filter((g) => g.status === 'active');
        performance = {
          activeGoals: active.length,
          completedGoals: goals.filter((g) => g.status === 'completed').length,
          atRisk: active.filter((g) => g.confidence === 'at_risk' || g.confidence === 'off_track').length,
          averageProgress: active.length ? (active.reduce((t, g) => t + Number(g.progress), 0) / active.length).toFixed(0) : null,
          goals: active.slice(0, 5).map(({ updatedAt: _u, ...g }) => g),
          latestReview: review ?? null,
        };
        for (const g of goals.slice(0, 5)) timeline.push({ at: g.updatedAt, kind: 'goal', title: `Goal: ${g.title}`, detail: g.status === 'completed' ? 'completed' : `${Number(g.progress).toFixed(0)}%`, link: null });
      }

      let learning = null;
      if (f.has('talent') && covers('learning:read')) {
        const r = (await one<Record<string, number>>(
          tx,
          `select count(*) filter (where status in ('assigned', 'in_progress'))::int as open, count(*) filter (where status = 'completed')::int as completed,
                  count(*) filter (where status in ('assigned', 'in_progress') and due_on < current_date)::int as overdue,
                  count(*) filter (where status = 'completed' and expires_on < current_date)::int as expired
             from course_assignments where employee_id = $1`,
          [id],
        ))!;
        const done = await many<{ title: string; completedOn: string }>(
          tx, `select c.title, to_char(a.completed_on, 'YYYY-MM-DD') as "completedOn" from course_assignments a join courses c on c.id = a.course_id where a.employee_id = $1 and a.status = 'completed' order by a.completed_on desc limit 5`, [id],
        );
        learning = { ...r, recent: done };
        for (const d of done) timeline.push({ at: `${d.completedOn}T12:00:00Z`, kind: 'learning', title: `Completed ${d.title}`, detail: null, link: null });
      }

      // Recognition is posted to the whole workspace, so anyone who may see the employee may see what they received.
      let recognition = null;
      if (f.has('talent')) {
        const recent = await many<{ from: string; value: string | null; message: string; createdAt: string }>(
          tx,
          `select coalesce(f.preferred_name, f.first_name) || ' ' || f.last_name as "from", v.name as value, r.message, r.created_at as "createdAt"
             from recognitions r join employees f on f.id = r.from_employee_id left join company_values v on v.id = r.value_id
            where r.to_employee_id = $1 and r.hidden_at is null order by r.created_at desc limit 5`,
          [id],
        );
        const n = (await one<{ n: number }>(tx, `select count(*)::int as n from recognitions where to_employee_id = $1 and hidden_at is null and created_at > now() - interval '90 days'`, [id]))!.n;
        recognition = { last90Days: n, recent };
        for (const r of recent) timeline.push({ at: r.createdAt, kind: 'recognition', title: `Recognised by ${r.from}${r.value ? ` for ${r.value}` : ''}`, detail: r.message, link: null });
      }

      // Requests: helpdesk handlers see non-confidential cases; the employee sees all of their own.
      let requests = null;
      if (isSelf || covers('helpdesk:manage')) {
        const cases = await many<{ id: string; number: number; subject: string; status: string; createdAt: string }>(
          tx,
          `select id, number, subject, status, created_at as "createdAt" from helpdesk_cases where employee_id = $1 ${isSelf ? '' : 'and not confidential'} order by created_at desc limit 10`,
          [id],
        );
        requests = { open: cases.filter((c) => !['resolved', 'closed'].includes(c.status)).length, recent: cases.slice(0, 5) };
        for (const c of cases.slice(0, 5)) timeline.push({ at: c.createdAt, kind: 'request', title: `Request #${c.number}: ${c.subject}`, detail: c.status.replace(/_/g, ' '), link: `/helpdesk/${c.id}` });
      }

      let documents = null;
      if (f.has('documents') && covers('documents:read')) {
        const docs = await many<{ title: string; category: string; createdAt: string }>(
          tx, `select title, category, created_at as "createdAt" from employee_documents where employee_id = $1 and archived_at is null order by created_at desc limit 20`, [id],
        );
        documents = { count: docs.length, categories: [...new Set(docs.map((d) => d.category))] };
        for (const d of docs.slice(0, 5)) timeline.push({ at: d.createdAt, kind: 'document', title: `Document added: ${d.title}`, detail: d.category.replace(/_/g, ' '), link: null });
      }

      const events = await many<{ kind: string; effectiveOn: string; createdAt: string; details: Record<string, unknown> }>(
        tx, `select kind, to_char(effective_on, 'YYYY-MM-DD') as "effectiveOn", created_at as "createdAt", details from lifecycle_events where employee_id = $1 order by created_at desc limit 10`, [id],
      );
      for (const ev of events) timeline.push({ at: `${ev.effectiveOn}T09:00:00Z`, kind: 'job', title: ev.kind.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), detail: `effective ${ev.effectiveOn}`, link: null });

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
      const records = await many(
        tx,
        `select r.id, r.effective_from as "effectiveFrom", r.effective_to as "effectiveTo", r.change_reason as "reason", r.note,
                le.name as "legalEntityName", d.name as "departmentName", l.name as "locationName", ds.name as "designationName",
                trim(coalesce(mgr.preferred_name, mgr.first_name) || ' ' || mgr.last_name) as "managerName", r.grade, r.employment_type as "employmentType",
                r.effective_from > current_date as "scheduled"
           from employment_records r
           left join legal_entities le on le.id = r.legal_entity_id left join departments d on d.id = r.department_id
           left join locations l on l.id = r.location_id left join designations ds on ds.id = r.designation_id
           left join employees mgr on mgr.id = r.manager_employee_id
          where r.employee_id = $1 order by r.effective_from desc`,
        [id],
      );
      const events = await many(
        tx,
        `select ev.id, ev.kind, ev.effective_on as "effectiveOn", ev.details, ev.created_at as "createdAt", u.full_name as "by"
           from lifecycle_events ev left join users u on u.id = ev.created_by
          where ev.employee_id = $1 order by ev.effective_on desc, ev.created_at desc`,
        [id],
      );
      return { records, events };
    });
  }

  /** Direct reports, for the profile and org views. */
  async reports(id: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:read', employeeAttrs(e), tx);
      const params: unknown[] = [id];
      const scope = await this.authz.predicate('employees:read', EMPLOYEE_SCOPE, params, tx);
      return many(tx, `select ${EMPLOYEE_COLUMNS} ${EMPLOYEE_FROM} where e.current_manager_employee_id = $1 and e.status <> 'exited' and ${scope} order by e.first_name`, params);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Hiring
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Hires an employee. `within` runs in the same transaction after the record exists, so a caller such as
   * recruitment can mark its own records (application hired, opening filled) atomically with the hire.
   */
  async create(input: CreateEmployeeInput, within?: (tx: Tx, employeeId: string) => Promise<void>) {
    const actor = requestContext.tenantActor();
    let inviteToken: string | undefined;
    const created = await this.db.tenant(async (tx) => {
      await this.authz.require('employees:create', { legalEntityId: input.legalEntityId }, tx);
      const { count } = (await one<{ count: number }>(tx, `select count(*)::int as count from employees where status <> 'exited'`))!;
      await this.entitlements.requireWithinLimit('max_employees', count, tx);
      await this.checkPlacement(tx, input, null);

      const code = await this.nextEmployeeCode(tx);
      const startsLater = input.dateOfJoining > today();
      const status = startsLater ? 'pre_boarding' : input.probationMonths > 0 ? 'probation' : 'active';
      const row = (await one<{ id: string }>(
        tx,
        `insert into employees (tenant_id, employee_code, first_name, last_name, preferred_name, work_email, personal_email, phone, date_of_birth, gender,
                                date_of_joining, probation_end_date, confirmation_date, employment_type, status,
                                current_legal_entity_id, current_department_id, current_location_id, current_designation_id, current_manager_employee_id, current_grade)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date,
                 case when $11::int > 0 then ($10::date + make_interval(months => $11::int))::date - 1 end,
                 case when $11::int = 0 then $10::date end, $12, $13, $14, $15, $16, $17, $18, $19)
         returning id`,
        [code, input.firstName, input.lastName, input.preferredName ?? null, input.workEmail ?? null, input.personalEmail ?? null, input.phone ?? null,
          input.dateOfBirth ?? null, input.gender ?? null, input.dateOfJoining, input.probationMonths, input.employmentType, status,
          input.legalEntityId, input.departmentId ?? null, input.locationId ?? null, input.designationId ?? null, input.managerEmployeeId ?? null, input.grade ?? null],
      ).catch(uniqueAs('work_email_taken', 'Another current employee already uses this work email')))!;
      await tx.query(
        `insert into employment_records (tenant_id, employee_id, effective_from, legal_entity_id, department_id, location_id, designation_id, manager_employee_id, grade, employment_type, change_reason, created_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'hire', $10)`,
        [row.id, input.dateOfJoining, input.legalEntityId, input.departmentId ?? null, input.locationId ?? null, input.designationId ?? null,
          input.managerEmployeeId ?? null, input.grade ?? null, input.employmentType, actor.userId],
      );
      await this.event(tx, row.id, 'hired', input.dateOfJoining, { employeeCode: code });

      if (input.membershipId) {
        await this.linkMembership(tx, row.id, input.membershipId);
      } else if (input.inviteToCrew && input.workEmail) {
        const manager = input.managerEmployeeId ? await one<{ membership_id: string | null }>(tx, 'select membership_id from employees where id = $1', [input.managerEmployeeId]) : undefined;
        const inv = await this.members.createInvitation(tx, {
          email: input.workEmail,
          fullName: `${input.firstName} ${input.lastName}`.trim(),
          roleKeys: ['employee'],
          legalEntityId: input.legalEntityId,
          departmentId: input.departmentId ?? null,
          locationId: input.locationId ?? null,
          managerMembershipId: manager?.membership_id ?? null,
        });
        inviteToken = inv.token;
        await tx.query('update employees set membership_id = $2 where id = $1', [row.id, inv.membershipId]);
      }

      const templateId = input.onboardingTemplateId === undefined
        ? (await one<{ id: string }>(tx, 'select id from onboarding_templates where is_default and archived_at is null'))?.id
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
        const mgr = await one<{ membership_id: string | null }>(tx, 'select membership_id from employees where id = $1', [input.managerEmployeeId]);
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
    return { employee: created, inviteUrl: invite };
  }

  /** Allocates the next code from the tenant's series, skipping codes already used (e.g. by imported records). */
  private async nextEmployeeCode(tx: Tx): Promise<string> {
    await tx.query(`insert into employee_number_series (tenant_id) values (app_tenant_id()) on conflict do nothing`);
    for (let i = 0; i < 1000; i++) {
      const s = (await one<{ prefix: string; padding: number; n: number }>(
        tx, `update employee_number_series set next_value = next_value + 1 where tenant_id = app_tenant_id() returning prefix, padding, next_value - 1 as n`,
      ))!;
      const code = `${s.prefix}${String(s.n).padStart(s.padding, '0')}`;
      if (!(await one(tx, 'select 1 from employees where employee_code = $1', [code]))) return code;
    }
    throw Errors.conflict('employee_code_exhausted', 'Could not allocate an employee code. Check the numbering settings.');
  }

  /** Links an existing workspace member's login to this employee record. */
  private async linkMembership(tx: Tx, employeeId: string, membershipId: string) {
    const m = await one<{ employee_id: string | null; status: string }>(tx, 'select employee_id, status from memberships where id = $1', [membershipId]);
    if (!m) throw Errors.badRequest('invalid_member', 'Workspace member not found');
    if (m.employee_id || (await one(tx, 'select 1 from employees where membership_id = $1', [membershipId]))) {
      throw Errors.conflict('member_already_linked', 'This member is already linked to an employee record');
    }
    await tx.query('update employees set membership_id = $2 where id = $1', [employeeId, membershipId]);
    await this.onboarding.assignEmployeeTasks(tx, employeeId, membershipId);
    await this.event(tx, employeeId, 'linked_login', today(), { membershipId });
  }

  async link(id: string, membershipId: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:update', employeeAttrs(e), tx);
      await this.authz.require('users:manage', { membershipId, legalEntityId: e.legalEntityId, departmentId: e.departmentId, locationId: e.locationId }, tx);
      if (e.membershipId) throw Errors.conflict('already_linked', 'This employee already has a CREW login');
      await this.linkMembership(tx, id, membershipId);
      await this.audit.record(tx, { action: 'employee.login_linked', resourceType: 'employee', resourceId: id, metadata: { membershipId } });
      return this.load(tx, id);
    });
  }

  /** Validates references in a placement. Out-of-scope or archived targets read as not found. */
  private async checkPlacement(
    tx: Tx,
    p: { legalEntityId?: string; departmentId?: string | null; locationId?: string | null; designationId?: string | null; managerEmployeeId?: string | null },
    employeeId: string | null,
  ) {
    const exists = async (sql: string, id: string | null | undefined, code: string, msg: string) => {
      if (id && !(await one(tx, sql, [id]))) throw Errors.badRequest(code, msg);
    };
    await exists('select 1 from legal_entities where id = $1 and archived_at is null', p.legalEntityId, 'invalid_legal_entity', 'Legal entity not found');
    await exists('select 1 from departments where id = $1 and archived_at is null', p.departmentId, 'invalid_department', 'Department not found');
    await exists('select 1 from locations where id = $1 and archived_at is null', p.locationId, 'invalid_location', 'Location not found');
    await exists('select 1 from designations where id = $1 and archived_at is null', p.designationId, 'invalid_designation', 'Designation not found');
    await exists(`select 1 from employees where id = $1 and status <> 'exited'`, p.managerEmployeeId, 'invalid_manager', 'Manager not found among current employees');
    if (employeeId && p.managerEmployeeId) {
      if (p.managerEmployeeId === employeeId) throw Errors.badRequest('invalid_manager', 'An employee cannot report to themselves');
      const cycle = await one(
        tx,
        `with recursive chain(id, depth) as (
           select current_manager_employee_id, 1 from employees where id = $1
           union all select e.current_manager_employee_id, c.depth + 1 from employees e join chain c on e.id = c.id where c.depth < 100
         ) select 1 from chain where id = $2`,
        [p.managerEmployeeId, employeeId],
      );
      if (cycle) throw Errors.badRequest('invalid_manager', 'This would create a reporting loop');
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
      await tx.query(
        `update employees set ${keys.map((k, i) => `${PROFILE_COLUMNS[k]} = $${i + 2}`).join(', ')} where id = $1`,
        [id, ...keys.map((k) => input[k as keyof typeof input])],
      ).catch(uniqueAs('work_email_taken', 'Another current employee already uses this work email'));
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
      const row = await one<Record<string, string | null>>(tx, 'select * from employee_sensitive where employee_id = $1', [id]);
      await this.audit.record(tx, { action: 'employee.sensitive_viewed', resourceType: 'employee', resourceId: id });
      const dec = (v: string | null | undefined) => (v ? decryptField(v, this.config.FIELD_ENCRYPTION_KEY) : null);
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
      const enc = (v: string | null | undefined) => (v ? encryptField(v.replace(/\s+/g, ' '), this.config.FIELD_ENCRYPTION_KEY) : null);
      await tx.query(`insert into employee_sensitive (employee_id, tenant_id) values ($1, app_tenant_id()) on conflict (employee_id) do nothing`, [id]);
      const sets: string[] = [];
      const vals: unknown[] = [id];
      if (input.bankName !== undefined) {
        vals.push(input.bankName);
        sets.push(`bank_name = $${vals.length}`);
      }
      for (const [k, col] of Object.entries(SENSITIVE_COLUMNS)) {
        const v = input[k as keyof typeof SENSITIVE_COLUMNS];
        if (v === undefined) continue;
        vals.push(enc(v));
        sets.push(`${col} = $${vals.length}`);
      }
      const changed = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
      if (sets.length) {
        vals.push(actor.userId);
        await tx.query(`update employee_sensitive set ${sets.join(', ')}, updated_by = $${vals.length}, updated_at = now() where employee_id = $1`, vals);
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

      const later = await one(tx, 'select 1 from employment_records where employee_id = $1 and effective_from > $2', [id, input.effectiveFrom]);
      if (later) throw Errors.conflict('later_change_scheduled', 'A later change is already recorded. Correct that one first.');
      const current = await one<Record<string, unknown> & { id: string; effective_from: string; effective_to: string | null }>(
        tx, 'select * from employment_records where employee_id = $1 and effective_from <= $2 order by effective_from desc limit 1 for update', [id, input.effectiveFrom],
      );
      if (!current) throw Errors.conflict('no_record', 'No job record covers that date');

      const pick = <T>(v: T | undefined, fallback: unknown) => (v === undefined ? fallback : v);
      const next = {
        legal_entity_id: pick(input.legalEntityId, current.legal_entity_id) as string,
        department_id: pick(input.departmentId, current.department_id),
        location_id: pick(input.locationId, current.location_id),
        designation_id: pick(input.designationId, current.designation_id),
        manager_employee_id: pick(input.managerEmployeeId, current.manager_employee_id),
        grade: pick(input.grade, current.grade),
        employment_type: pick(input.employmentType, current.employment_type),
      };
      const changedCols = Object.keys(next).filter((k) => (next as Record<string, unknown>)[k] !== current[k]);
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

      const values = [next.legal_entity_id, next.department_id, next.location_id, next.designation_id, next.manager_employee_id, next.grade, next.employment_type];
      if (current.effective_from === input.effectiveFrom) {
        await tx.query(
          `update employment_records set legal_entity_id = $2, department_id = $3, location_id = $4, designation_id = $5, manager_employee_id = $6, grade = $7,
             employment_type = $8, change_reason = case when change_reason = 'hire' then 'hire' else $9 end, note = coalesce($10, note) where id = $1`,
          [current.id, ...values, input.reason, input.note ?? null],
        );
      } else {
        await tx.query(`update employment_records set effective_to = $2::date - 1 where id = $1`, [current.id, input.effectiveFrom]);
        await tx.query(
          `insert into employment_records (tenant_id, employee_id, effective_from, effective_to, legal_entity_id, department_id, location_id, designation_id,
                                           manager_employee_id, grade, employment_type, change_reason, note, created_by)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [id, input.effectiveFrom, current.effective_to, ...values, input.reason, input.note ?? null, actor.userId],
        );
      }
      await tx.query('select employees_apply_current(current_date)');
      const kind = input.reason === 'promotion' ? 'promoted' : changedCols.length === 1 && changedCols[0] === 'manager_employee_id' ? 'manager_changed' : LIFECYCLE_KIND[input.reason]!;
      await this.event(tx, id, kind, input.effectiveFrom, { reason: input.reason, changed: changedCols, note: input.note ?? null });
      const after = await this.load(tx, id);
      await this.audit.record(tx, {
        action: `employee.job_changed`, resourceType: 'employee', resourceId: id,
        changes: Object.fromEntries(changedCols.map((c) => [c, { from: current[c] ?? null, to: (next as Record<string, unknown>)[c] ?? null }])),
        metadata: { effectiveFrom: input.effectiveFrom, reason: input.reason },
      });
      await this.outbox.publish(tx, actor.tenantId, 'employee.job_changed', { employeeId: id, effectiveFrom: input.effectiveFrom, changed: changedCols });
      const newManager = next.manager_employee_id ? await one<{ membership_id: string | null }>(tx, 'select membership_id from employees where id = $1', [next.manager_employee_id]) : undefined;
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
      await tx.query(`update employees set status = 'active', confirmation_date = $2 where id = $1`, [id, input.effectiveOn]);
      await this.event(tx, id, 'confirmed', input.effectiveOn, { note: input.note ?? null });
      await this.notifications.notify(tx, { membershipIds: [e.membershipId], kind: 'employee.confirmed', title: 'Your employment has been confirmed', link: `/employees/${id}`, email: true });
      return { action: 'employee.confirmed', changes: { status: { from: 'probation', to: 'active' }, confirmationDate: input.effectiveOn } };
    });
  }

  async extendProbation(id: string, input: z.infer<typeof extendProbationInput>) {
    return this.lifecycle(id, async (tx, e) => {
      if (e.status !== 'probation') throw Errors.conflict('invalid_state', 'Only employees on probation can have it extended');
      if (e.probationEndDate && input.newEndDate <= e.probationEndDate) throw Errors.badRequest('not_later', 'The new end date must be after the current one');
      await tx.query('update employees set probation_end_date = $2 where id = $1', [id, input.newEndDate]);
      await this.event(tx, id, 'probation_extended', today(), { from: e.probationEndDate, to: input.newEndDate, note: input.note ?? null });
      return { action: 'employee.probation_extended', changes: { probationEndDate: { from: e.probationEndDate, to: input.newEndDate } } };
    });
  }

  /** Records a resignation or termination. The person keeps access until the last working day passes. */
  async scheduleExit(id: string, input: z.infer<typeof exitInput>) {
    return this.lifecycle(id, async (tx, e) => {
      if (e.status === 'exited' || e.status === 'notice') throw Errors.conflict('invalid_state', e.status === 'notice' ? 'An exit is already scheduled' : 'This person has already left');
      if (input.lastWorkingDay < e.dateOfJoining) throw Errors.badRequest('before_joining', 'The last working day cannot be before the joining date');
      if (await one(tx, 'select 1 from employment_records where employee_id = $1 and effective_from > $2', [id, input.lastWorkingDay])) {
        throw Errors.conflict('later_change_scheduled', 'A job change is scheduled after the last working day. Correct it first.');
      }
      await tx.query(
        `update employees set status = 'notice', exit_type = $2, resignation_date = $3, last_working_day = $4, exit_reason = $5 where id = $1`,
        [id, input.exitType, input.resignationDate ?? null, input.lastWorkingDay, input.reason ?? null],
      );
      await tx.query(`update employment_records set effective_to = $2 where employee_id = $1 and (effective_to is null or effective_to > $2) and effective_from <= $2`, [id, input.lastWorkingDay]);
      if (input.resignationDate) await this.event(tx, id, 'resigned', input.resignationDate, {});
      await this.event(tx, id, 'exit_scheduled', input.lastWorkingDay, { exitType: input.exitType });
      const mgr = e.managerEmployeeId ? await one<{ membership_id: string | null }>(tx, 'select membership_id from employees where id = $1', [e.managerEmployeeId]) : undefined;
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
      await tx.query(`update employees set status = $2, exit_type = null, resignation_date = null, last_working_day = null, exit_reason = null where id = $1`, [id, status]);
      await tx.query(`update employment_records set effective_to = null where employee_id = $1 and effective_to = $2`, [id, e.lastWorkingDay]);
      await this.event(tx, id, 'exit_withdrawn', today(), { lastWorkingDay: e.lastWorkingDay });
      return { action: 'employee.exit_withdrawn', changes: { status: { from: 'notice', to: status } } };
    });
  }

  private async lifecycle(id: string, fn: (tx: Tx, e: EmployeeRow) => Promise<{ action: string; changes: Record<string, unknown> }>) {
    return this.db.tenant(async (tx) => {
      const e = await this.load(tx, id);
      await this.authz.require('employees:lifecycle', employeeAttrs(e), tx);
      await tx.query('select 1 from employees where id = $1 for update', [id]);
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
  async startJoiners(tx: Tx, asOf: string): Promise<number> {
    const r = await tx.query(
      `update employees set status = case when probation_end_date is not null then 'probation' else 'active' end
        where status = 'pre_boarding' and date_of_joining <= $1`, [asOf],
    );
    return r.rowCount ?? 0;
  }

  /** Completes exits whose last working day has passed: the login is suspended and sessions are revoked. */
  async finaliseExits(tx: Tx, asOf: string): Promise<number> {
    const due = await many<{ id: string; membership_id: string | null; last_working_day: string; tenant_id: string }>(
      tx, `select id, membership_id, last_working_day, tenant_id from employees where status = 'notice' and last_working_day < $1 for update`, [asOf],
    );
    for (const e of due) {
      await tx.query(`update employees set status = 'exited' where id = $1`, [e.id]);
      await this.event(tx, e.id, 'exited', e.last_working_day, {});
      // Open leave after the last day can no longer be taken.
      const open = await many<{ id: string; approval_request_id: string | null }>(
        tx, `select id, approval_request_id from leave_requests where employee_id = $1 and status = 'pending'`, [e.id],
      );
      for (const l of open) {
        await tx.query(`update leave_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Employee left' where id = $1`, [l.id]);
        if (l.approval_request_id) {
          await tx.query(`update approval_steps set status = 'cancelled' where request_id = $1 and status in ('pending', 'waiting')`, [l.approval_request_id]);
          await tx.query(`update approval_requests set status = 'cancelled', decided_at = now() where id = $1`, [l.approval_request_id]);
        }
      }
      if (e.membership_id) {
        const m = await one<{ user_id: string; status: string }>(tx, 'select user_id, status from memberships where id = $1', [e.membership_id]);
        if (m && m.status !== 'suspended') {
          await tx.query(`update memberships set status = 'suspended' where id = $1`, [e.membership_id]);
          await this.db.platform((ptx) =>
            ptx.query(`update sessions set revoked_at = now(), revoked_reason = 'employee_exited' where user_id = $1 and tenant_id = $2 and revoked_at is null`, [m.user_id, e.tenant_id]),
          );
        }
      }
      await this.audit.record(tx, { action: 'employee.exited', resourceType: 'employee', resourceId: e.id, metadata: { lastWorkingDay: e.last_working_day }, tenantId: e.tenant_id });
      await this.outbox.publish(tx, e.tenant_id, 'employee.exited', { employeeId: e.id });
    }
    return due.length;
  }

  private async event(tx: Tx, employeeId: string, kind: string, effectiveOn: string, details: Record<string, unknown>) {
    const actor = requestContext.get()?.actor;
    await tx.query(
      `insert into lifecycle_events (tenant_id, employee_id, kind, effective_on, details, created_by) values (app_tenant_id(), $1, $2, $3, $4, $5)`,
      [employeeId, kind, effectiveOn, JSON.stringify(details), actor?.kind === 'user' ? actor.userId : null],
    );
  }
}

/** Turns a unique-constraint violation into a readable 409. */
export function uniqueAs(code: string, message: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === '23505') throw Errors.conflict(code, message);
    throw err;
  };
}

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { leaveMath, type WorkCalendar } from '@crew/contracts';
import type {
  holidayCalendarInput,
  holidayInput,
  leaveAdjustmentInput,
  leavePolicyInput,
  LeaveRequestInput,
  leaveTypeInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor, type ResourceAttributes } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService, type ApprovalRequestRow } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { employeeAttrs } from '../employees/employee-attrs';


interface PolicyRow {
  id: string;
  leave_type_id: string;
  legal_entity_id: string | null;
  accrual_method: 'annual_upfront' | 'monthly' | 'none';
  annual_entitlement: string;
  carry_forward_max: string;
  allow_negative_balance: boolean;
  min_notice_days: number;
  max_consecutive_days: string | null;
  available_during_probation: boolean;
  rounding: 'none' | 'half_day';
}

interface EmployeeLite {
  id: string;
  membership_id: string | null;
  status: string;
  date_of_joining: string;
  last_working_day: string | null;
  legal_entity_id: string | null;
  department_id: string | null;
  location_id: string | null;
  name: string;
}

interface RequestRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  start_date: string;
  end_date: string;
  days: string;
  status: string;
  approval_request_id: string | null;
  requested_by_membership_id: string | null;
}

const POLICY_COLUMNS = `p.id, p.leave_type_id as "leaveTypeId", t.name as "leaveTypeName", t.code as "leaveTypeCode", p.legal_entity_id as "legalEntityId",
  le.name as "legalEntityName", p.accrual_method as "accrualMethod", p.annual_entitlement::text as "annualEntitlement",
  p.carry_forward_max::text as "carryForwardMax", p.allow_negative_balance as "allowNegativeBalance", p.min_notice_days as "minNoticeDays",
  p.max_consecutive_days::text as "maxConsecutiveDays", p.available_during_probation as "availableDuringProbation", p.rounding, p.created_at as "createdAt"`;

const REQUEST_COLUMNS = `r.id, r.employee_id as "employeeId", trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName",
  e.employee_code as "employeeCode", r.leave_type_id as "leaveTypeId", t.name as "leaveTypeName", t.code as "leaveTypeCode", t.color,
  r.start_date as "startDate", r.end_date as "endDate", r.start_half as "startHalf", r.end_half as "endHalf", r.days::text as days, r.reason,
  r.status, r.approval_request_id as "approvalId", r.created_at as "createdAt", r.decided_at as "decidedAt", r.cancelled_at as "cancelledAt",
  r.cancel_reason as "cancelReason", ru.full_name as "requestedBy"`;
const REQUEST_FROM = `from leave_requests r join employees e on e.id = r.employee_id join leave_types t on t.id = r.leave_type_id
  left join memberships rm on rm.id = r.requested_by_membership_id left join users ru on ru.id = rm.user_id`;
const REQUEST_SCOPE = { membershipId: 'e.membership_id', legalEntityId: 'e.current_legal_entity_id', departmentId: 'e.current_department_id', locationId: 'e.current_location_id', employeeId: 'e.id' };

const { accrualsDue, addDays, countLeaveDays, fromH, toH, yearEnd, yearOf } = leaveMath;
const today = () => new Date().toISOString().slice(0, 10);
const LEAVE_TYPE_COLUMNS = { code: 'code', name: 'name', description: 'description', paid: 'paid', allowHalfDay: 'allow_half_day', color: 'color' } as const;

/**
 * Leave: types, policies, holiday calendars, requests and the append-only balance ledger. A request is
 * approved through the shared approvals engine; approval writes a 'taken' ledger row, and cancelling
 * approved leave writes a 'reversal', so a balance is always the sum of its explainable history.
 */
@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly attendance: AttendanceService,
  ) {}

  onModuleInit() {
    this.approvals.register('leave_request', {
      permission: 'leave:approve',
      configurePermission: 'leave:configure',
      defaultSteps: [{ type: 'manager' }],
      fallbackRole: 'hr_admin',
      label: 'Leave request',
      link: () => '/leave',
      attributes: async (tx, id) => {
        const r = await one<{ employee_id: string }>(tx, 'select employee_id from leave_requests where id = $1', [id]);
        return this.attrsOf(await this.employee(tx, r!.employee_id));
      },
      onApproved: (tx, req) => this.onApproved(tx, req),
      onRejected: async (tx, req) => {
        await tx.query(`update leave_requests set status = 'rejected', decided_at = now() where id = $1 and status = 'pending'`, [req.resource_id]);
        await this.audit.record(tx, { action: 'leave_request.rejected', resourceType: 'leave_request', resourceId: req.resource_id });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Types and policies
  // ---------------------------------------------------------------------------------------------------------

  listTypes(includeArchived = false) {
    return this.db.tenant((tx) =>
      many(tx, `select id, code, name, description, paid, allow_half_day as "allowHalfDay", color, archived_at as "archivedAt" from leave_types
                 ${includeArchived ? '' : 'where archived_at is null'} order by name`),
    );
  }

  createType(input: z.infer<typeof leaveTypeInput>) {
    return this.db.tenant(async (tx) => {
      const row = await one<{ id: string }>(
        tx, `insert into leave_types (tenant_id, code, name, description, paid, allow_half_day, color) values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [input.code, input.name, input.description ?? null, input.paid, input.allowHalfDay, input.color],
      ).catch(conflictOn('23505', 'leave_type_exists', 'A leave type with this code already exists'));
      await this.audit.record(tx, { action: 'leave_type.created', resourceType: 'leave_type', resourceId: row!.id, changes: input });
      return { id: row!.id, ...input };
    });
  }

  updateType(id: string, input: Partial<z.infer<typeof leaveTypeInput>>) {
    return this.db.tenant(async (tx) => {
      const entries = Object.entries(input).filter(([k, v]) => v !== undefined && k in LEAVE_TYPE_COLUMNS);
      if (!(await one(tx, 'select 1 from leave_types where id = $1', [id]))) throw Errors.notFound('Leave type');
      if (entries.length) {
        await tx.query(`update leave_types set ${entries.map(([k], i) => `${LEAVE_TYPE_COLUMNS[k as keyof typeof LEAVE_TYPE_COLUMNS]} = $${i + 2}`).join(', ')} where id = $1`, [id, ...entries.map(([, v]) => v)])
          .catch(conflictOn('23505', 'leave_type_exists', 'A leave type with this code already exists'));
        await this.audit.record(tx, { action: 'leave_type.updated', resourceType: 'leave_type', resourceId: id, changes: Object.fromEntries(entries) });
      }
      return one(tx, `select id, code, name, description, paid, allow_half_day as "allowHalfDay", color from leave_types where id = $1`, [id]);
    });
  }

  archiveType(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update leave_types set archived_at = now() where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Leave type');
      await tx.query('update leave_policies set active = false where leave_type_id = $1 and active', [id]);
      await this.audit.record(tx, { action: 'leave_type.archived', resourceType: 'leave_type', resourceId: id });
    });
  }

  listPolicies() {
    return this.db.tenant((tx) =>
      many(tx, `select ${POLICY_COLUMNS} from leave_policies p join leave_types t on t.id = p.leave_type_id left join legal_entities le on le.id = p.legal_entity_id
                 where p.active and t.archived_at is null order by t.name, le.name nulls first`),
    );
  }

  /** Saving a policy for a type and entity replaces the active one; the old version is kept for history. */
  setPolicy(input: z.infer<typeof leavePolicyInput>) {
    return this.db.tenant(async (tx) => {
      if (!(await one(tx, 'select 1 from leave_types where id = $1 and archived_at is null', [input.leaveTypeId]))) throw Errors.badRequest('invalid_leave_type', 'Leave type not found');
      if (input.legalEntityId && !(await one(tx, 'select 1 from legal_entities where id = $1 and archived_at is null', [input.legalEntityId]))) {
        throw Errors.badRequest('invalid_legal_entity', 'Legal entity not found');
      }
      const prev = await one<{ id: string }>(
        tx, `update leave_policies set active = false where active and leave_type_id = $1 and legal_entity_id is not distinct from $2 returning id`,
        [input.leaveTypeId, input.legalEntityId],
      );
      const row = (await one<{ id: string }>(
        tx,
        `insert into leave_policies (tenant_id, leave_type_id, legal_entity_id, accrual_method, annual_entitlement, carry_forward_max, allow_negative_balance,
                                     min_notice_days, max_consecutive_days, available_during_probation, rounding)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [input.leaveTypeId, input.legalEntityId, input.accrualMethod, input.annualEntitlement, input.carryForwardMax, input.allowNegativeBalance,
          input.minNoticeDays, input.maxConsecutiveDays, input.availableDuringProbation, input.rounding],
      ))!;
      await this.audit.record(tx, { action: 'leave_policy.saved', resourceType: 'leave_policy', resourceId: row.id, changes: input, metadata: { replaces: prev?.id ?? null } });
      return one(tx, `select ${POLICY_COLUMNS} from leave_policies p join leave_types t on t.id = p.leave_type_id left join legal_entities le on le.id = p.legal_entity_id where p.id = $1`, [row.id]);
    });
  }

  removePolicy(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update leave_policies set active = false where id = $1 and active', [id]);
      if (!r.rowCount) throw Errors.notFound('Leave policy');
      await this.audit.record(tx, { action: 'leave_policy.removed', resourceType: 'leave_policy', resourceId: id });
    });
  }

  private async policyFor(tx: Tx, leaveTypeId: string, legalEntityId: string | null): Promise<PolicyRow | undefined> {
    return one<PolicyRow>(
      tx,
      `select p.*, p.annual_entitlement::text as annual_entitlement, p.carry_forward_max::text as carry_forward_max, p.max_consecutive_days::text as max_consecutive_days
         from leave_policies p where p.active and p.leave_type_id = $1 and (p.legal_entity_id = $2 or p.legal_entity_id is null)
        order by p.legal_entity_id nulls last limit 1`,
      [leaveTypeId, legalEntityId],
    );
  }

  // ---------------------------------------------------------------------------------------------------------
  // Holiday calendars
  // ---------------------------------------------------------------------------------------------------------

  listCalendars() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select c.id, c.name, c.legal_entity_id as "legalEntityId", le.name as "legalEntityName", c.location_id as "locationId", l.name as "locationName",
                c.is_default as "isDefault", c.weekly_offs as "weeklyOffs",
                coalesce((select json_agg(json_build_object('id', h.id, 'date', h.holiday_date, 'name', h.name, 'isOptional', h.is_optional) order by h.holiday_date)
                            from holidays h where h.calendar_id = c.id), '[]') as holidays
           from holiday_calendars c left join legal_entities le on le.id = c.legal_entity_id left join locations l on l.id = c.location_id
          order by c.is_default desc, c.name`,
      ),
    );
  }

  saveCalendar(id: string | null, input: z.infer<typeof holidayCalendarInput>) {
    return this.db.tenant(async (tx) => {
      if (input.isDefault) await tx.query('update holiday_calendars set is_default = false where is_default and id is distinct from $1', [id]);
      const offs = [...new Set(input.weeklyOffs)].sort();
      let calendarId = id;
      if (id) {
        const r = await tx.query(
          'update holiday_calendars set name = $2, legal_entity_id = $3, location_id = $4, is_default = $5, weekly_offs = $6 where id = $1',
          [id, input.name, input.legalEntityId, input.locationId, input.isDefault, offs],
        );
        if (!r.rowCount) throw Errors.notFound('Holiday calendar');
      } else {
        calendarId = (await one<{ id: string }>(
          tx, `insert into holiday_calendars (tenant_id, name, legal_entity_id, location_id, is_default, weekly_offs) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
          [input.name, input.legalEntityId, input.locationId, input.isDefault, offs],
        ))!.id;
      }
      await this.audit.record(tx, { action: id ? 'holiday_calendar.updated' : 'holiday_calendar.created', resourceType: 'holiday_calendar', resourceId: calendarId, changes: input });
      return { id: calendarId, ...input, weeklyOffs: offs };
    });
  }

  deleteCalendar(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('delete from holiday_calendars where id = $1', [id]);
      if (!r.rowCount) throw Errors.notFound('Holiday calendar');
      await this.audit.record(tx, { action: 'holiday_calendar.deleted', resourceType: 'holiday_calendar', resourceId: id });
    });
  }

  addHoliday(calendarId: string, input: z.infer<typeof holidayInput>) {
    return this.db.tenant(async (tx) => {
      if (!(await one(tx, 'select 1 from holiday_calendars where id = $1', [calendarId]))) throw Errors.notFound('Holiday calendar');
      const row = await one<{ id: string }>(
        tx, `insert into holidays (tenant_id, calendar_id, holiday_date, name, is_optional) values (app_tenant_id(), $1, $2, $3, $4) returning id`,
        [calendarId, input.date, input.name, input.isOptional],
      ).catch(conflictOn('23505', 'holiday_exists', 'This calendar already has a holiday on that date'));
      await this.audit.record(tx, { action: 'holiday.added', resourceType: 'holiday_calendar', resourceId: calendarId, changes: input });
      return { id: row!.id, ...input };
    });
  }

  removeHoliday(calendarId: string, holidayId: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('delete from holidays where id = $1 and calendar_id = $2', [holidayId, calendarId]);
      if (!r.rowCount) throw Errors.notFound('Holiday');
      await this.audit.record(tx, { action: 'holiday.removed', resourceType: 'holiday_calendar', resourceId: calendarId, metadata: { holidayId } });
    });
  }

  /** The calendar for an employee: their location's, else their legal entity's, else the workspace default. */
  private async calendarFor(tx: Tx, e: Pick<EmployeeLite, 'legal_entity_id' | 'location_id'>): Promise<WorkCalendar & { id: string | null }> {
    const cal = await one<{ id: string; weekly_offs: number[] }>(
      tx,
      `select id, weekly_offs from holiday_calendars
        where (location_id = $2) or (location_id is null and legal_entity_id = $1) or is_default
        order by (location_id = $2) desc nulls last, (legal_entity_id = $1) desc nulls last, is_default desc limit 1`,
      [e.legal_entity_id, e.location_id],
    );
    if (!cal) return { id: null, weeklyOffs: [0, 6], holidays: new Set() };
    const hs = await many<{ d: string }>(tx, 'select holiday_date as d from holidays where calendar_id = $1 and not is_optional', [cal.id]);
    return { id: cal.id, weeklyOffs: cal.weekly_offs.map(Number), holidays: new Set(hs.map((h) => h.d)) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Balances
  // ---------------------------------------------------------------------------------------------------------

  private async employee(tx: Tx, id: string): Promise<EmployeeLite> {
    const e = await one<EmployeeLite>(
      tx,
      `select id, membership_id, status, date_of_joining, last_working_day, current_legal_entity_id as legal_entity_id, current_department_id as department_id,
              current_location_id as location_id, trim(coalesce(preferred_name, first_name) || ' ' || last_name) as name
         from employees where id = $1`,
      [id],
    );
    if (!e) throw Errors.notFound('Employee');
    return e;
  }

  private attrsOf(e: EmployeeLite): ResourceAttributes {
    return employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });
  }

  /** The caller's employee id, or a clear error when their login is not linked to an employee record. */
  private async myEmployeeId(tx: Tx): Promise<string> {
    const s = await this.authz.subject(tx);
    if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
    return s.employeeId;
  }

  async balances(employeeId: string | undefined, year = yearOf(today())) {
    return this.db.tenant(async (tx) => {
      const id = employeeId ?? (await this.myEmployeeId(tx));
      const e = await this.employee(tx, id);
      await this.authz.require('leave:read', this.attrsOf(e), tx);
      return { employeeId: id, year, balances: await this.balanceRows(tx, e, year) };
    });
  }

  private async balanceRows(tx: Tx, e: EmployeeLite, year: number) {
    const types = await many<{ id: string; code: string; name: string; color: string; paid: boolean; allow_half_day: boolean }>(
      tx, 'select id, code, name, color, paid, allow_half_day from leave_types where archived_at is null order by name',
    );
    const sums = await many<{ leave_type_id: string; kind: string; q: string }>(
      tx, `select leave_type_id, kind, sum(quantity)::text as q from leave_ledger where employee_id = $1 and leave_year = $2 group by 1, 2`, [e.id, year],
    );
    const pending = await many<{ leave_type_id: string; q: string }>(
      tx, `select leave_type_id, sum(days)::text as q from leave_requests where employee_id = $1 and status = 'pending' and extract(year from start_date) = $2 group by 1`, [e.id, year],
    );
    const out = [];
    for (const t of types) {
      const policy = await this.policyFor(tx, t.id, e.legal_entity_id);
      if (!policy) continue;
      const k = (kind: string) => toH(sums.find((s) => s.leave_type_id === t.id && s.kind === kind)?.q ?? '0');
      const accrued = k('accrual');
      const carried = k('carry_forward');
      const adjusted = k('adjustment');
      const taken = -(k('taken') + k('reversal'));
      const lapsed = -k('lapse');
      const balance = accrued + carried + adjusted - taken - lapsed;
      const pend = toH(pending.find((p) => p.leave_type_id === t.id)?.q ?? '0');
      const tracked = policy.accrual_method !== 'none';
      out.push({
        leaveTypeId: t.id, code: t.code, name: t.name, color: t.color, paid: t.paid, allowHalfDay: t.allow_half_day,
        tracked, annualEntitlement: policy.annual_entitlement, accrualMethod: policy.accrual_method,
        accrued: fromH(accrued), carriedForward: fromH(carried), adjusted: fromH(adjusted), taken: fromH(taken), lapsed: fromH(lapsed),
        balance: fromH(balance), pending: fromH(pend), available: tracked ? fromH(balance - pend) : null,
      });
    }
    return out;
  }

  /** Every ledger line behind a balance, so any number on screen can be explained. */
  async ledger(employeeId: string, leaveTypeId: string, year: number) {
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, employeeId);
      await this.authz.require('leave:read', this.attrsOf(e), tx);
      return many(
        tx,
        `select l.id, l.kind, l.quantity::text as quantity, l.effective_on as "effectiveOn", l.note, l.leave_request_id as "leaveRequestId",
                l.created_at as "createdAt", u.full_name as "by"
           from leave_ledger l left join users u on u.id = l.created_by
          where l.employee_id = $1 and l.leave_type_id = $2 and l.leave_year = $3 order by l.effective_on, l.created_at`,
        [employeeId, leaveTypeId, year],
      );
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------------------------------------

  /** Days and balance impact for a draft request, without saving it. */
  async preview(input: LeaveRequestInput) {
    return this.db.tenant(async (tx) => {
      const { e, onBehalf } = await this.requestTarget(tx, input.employeeId);
      return this.evaluate(tx, e, input, onBehalf);
    });
  }

  private async requestTarget(tx: Tx, employeeId: string | undefined) {
    const mine = (await this.authz.subject(tx)).employeeId;
    const id = employeeId ?? (await this.myEmployeeId(tx));
    const e = await this.employee(tx, id);
    const onBehalf = id !== mine;
    // Filing for someone else needs approval rights over them (a manager for their team, HR for their scope).
    await this.authz.require(onBehalf ? 'leave:approve' : 'leave:request', this.attrsOf(e), tx);
    return { e, onBehalf };
  }

  private async evaluate(tx: Tx, e: EmployeeLite, input: LeaveRequestInput, onBehalf: boolean) {
    const type = await one<{ id: string; name: string; allow_half_day: boolean }>(tx, 'select id, name, allow_half_day from leave_types where id = $1 and archived_at is null', [input.leaveTypeId]);
    if (!type) throw Errors.badRequest('invalid_leave_type', 'Leave type not found');
    const policy = await this.policyFor(tx, type.id, e.legal_entity_id);
    if (!policy) throw Errors.badRequest('no_policy', `${type.name} is not available for this employee's legal entity`);
    if (yearOf(input.startDate) !== yearOf(input.endDate)) throw Errors.badRequest('spans_years', 'Split leave that crosses 31 December into one request per year');
    if (!type.allow_half_day && (input.startHalf !== 'full' || input.endHalf !== 'full')) throw Errors.badRequest('no_half_days', `${type.name} cannot be taken in half days`);
    if (e.status === 'exited') throw Errors.badRequest('employee_exited', 'This person has left');
    if (input.startDate < e.date_of_joining) throw Errors.badRequest('before_joining', 'Leave cannot start before the joining date');
    if (e.last_working_day && input.endDate > e.last_working_day) throw Errors.badRequest('after_exit', 'Leave cannot end after the last working day');
    if (e.status === 'probation' && !policy.available_during_probation) throw Errors.badRequest('not_during_probation', `${type.name} is available after probation`);

    const cal = await this.calendarFor(tx, e);
    const daysH = countLeaveDays(input, cal);
    if (daysH <= 0) throw Errors.badRequest('no_working_days', 'Those dates are all weekly offs or holidays');
    if (policy.max_consecutive_days && daysH > toH(policy.max_consecutive_days)) {
      throw Errors.badRequest('too_long', `${type.name} allows at most ${policy.max_consecutive_days} days in one request`);
    }
    if (!onBehalf && policy.min_notice_days > 0 && input.startDate < addDays(today(), policy.min_notice_days)) {
      throw Errors.badRequest('short_notice', `${type.name} needs ${policy.min_notice_days} days' notice`);
    }
    const balance = (await this.balanceRows(tx, e, yearOf(input.startDate))).find((b) => b.leaveTypeId === type.id);
    const tracked = policy.accrual_method !== 'none';
    const availableH = balance?.available ? toH(balance.available) : 0;
    const afterH = availableH - daysH;
    if (tracked && afterH < 0 && !policy.allow_negative_balance) {
      throw Errors.badRequest('insufficient_balance', `Not enough ${type.name}: ${fromH(availableH)} available, ${fromH(daysH)} requested`);
    }
    const holidays = [...cal.holidays].filter((d) => d >= input.startDate && d <= input.endDate).sort();
    return {
      days: fromH(daysH),
      tracked,
      available: tracked ? fromH(availableH) : null,
      balanceAfter: tracked ? fromH(afterH) : null,
      holidaysInRange: holidays,
      calendarId: cal.id,
      warnings: tracked && afterH < 0 ? ['This takes the balance below zero; it will be recovered from future accruals.'] : [],
    };
  }

  async request(input: LeaveRequestInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const { e, onBehalf } = await this.requestTarget(tx, input.employeeId);
      await tx.query('select 1 from employees where id = $1 for update', [e.id]);
      const preview = await this.evaluate(tx, e, input, onBehalf);
      const type = (await one<{ name: string }>(tx, 'select name from leave_types where id = $1', [input.leaveTypeId]))!;
      const row = (await one<{ id: string }>(
        tx,
        `insert into leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, start_half, end_half, days, reason, requested_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [e.id, input.leaveTypeId, input.startDate, input.endDate, input.startHalf, input.endHalf, preview.days, input.reason ?? null, actor.membershipId],
      ).catch(conflictOn('23P01', 'overlapping_leave', 'There is already a pending or approved request on these dates')))!;
      const range = input.startDate === input.endDate ? input.startDate : `${input.startDate} to ${input.endDate}`;
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'leave_request', resourceId: row.id, subjectEmployeeId: e.id,
        summary: `${e.name}: ${type.name}, ${range} (${preview.days} days)${input.reason ? `. "${input.reason}"` : ''}`,
      });
      await tx.query('update leave_requests set approval_request_id = $2 where id = $1', [row.id, approvalId]);
      await this.audit.record(tx, {
        action: 'leave_request.submitted', resourceType: 'leave_request', resourceId: row.id,
        changes: { employeeId: e.id, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, days: preview.days },
        metadata: { onBehalf },
      });
      await this.outbox.publish(tx, actor.tenantId, 'leave.requested', { leaveRequestId: row.id, employeeId: e.id });
      return this.loadRequest(tx, row.id);
    });
  }

  private async onApproved(tx: Tx, req: ApprovalRequestRow) {
    const r = (await one<RequestRow>(tx, `select *, days::text as days from leave_requests where id = $1 for update`, [req.resource_id]))!;
    if (r.status !== 'pending') return;
    await tx.query(`update leave_requests set status = 'approved', decided_at = now() where id = $1`, [r.id]);
    await tx.query(
      `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, kind, quantity, effective_on, leave_request_id, created_by)
       values (app_tenant_id(), $1, $2, $3, 'taken', $4, $5, $6, $7)`,
      [r.employee_id, r.leave_type_id, yearOf(r.start_date), fromH(-toH(r.days)), r.start_date, r.id, requestContext.tenantActor().userId],
    );
    await this.audit.record(tx, { action: 'leave_request.approved', resourceType: 'leave_request', resourceId: r.id, metadata: { days: r.days } });
    // Attendance days already past show the leave instead of an absence.
    await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
    await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'leave.approved', { leaveRequestId: r.id, employeeId: r.employee_id });
  }

  /**
   * Cancels a request. Pending requests: the employee or anyone with approval scope. Approved leave: the
   * employee before it starts, or an approver at any time; the days go back through a reversal row.
   */
  async cancel(id: string, reason?: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await one<RequestRow>(tx, `select *, days::text as days from leave_requests where id = $1 for update`, [id]);
      if (!r) throw Errors.notFound('Leave request');
      const e = await this.employee(tx, r.employee_id);
      const s = await this.authz.subject(tx);
      const attrs = this.attrsOf(e);
      const isOwner = s.employeeId === e.id || r.requested_by_membership_id === actor.membershipId;
      const isApprover = grantsFor(s, 'leave:approve').some((g) => grantCovers(s, g, attrs)) && s.employeeId !== e.id;
      if (!isOwner && !isApprover) {
        await this.authz.require('leave:read', attrs, tx); // 404 when they cannot even see it
        throw Errors.forbidden();
      }
      if (r.status !== 'pending' && r.status !== 'approved') throw Errors.conflict('invalid_state', `This request is already ${r.status}`);
      if (r.status === 'approved' && !isApprover && r.start_date <= today()) {
        throw Errors.forbidden('Leave that has started can only be cancelled by your approver or HR');
      }
      if (isApprover && !isOwner) await this.authz.require('leave:approve', attrs, tx);
      await tx.query(`update leave_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [id, reason ?? null]);
      if (r.status === 'pending' && r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      if (r.status === 'approved') {
        await tx.query(
          `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, kind, quantity, effective_on, leave_request_id, note, created_by)
           values (app_tenant_id(), $1, $2, $3, 'reversal', $4, $5, $6, $7, $8)`,
          [r.employee_id, r.leave_type_id, yearOf(r.start_date), r.days, r.start_date, id, reason ?? 'Cancelled', actor.userId],
        );
      }
      if (r.status === 'approved') await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
      await this.audit.record(tx, { action: 'leave_request.cancelled', resourceType: 'leave_request', resourceId: id, metadata: { from: r.status, reason: reason ?? null } });
      if (!isOwner || r.status === 'approved') {
        const approvers = r.approval_request_id
          ? (await many<{ m: string | null }>(tx, 'select coalesce(decided_by_membership_id, approver_membership_id) as m from approval_steps where request_id = $1', [r.approval_request_id])).map((x) => x.m)
          : [];
        await this.notifications.notify(tx, {
          membershipIds: (isOwner ? approvers : [e.membership_id]).filter((m) => m !== actor.membershipId),
          kind: 'leave.cancelled',
          title: `Leave cancelled: ${e.name}, ${r.start_date}${r.end_date !== r.start_date ? ` to ${r.end_date}` : ''}`,
          body: reason,
          link: isOwner ? '/approvals' : '/leave',
          email: true,
        });
      }
      return this.loadRequest(tx, id);
    });
  }

  async listRequests(q: { employeeId?: string; status?: string; from?: string; to?: string; scope?: 'mine' | 'visible'; limit: number }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.scope === 'mine' || (!q.employeeId && q.scope !== 'visible')) {
        params.push(await this.myEmployeeId(tx));
        where.push(`r.employee_id = $${params.length}`);
      } else {
        where.push(await this.authz.predicate('leave:read', REQUEST_SCOPE, params, tx));
        if (q.employeeId) {
          params.push(q.employeeId);
          where.push(`r.employee_id = $${params.length}`);
        }
      }
      if (q.status) {
        params.push(q.status);
        where.push(`r.status = $${params.length}`);
      }
      if (q.from) {
        params.push(q.from);
        where.push(`r.end_date >= $${params.length}`);
      }
      if (q.to) {
        params.push(q.to);
        where.push(`r.start_date <= $${params.length}`);
      }
      params.push(q.limit);
      return many(tx, `select ${REQUEST_COLUMNS} ${REQUEST_FROM} where ${where.join(' and ')} order by r.start_date desc, r.created_at desc limit $${params.length}`, params);
    });
  }

  async getRequest(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one<{ employee_id: string }>(tx, 'select employee_id from leave_requests where id = $1', [id]);
      if (!r) throw Errors.notFound('Leave request');
      await this.authz.require('leave:read', this.attrsOf(await this.employee(tx, r.employee_id)), tx);
      return this.loadRequest(tx, id);
    });
  }

  private async loadRequest(tx: Tx, id: string) {
    const row = (await one<{ approvalId: string | null }>(tx, `select ${REQUEST_COLUMNS} ${REQUEST_FROM} where r.id = $1`, [id]))!;
    return { ...row, approvalTrail: row.approvalId ? await this.approvals.trail(tx, row.approvalId) : [] };
  }

  /** Who is away in a date range, for team calendars. Limited to records the caller can read. */
  async whoIsAway(from: string, to: string) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [from, to];
      const scope = await this.authz.predicate('leave:read', REQUEST_SCOPE, params, tx);
      return many(
        tx,
        `select ${REQUEST_COLUMNS} ${REQUEST_FROM} where r.status in ('approved', 'pending') and r.end_date >= $1 and r.start_date <= $2 and ${scope}
          order by r.start_date limit 500`,
        params,
      );
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // HR operations
  // ---------------------------------------------------------------------------------------------------------

  async adjust(input: z.infer<typeof leaveAdjustmentInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await this.employee(tx, input.employeeId);
      await this.authz.require('leave:approve', this.attrsOf(e), tx);
      const s = await this.authz.subject(tx);
      if (s.employeeId === e.id) throw Errors.forbidden('You cannot adjust your own leave balance');
      if (!(await one(tx, 'select 1 from leave_types where id = $1', [input.leaveTypeId]))) throw Errors.badRequest('invalid_leave_type', 'Leave type not found');
      const year = yearOf(today());
      await tx.query(
        `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, kind, quantity, effective_on, note, created_by)
         values (app_tenant_id(), $1, $2, $3, 'adjustment', $4, current_date, $5, $6)`,
        [e.id, input.leaveTypeId, year, input.quantity, input.note, actor.userId],
      );
      await this.audit.record(tx, { action: 'leave_balance.adjusted', resourceType: 'employee', resourceId: e.id, changes: { leaveTypeId: input.leaveTypeId, quantity: input.quantity, note: input.note } });
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'leave.adjusted', title: `Your leave balance was adjusted by ${input.quantity} days`, body: input.note, link: '/leave',
      });
      return { employeeId: e.id, year, balances: await this.balanceRows(tx, e, year) };
    });
  }

  /** Posts every accrual due up to asOf. Idempotent: each period is credited at most once per employee and type. */
  async runAccruals(tx: Tx, asOf: string, employeeId?: string): Promise<number> {
    const employees = await many<EmployeeLite>(
      tx,
      `select id, membership_id, status, date_of_joining, last_working_day, current_legal_entity_id as legal_entity_id, current_department_id as department_id,
              current_location_id as location_id, first_name as name
         from employees where date_of_joining <= $1 and (status <> 'exited' or last_working_day >= date_trunc('year', $1::date))
          and ($2::uuid is null or id = $2)`,
      [asOf, employeeId ?? null],
    );
    const types = await many<{ id: string }>(tx, 'select id from leave_types where archived_at is null');
    let posted = 0;
    for (const e of employees) {
      for (const t of types) {
        const p = await this.policyFor(tx, t.id, e.legal_entity_id);
        if (!p) continue;
        const credits = accrualsDue({ accrualMethod: p.accrual_method, annualEntitlement: toH(p.annual_entitlement), rounding: p.rounding },
          { dateOfJoining: e.date_of_joining, lastWorkingDay: e.last_working_day }, asOf);
        for (const c of credits) {
          const r = await tx.query(
            `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, kind, quantity, effective_on, accrual_key, note)
             values (app_tenant_id(), $1, $2, $3, 'accrual', $4, $5, $6, $7) on conflict do nothing`,
            [e.id, t.id, yearOf(c.effectiveOn), fromH(c.quantity), c.effectiveOn, c.key, `Accrual ${c.key.slice(1)}`],
          );
          posted += r.rowCount ?? 0;
        }
      }
    }
    return posted;
  }

  async runAccrualsNow(asOf = today()) {
    return this.db.tenant(async (tx) => {
      const posted = await this.runAccruals(tx, asOf);
      await this.audit.record(tx, { action: 'leave_accruals.run', resourceType: 'leave', metadata: { asOf, posted } });
      return { asOf, posted };
    });
  }

  /** Closes a leave year: carries balances forward up to each policy's cap and lapses the rest. Safe to re-run. */
  async closeYear(year: number) {
    if (year >= yearOf(today())) throw Errors.badRequest('year_open', 'Only a past leave year can be closed');
    return this.db.tenant(async (tx) => {
      const rows = await many<{ employee_id: string; leave_type_id: string; legal_entity_id: string | null; q: string }>(
        tx,
        `select l.employee_id, l.leave_type_id, e.current_legal_entity_id as legal_entity_id, sum(l.quantity)::text as q
           from leave_ledger l join employees e on e.id = l.employee_id where l.leave_year = $1 group by 1, 2, 3`,
        [year],
      );
      let carried = 0;
      let lapsed = 0;
      const ins = (r: (typeof rows)[number], leaveYear: number, kind: string, q: number, on: string, key: string, note: string) =>
        tx.query(
          `insert into leave_ledger (tenant_id, employee_id, leave_type_id, leave_year, kind, quantity, effective_on, accrual_key, note)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) on conflict do nothing`,
          [r.employee_id, r.leave_type_id, leaveYear, kind, fromH(q), on, key, note],
        );
      for (const r of rows) {
        const bal = toH(r.q);
        if (bal === 0) continue;
        const p = await this.policyFor(tx, r.leave_type_id, r.legal_entity_id);
        if (!p || p.accrual_method === 'none') continue;
        const { carry, lapse } = yearEnd(bal, toH(p.carry_forward_max));
        if (lapse) {
          await ins(r, year, 'lapse', -lapse, `${year}-12-31`, `L${year}`, `Lapsed at the end of ${year}`);
          lapsed++;
        }
        if (carry) {
          await ins(r, year, 'carry_forward', -carry, `${year}-12-31`, `CO${year}`, `Carried to ${year + 1}`);
          await ins(r, year + 1, 'carry_forward', carry, `${year + 1}-01-01`, `CI${year}`, `Carried from ${year}`);
          carried++;
        }
      }
      await this.audit.record(tx, { action: 'leave_year.closed', resourceType: 'leave', metadata: { year, carried, lapsed } });
      return { year, carried, lapsed };
    });
  }
}

function conflictOn(pgCode: string, code: string, message: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === pgCode) throw Errors.conflict(code, message);
    throw err;
  };
}

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
import { MongoService as DatabaseService, membershipUserNames, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { OutboxService } from '../../platform/events/outbox.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService, type ApprovalRequestRow } from '../approvals/approvals.service';
import { AttendanceService } from '../attendance/attendance.service';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { displayName, employeeNames, fieldById } from '../employees/employee-view';


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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

/** Leave policies as the API shows them, with the leave type and legal entity names. */
async function policyViews(tx: TenantTx, policies: Doc[]) {
  const types = new Map((await tx.collection('leave_types').find({ id: { $in: policies.map((p) => p.leave_type_id) } })).map((t) => [t.id as string, t]));
  const entities = await fieldById(tx, 'legal_entities', policies.map((p) => p.legal_entity_id));
  return policies
    .filter((p) => types.has(p.leave_type_id))
    .map((p) => {
      const t = types.get(p.leave_type_id)!;
      return {
        id: p.id,
        leaveTypeId: p.leave_type_id,
        leaveTypeName: t.name,
        leaveTypeCode: t.code,
        legalEntityId: p.legal_entity_id ?? null,
        legalEntityName: entities.get(p.legal_entity_id) ?? null,
        accrualMethod: p.accrual_method,
        annualEntitlement: p.annual_entitlement,
        carryForwardMax: p.carry_forward_max,
        allowNegativeBalance: p.allow_negative_balance,
        minNoticeDays: p.min_notice_days,
        maxConsecutiveDays: p.max_consecutive_days ?? null,
        availableDuringProbation: p.available_during_probation,
        rounding: p.rounding,
        createdAt: p.created_at,
        typeArchived: !!t.archived_at,
      };
    });
}

/** Leave requests as the API shows them (the PostgreSQL REQUEST_COLUMNS join). */
async function requestViews(tx: TenantTx, requests: Doc[]) {
  const people = await employeeNames(tx, requests.map((r) => r.employee_id));
  const types = new Map((await tx.collection('leave_types').find({ id: { $in: [...new Set(requests.map((r) => r.leave_type_id))] } })).map((t) => [t.id as string, t]));
  const requesters = await membershipUserNames(tx, requests.map((r) => r.requested_by_membership_id));
  return requests
    .filter((r) => people.has(r.employee_id) && types.has(r.leave_type_id))
    .map((r) => {
      const e = people.get(r.employee_id)!;
      const t = types.get(r.leave_type_id)!;
      return {
        id: r.id as string,
        employeeId: r.employee_id as string,
        employeeName: e.name,
        employeeCode: e.doc.employee_code as string,
        leaveTypeId: r.leave_type_id as string,
        leaveTypeName: t.name as string,
        leaveTypeCode: t.code as string,
        color: t.color as string,
        startDate: r.start_date as string,
        endDate: r.end_date as string,
        startHalf: r.start_half,
        endHalf: r.end_half,
        days: r.days as string,
        reason: r.reason ?? null,
        status: r.status as string,
        approvalId: (r.approval_request_id as string | null) ?? null,
        createdAt: r.created_at,
        decidedAt: r.decided_at ?? null,
        cancelledAt: r.cancelled_at ?? null,
        cancelReason: r.cancel_reason ?? null,
        requestedBy: requesters.get(r.requested_by_membership_id) ?? null,
      };
    });
}

/** Employee documents as the leave rules read them. */
function lite(e: Doc): EmployeeLite {
  return {
    id: e.id,
    membership_id: e.membership_id ?? null,
    status: e.status,
    date_of_joining: e.date_of_joining,
    last_working_day: e.last_working_day ?? null,
    legal_entity_id: e.current_legal_entity_id ?? null,
    department_id: e.current_department_id ?? null,
    location_id: e.current_location_id ?? null,
    name: displayName(e as never),
  };
}

const sumBy = <T>(rows: T[], value: (r: T) => unknown) => rows.reduce((t, r) => t + toH(String(value(r) ?? '0')), 0);
const typeView = (t: Doc) => ({ id: t.id, code: t.code, name: t.name, description: t.description ?? null, paid: t.paid, allowHalfDay: t.allow_half_day, color: t.color });

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
        const r = await tx.collection('leave_requests').findOne({ id });
        return this.attrsOf(await this.employee(tx, r!.employee_id));
      },
      onApproved: (tx, req) => this.onApproved(tx, req),
      onRejected: async (tx, req) => {
        await tx.collection('leave_requests').updateOne({ id: req.resource_id, status: 'pending' }, { $set: { status: 'rejected', decided_at: new Date() } });
        await this.audit.record(tx, { action: 'leave_request.rejected', resourceType: 'leave_request', resourceId: req.resource_id });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Types and policies
  // ---------------------------------------------------------------------------------------------------------

  listTypes(includeArchived = false) {
    return this.db.tenant(async (tx) =>
      (await tx.collection('leave_types').find(includeArchived ? {} : { archived_at: null }, { sort: { name: 1 } })).map((t) => ({ ...typeView(t), archivedAt: t.archived_at ?? null })),
    );
  }

  createType(input: z.infer<typeof leaveTypeInput>) {
    return this.db.tenant(async (tx) => {
      const row = await tx
        .collection('leave_types')
        .insert({ code: input.code, name: input.name, description: input.description ?? null, paid: input.paid, allow_half_day: input.allowHalfDay, color: input.color })
        .catch(conflictOn('23505', 'leave_type_exists', 'A leave type with this code already exists'));
      await this.audit.record(tx, { action: 'leave_type.created', resourceType: 'leave_type', resourceId: row!.id, changes: input });
      return { id: row!.id, ...input };
    });
  }

  updateType(id: string, input: Partial<z.infer<typeof leaveTypeInput>>) {
    return this.db.tenant(async (tx) => {
      const entries = Object.entries(input).filter(([k, v]) => v !== undefined && k in LEAVE_TYPE_COLUMNS);
      if (!(await tx.collection('leave_types').exists({ id }))) throw Errors.notFound('Leave type');
      if (entries.length) {
        await tx
          .collection('leave_types')
          .updateOne({ id }, { $set: Object.fromEntries(entries.map(([k, v]) => [LEAVE_TYPE_COLUMNS[k as keyof typeof LEAVE_TYPE_COLUMNS], v])) })
          .catch(conflictOn('23505', 'leave_type_exists', 'A leave type with this code already exists'));
        await this.audit.record(tx, { action: 'leave_type.updated', resourceType: 'leave_type', resourceId: id, changes: Object.fromEntries(entries) });
      }
      return typeView((await tx.collection('leave_types').findOne({ id }))!);
    });
  }

  archiveType(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('leave_types').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } }))) throw Errors.notFound('Leave type');
      await tx.collection('leave_policies').update({ leave_type_id: id, active: true }, { $set: { active: false } });
      await this.audit.record(tx, { action: 'leave_type.archived', resourceType: 'leave_type', resourceId: id });
    });
  }

  listPolicies() {
    return this.db.tenant(async (tx) => {
      const rows = (await policyViews(tx, await tx.collection('leave_policies').find({ active: true }))).filter((p) => !p.typeArchived);
      // By leave type, then the workspace-wide policy before entity ones.
      rows.sort((a, b) => cmp(a.leaveTypeName, b.leaveTypeName) || Number(a.legalEntityName !== null) - Number(b.legalEntityName !== null) || cmp(a.legalEntityName, b.legalEntityName));
      return rows.map(({ typeArchived: _t, ...p }) => p);
    });
  }

  /** Saving a policy for a type and entity replaces the active one; the old version is kept for history. */
  setPolicy(input: z.infer<typeof leavePolicyInput>) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('leave_types').exists({ id: input.leaveTypeId, archived_at: null }))) throw Errors.badRequest('invalid_leave_type', 'Leave type not found');
      if (input.legalEntityId && !(await tx.collection('legal_entities').exists({ id: input.legalEntityId, archived_at: null }))) {
        throw Errors.badRequest('invalid_legal_entity', 'Legal entity not found');
      }
      const prev = await tx.collection('leave_policies').updateAndGet({ active: true, leave_type_id: input.leaveTypeId, legal_entity_id: input.legalEntityId ?? null }, { $set: { active: false } });
      const row = await tx.collection('leave_policies').insert({
        leave_type_id: input.leaveTypeId,
        legal_entity_id: input.legalEntityId ?? null,
        accrual_method: input.accrualMethod,
        annual_entitlement: input.annualEntitlement,
        carry_forward_max: input.carryForwardMax,
        allow_negative_balance: input.allowNegativeBalance,
        min_notice_days: input.minNoticeDays,
        max_consecutive_days: input.maxConsecutiveDays ?? null,
        available_during_probation: input.availableDuringProbation,
        rounding: input.rounding,
      });
      await this.audit.record(tx, { action: 'leave_policy.saved', resourceType: 'leave_policy', resourceId: row.id, changes: input, metadata: { replaces: prev?.id ?? null } });
      const [view] = await policyViews(tx, [row]);
      const { typeArchived: _t, ...out } = view!;
      return out;
    });
  }

  removePolicy(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('leave_policies').updateOne({ id, active: true }, { $set: { active: false } }))) throw Errors.notFound('Leave policy');
      await this.audit.record(tx, { action: 'leave_policy.removed', resourceType: 'leave_policy', resourceId: id });
    });
  }

  private async policyFor(tx: TenantTx, leaveTypeId: string, legalEntityId: string | null): Promise<PolicyRow | undefined> {
    // The entity's own policy wins over the workspace-wide one.
    const rows = await tx.collection<PolicyRow>('leave_policies').find({ active: true, leave_type_id: leaveTypeId, legal_entity_id: { $in: [legalEntityId, null] } });
    return rows.find((p) => p.legal_entity_id !== null && p.legal_entity_id === legalEntityId) ?? rows.find((p) => p.legal_entity_id === null);
  }

  // ---------------------------------------------------------------------------------------------------------
  // Holiday calendars
  // ---------------------------------------------------------------------------------------------------------

  listCalendars() {
    return this.db.tenant(async (tx) => {
      const calendars = await tx.collection('holiday_calendars').find({}, { sort: { is_default: -1, name: 1 } });
      const entities = await fieldById(tx, 'legal_entities', calendars.map((c) => c.legal_entity_id));
      const locations = await fieldById(tx, 'locations', calendars.map((c) => c.location_id));
      const holidays = await tx.collection('holidays').find({ calendar_id: { $in: calendars.map((c) => c.id) } }, { sort: { holiday_date: 1 } });
      return calendars.map((c) => ({
        id: c.id,
        name: c.name,
        legalEntityId: c.legal_entity_id ?? null,
        legalEntityName: entities.get(c.legal_entity_id) ?? null,
        locationId: c.location_id ?? null,
        locationName: locations.get(c.location_id) ?? null,
        isDefault: c.is_default,
        weeklyOffs: c.weekly_offs,
        holidays: holidays.filter((h) => h.calendar_id === c.id).map((h) => ({ id: h.id, date: h.holiday_date, name: h.name, isOptional: h.is_optional })),
      }));
    });
  }

  saveCalendar(id: string | null, input: z.infer<typeof holidayCalendarInput>) {
    return this.db.tenant(async (tx) => {
      if (input.isDefault) await tx.collection('holiday_calendars').update({ is_default: true, ...(id ? { id: { $ne: id } } : {}) }, { $set: { is_default: false } });
      const offs = [...new Set(input.weeklyOffs)].sort();
      let calendarId = id;
      if (id) {
        const values = { name: input.name, legal_entity_id: input.legalEntityId ?? null, location_id: input.locationId ?? null, is_default: input.isDefault, weekly_offs: offs };
        if (!(await tx.collection('holiday_calendars').updateOne({ id }, { $set: values }))) throw Errors.notFound('Holiday calendar');
      } else {
        calendarId = (
          await tx.collection('holiday_calendars').insert({ name: input.name, legal_entity_id: input.legalEntityId ?? null, location_id: input.locationId ?? null, is_default: input.isDefault, weekly_offs: offs })
        ).id as string;
      }
      await this.audit.record(tx, { action: id ? 'holiday_calendar.updated' : 'holiday_calendar.created', resourceType: 'holiday_calendar', resourceId: calendarId, changes: input });
      return { id: calendarId, ...input, weeklyOffs: offs };
    });
  }

  deleteCalendar(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('holiday_calendars').deleteOne({ id }))) throw Errors.notFound('Holiday calendar');
      await this.audit.record(tx, { action: 'holiday_calendar.deleted', resourceType: 'holiday_calendar', resourceId: id });
    });
  }

  addHoliday(calendarId: string, input: z.infer<typeof holidayInput>) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('holiday_calendars').exists({ id: calendarId }))) throw Errors.notFound('Holiday calendar');
      const row = await tx
        .collection('holidays')
        .insert({ calendar_id: calendarId, holiday_date: input.date, name: input.name, is_optional: input.isOptional })
        .catch(conflictOn('23505', 'holiday_exists', 'This calendar already has a holiday on that date'));
      await this.audit.record(tx, { action: 'holiday.added', resourceType: 'holiday_calendar', resourceId: calendarId, changes: input });
      return { id: row!.id, ...input };
    });
  }

  removeHoliday(calendarId: string, holidayId: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('holidays').deleteOne({ id: holidayId, calendar_id: calendarId }))) throw Errors.notFound('Holiday');
      await this.audit.record(tx, { action: 'holiday.removed', resourceType: 'holiday_calendar', resourceId: calendarId, metadata: { holidayId } });
    });
  }

  /** The calendar for an employee: their location's, else their legal entity's, else the workspace default. */
  private async calendarFor(tx: TenantTx, e: Pick<EmployeeLite, 'legal_entity_id' | 'location_id'>): Promise<WorkCalendar & { id: string | null }> {
    const calendars = await tx.collection('holiday_calendars').find({
      $or: [...(e.location_id ? [{ location_id: e.location_id }] : []), ...(e.legal_entity_id ? [{ location_id: null, legal_entity_id: e.legal_entity_id }] : []), { is_default: true }],
    });
    const cal =
      calendars.find((c) => e.location_id && c.location_id === e.location_id) ??
      calendars.find((c) => !c.location_id && e.legal_entity_id && c.legal_entity_id === e.legal_entity_id) ??
      calendars.find((c) => c.is_default);
    if (!cal) return { id: null, weeklyOffs: [0, 6], holidays: new Set() };
    const hs = await tx.collection('holidays').find({ calendar_id: cal.id, is_optional: false }, { projection: { holiday_date: 1 } });
    return { id: cal.id, weeklyOffs: (cal.weekly_offs as number[]).map(Number), holidays: new Set(hs.map((h) => h.holiday_date as string)) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Balances
  // ---------------------------------------------------------------------------------------------------------

  private async employee(tx: TenantTx, id: string): Promise<EmployeeLite> {
    const e = await tx.collection('employees').findOne({ id });
    if (!e) throw Errors.notFound('Employee');
    return lite(e);
  }

  private attrsOf(e: EmployeeLite): ResourceAttributes {
    return employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });
  }

  /** The caller's employee id, or a clear error when their login is not linked to an employee record. */
  private async myEmployeeId(tx: TenantTx): Promise<string> {
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

  private async balanceRows(tx: TenantTx, e: EmployeeLite, year: number) {
    const types = await tx.collection('leave_types').find({ archived_at: null }, { sort: { name: 1 } });
    const ledger = await tx.collection('leave_ledger').find({ employee_id: e.id, leave_year: year }, { projection: { leave_type_id: 1, kind: 1, quantity: 1 } });
    const open = await tx.collection('leave_requests').find({ employee_id: e.id, status: 'pending', start_date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }, { projection: { leave_type_id: 1, days: 1 } });
    const out = [];
    for (const t of types) {
      const policy = await this.policyFor(tx, t.id, e.legal_entity_id);
      if (!policy) continue;
      const k = (kind: string) => sumBy(ledger.filter((l) => l.leave_type_id === t.id && l.kind === kind), (l) => l.quantity);
      const accrued = k('accrual');
      const carried = k('carry_forward');
      const adjusted = k('adjustment');
      const taken = -(k('taken') + k('reversal'));
      const lapsed = -k('lapse');
      const balance = accrued + carried + adjusted - taken - lapsed;
      const pend = sumBy(open.filter((p) => p.leave_type_id === t.id), (p) => p.days);
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
      const lines = (await tx.collection('leave_ledger').find({ employee_id: employeeId, leave_type_id: leaveTypeId, leave_year: year })).sort(
        (a, b) => cmp(a.effective_on, b.effective_on) || a.created_at - b.created_at,
      );
      const users = await (await usersTable(tx)).find({ id: { $in: [...new Set(lines.map((l) => l.created_by).filter(Boolean))] } }, { projection: { full_name: 1 } });
      const by = new Map(users.map((u) => [u.id, u.full_name ?? null]));
      return lines.map((l) => ({
        id: l.id,
        kind: l.kind,
        quantity: l.quantity,
        effectiveOn: l.effective_on,
        note: l.note ?? null,
        leaveRequestId: l.leave_request_id ?? null,
        createdAt: l.created_at,
        by: by.get(l.created_by) ?? null,
      }));
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

  private async requestTarget(tx: TenantTx, employeeId: string | undefined) {
    const mine = (await this.authz.subject(tx)).employeeId;
    const id = employeeId ?? (await this.myEmployeeId(tx));
    const e = await this.employee(tx, id);
    const onBehalf = id !== mine;
    // Filing for someone else needs approval rights over them (a manager for their team, HR for their scope).
    await this.authz.require(onBehalf ? 'leave:approve' : 'leave:request', this.attrsOf(e), tx);
    return { e, onBehalf };
  }

  private async evaluate(tx: TenantTx, e: EmployeeLite, input: LeaveRequestInput, onBehalf: boolean) {
    const type = await tx.collection<{ id: string; name: string; allow_half_day: boolean }>('leave_types').findOne({ id: input.leaveTypeId, archived_at: null });
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
      // One request at a time per person, so the overlap and balance checks see every other request.
      await tx.collection('employees').lock({ id: e.id });
      const preview = await this.evaluate(tx, e, input, onBehalf);
      const type = (await tx.collection('leave_types').findOne({ id: input.leaveTypeId }))!;
      // No two pending or approved requests of one person overlap (an exclusion constraint in PostgreSQL).
      if (await tx.collection('leave_requests').exists({ employee_id: e.id, status: { $in: ['pending', 'approved'] }, start_date: { $lte: input.endDate }, end_date: { $gte: input.startDate } })) {
        throw Errors.conflict('overlapping_leave', 'There is already a pending or approved request on these dates');
      }
      const row = await tx.collection('leave_requests').insert({
        employee_id: e.id,
        leave_type_id: input.leaveTypeId,
        start_date: input.startDate,
        end_date: input.endDate,
        start_half: input.startHalf,
        end_half: input.endHalf,
        days: preview.days,
        reason: input.reason ?? null,
        requested_by_membership_id: actor.membershipId,
      });
      const range = input.startDate === input.endDate ? input.startDate : `${input.startDate} to ${input.endDate}`;
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'leave_request', resourceId: row.id, subjectEmployeeId: e.id,
        summary: `${e.name}: ${type.name}, ${range} (${preview.days} days)${input.reason ? `. "${input.reason}"` : ''}`,
      });
      await tx.collection('leave_requests').updateOne({ id: row.id }, { $set: { approval_request_id: approvalId } });
      await this.audit.record(tx, {
        action: 'leave_request.submitted', resourceType: 'leave_request', resourceId: row.id,
        changes: { employeeId: e.id, leaveTypeId: input.leaveTypeId, startDate: input.startDate, endDate: input.endDate, days: preview.days },
        metadata: { onBehalf },
      });
      await this.outbox.publish(tx, actor.tenantId, 'leave.requested', { leaveRequestId: row.id, employeeId: e.id });
      return this.loadRequest(tx, row.id);
    });
  }

  private async onApproved(tx: TenantTx, req: ApprovalRequestRow) {
    // The status check is part of the write, so a cancellation made meanwhile is not overwritten.
    const r = await tx.collection<RequestRow>('leave_requests').findOne({ id: req.resource_id });
    if (!r || !(await tx.collection('leave_requests').updateOne({ id: r.id, status: 'pending' }, { $set: { status: 'approved', decided_at: new Date() } }))) return;
    await tx.collection('leave_ledger').insert({
      employee_id: r.employee_id,
      leave_type_id: r.leave_type_id,
      leave_year: yearOf(r.start_date),
      kind: 'taken',
      quantity: fromH(-toH(r.days)),
      effective_on: r.start_date,
      leave_request_id: r.id,
      created_by: requestContext.tenantActor().userId,
    });
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
      const r = await tx.collection<RequestRow>('leave_requests').findOne({ id });
      if (!r) throw Errors.notFound('Leave request');
      await tx.collection('leave_requests').lock({ id });
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
      if (!(await tx.collection('leave_requests').updateOne({ id, status: r.status }, { $set: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason ?? null } }))) {
        throw Errors.conflict('invalid_state', 'This request changed meanwhile. Refresh and try again.');
      }
      if (r.status === 'pending' && r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      if (r.status === 'approved') {
        await tx.collection('leave_ledger').insert({
          employee_id: r.employee_id,
          leave_type_id: r.leave_type_id,
          leave_year: yearOf(r.start_date),
          kind: 'reversal',
          quantity: r.days,
          effective_on: r.start_date,
          leave_request_id: id,
          note: reason ?? 'Cancelled',
          created_by: actor.userId,
        });
      }
      if (r.status === 'approved') await this.attendance.recomputeFor(tx, r.employee_id, r.start_date, r.end_date);
      await this.audit.record(tx, { action: 'leave_request.cancelled', resourceType: 'leave_request', resourceId: id, metadata: { from: r.status, reason: reason ?? null } });
      if (!isOwner || r.status === 'approved') {
        const approvers = r.approval_request_id
          ? (await tx.collection('approval_steps').find({ request_id: r.approval_request_id })).map((x) => (x.decided_by_membership_id ?? x.approver_membership_id ?? null) as string | null)
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
      const and: Record<string, unknown>[] = [];
      if (q.scope === 'mine' || (!q.employeeId && q.scope !== 'visible')) {
        and.push({ employee_id: await this.myEmployeeId(tx) });
      } else {
        and.push({ employee_id: { $in: await this.visibleEmployeeIds(tx, 'leave:read') } });
        if (q.employeeId) and.push({ employee_id: q.employeeId });
      }
      if (q.status) and.push({ status: q.status });
      if (q.from) and.push({ end_date: { $gte: q.from } });
      if (q.to) and.push({ start_date: { $lte: q.to } });
      const rows = await tx.collection('leave_requests').find({ $and: and }, { sort: { start_date: -1, created_at: -1 }, limit: q.limit });
      return requestViews(tx, rows);
    });
  }

  /** Ids of the employees whose records the caller may see for a permission (the scope of a list). */
  private async visibleEmployeeIds(tx: TenantTx, permission: string): Promise<string[]> {
    const scope = await this.authz.filter(permission, EMPLOYEE_FIELDS, tx);
    return (await tx.collection('employees').find(scope, { projection: { _id: 1 } })).map((e) => e.id as string);
  }

  async getRequest(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('leave_requests').findOne({ id });
      if (!r) throw Errors.notFound('Leave request');
      await this.authz.require('leave:read', this.attrsOf(await this.employee(tx, r.employee_id)), tx);
      return this.loadRequest(tx, id);
    });
  }

  private async loadRequest(tx: TenantTx, id: string) {
    const row = (await requestViews(tx, [(await tx.collection('leave_requests').findOne({ id }))!]))[0]!;
    return { ...row, approvalTrail: row.approvalId ? await this.approvals.trail(tx, row.approvalId) : [] };
  }

  /** Who is away in a date range, for team calendars. Limited to records the caller can read. */
  async whoIsAway(from: string, to: string) {
    return this.db.tenant(async (tx) => {
      const rows = await tx.collection('leave_requests').find(
        { status: { $in: ['approved', 'pending'] }, end_date: { $gte: from }, start_date: { $lte: to }, employee_id: { $in: await this.visibleEmployeeIds(tx, 'leave:read') } },
        { sort: { start_date: 1 }, limit: 500 },
      );
      return requestViews(tx, rows);
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
      if (!(await tx.collection('leave_types').exists({ id: input.leaveTypeId }))) throw Errors.badRequest('invalid_leave_type', 'Leave type not found');
      const year = yearOf(today());
      await tx.collection('leave_ledger').insert({
        employee_id: e.id,
        leave_type_id: input.leaveTypeId,
        leave_year: year,
        kind: 'adjustment',
        quantity: input.quantity,
        effective_on: today(),
        note: input.note,
        created_by: actor.userId,
      });
      await this.audit.record(tx, { action: 'leave_balance.adjusted', resourceType: 'employee', resourceId: e.id, changes: { leaveTypeId: input.leaveTypeId, quantity: input.quantity, note: input.note } });
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'leave.adjusted', title: `Your leave balance was adjusted by ${input.quantity} days`, body: input.note, link: '/leave',
      });
      return { employeeId: e.id, year, balances: await this.balanceRows(tx, e, year) };
    });
  }

  /** Posts every accrual due up to asOf. Idempotent: each period is credited at most once per employee and type. */
  async runAccruals(tx: TenantTx, asOf: string, employeeId?: string): Promise<number> {
    const yearStart = `${asOf.slice(0, 4)}-01-01`;
    const employees = (
      await tx.collection('employees').find({
        date_of_joining: { $lte: asOf },
        $or: [{ status: { $ne: 'exited' } }, { last_working_day: { $gte: yearStart } }],
        ...(employeeId ? { id: employeeId } : {}),
      })
    ).map(lite);
    const types = await tx.collection('leave_types').find({ archived_at: null }, { projection: { _id: 1 } });
    // Credits already posted, so each period is credited once (the accrual_key unique index enforces it too).
    const posted_ = new Set(
      (await tx.collection('leave_ledger').find({ employee_id: { $in: employees.map((e) => e.id) }, accrual_key: { $ne: null } }, { projection: { employee_id: 1, leave_type_id: 1, accrual_key: 1 } })).map(
        (l) => `${l.employee_id}|${l.leave_type_id}|${l.accrual_key}`,
      ),
    );
    let posted = 0;
    for (const e of employees) {
      for (const t of types) {
        const p = await this.policyFor(tx, t.id, e.legal_entity_id);
        if (!p) continue;
        const credits = accrualsDue({ accrualMethod: p.accrual_method, annualEntitlement: toH(p.annual_entitlement), rounding: p.rounding },
          { dateOfJoining: e.date_of_joining, lastWorkingDay: e.last_working_day }, asOf);
        for (const c of credits) {
          if (posted_.has(`${e.id}|${t.id}|${c.key}`)) continue;
          await tx.collection('leave_ledger').insert({
            employee_id: e.id,
            leave_type_id: t.id,
            leave_year: yearOf(c.effectiveOn),
            kind: 'accrual',
            quantity: fromH(c.quantity),
            effective_on: c.effectiveOn,
            accrual_key: c.key,
            note: `Accrual ${c.key.slice(1)}`,
          });
          posted++;
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
      const lines = await tx.collection('leave_ledger').find({ leave_year: year }, { projection: { employee_id: 1, leave_type_id: 1, quantity: 1 } });
      const keyed = new Map<string, { employee_id: string; leave_type_id: string; q: number }>();
      for (const l of lines) {
        const k = `${l.employee_id}|${l.leave_type_id}`;
        const cur = keyed.get(k) ?? { employee_id: l.employee_id, leave_type_id: l.leave_type_id, q: 0 };
        cur.q += toH(l.quantity);
        keyed.set(k, cur);
      }
      const entityOf = new Map((await tx.collection('employees').find({ id: { $in: [...new Set(lines.map((l) => l.employee_id))] } }, { projection: { current_legal_entity_id: 1 } })).map((e) => [e.id as string, (e.current_legal_entity_id as string | null) ?? null]));
      const rows = [...keyed.values()].filter((r) => entityOf.has(r.employee_id)).map((r) => ({ ...r, legal_entity_id: entityOf.get(r.employee_id)! }));
      const done = new Set(
        (await tx.collection('leave_ledger').find({ accrual_key: { $in: [`L${year}`, `CO${year}`, `CI${year}`] } }, { projection: { employee_id: 1, leave_type_id: 1, accrual_key: 1 } })).map(
          (l) => `${l.employee_id}|${l.leave_type_id}|${l.accrual_key}`,
        ),
      );
      let carried = 0;
      let lapsed = 0;
      // Each closing line has its own key, so running the close again adds nothing.
      const ins = async (r: (typeof rows)[number], leaveYear: number, kind: string, q: number, on: string, key: string, note: string) => {
        if (done.has(`${r.employee_id}|${r.leave_type_id}|${key}`)) return;
        await tx.collection('leave_ledger').insert({ employee_id: r.employee_id, leave_type_id: r.leave_type_id, leave_year: leaveYear, kind, quantity: fromH(q), effective_on: on, accrual_key: key, note });
      };
      for (const r of rows) {
        const bal = r.q;
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

function cmp(a: unknown, b: unknown): number {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

function conflictOn(pgCode: string, code: string, message: string) {
  return (err: unknown): never => {
    if ((err as { code?: string }).code === pgCode) throw Errors.conflict(code, message);
    throw err;
  };
}

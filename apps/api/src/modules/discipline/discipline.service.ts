import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  deductionText,
  isSameDayLeave,
  type LatePolicyInput,
  latePolicyInput,
  type LateTier,
  reminderText,
  type SameDayLeavePolicyInput,
  sameDayLeavePolicyInput,
  tierFor,
  zonedTime,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { AttendanceDaysService, type ComputedDay, type EmployeeCtx, isLocked } from '../attendance/attendance-days.service';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { employeeNames } from '../employees/employee-view';

const { addDays, fmtHhmm, localToday, toLocal } = zonedTime;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

export interface DisciplinePolicy {
  late: LatePolicyInput;
  sameDayLeave: SameDayLeavePolicyInput;
  /** First date automatic reminders may be sent for (the day they were switched on). */
  lateSince: string | null;
  updatedAt: Date | null;
}

/** Until a workspace saves its own rules: nothing is reminded or deducted. */
export const DEFAULT_DISCIPLINE: DisciplinePolicy = {
  late: latePolicyInput.parse({ enabled: false }),
  sameDayLeave: sameDayLeavePolicyInput.parse({ enabled: false }),
  lateSince: null,
  updatedAt: null,
};

/** Automatic reminders are sent only for today and the two days before, so a recompute of old days never sends any. */
const AUTO_LOOKBACK_DAYS = 2;

const attrsOf = (e: EmployeeCtx) =>
  employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });
const monthOf = (date: string) => date.slice(0, 7);
const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const actorMembership = () => {
  const a = requestContext.get()?.actor;
  return a?.kind === 'user' ? (a as { membershipId?: string }).membershipId ?? null : null;
};
const penaltyLabel = (p: Doc) =>
  p.kind === 'late_coming' ? `Late-coming deduction (${p.reminder_count ?? p.tier_reminders} reminders)` : `Same-day leave penalty${p.work_date ? ` (${p.work_date})` : ''}`;

/**
 * Late-coming reminders and attendance penalties. Reminders are sent from attendance (automatically, when a day is
 * computed as late) or by a manager or HR; the month's reminders decide the late-coming deduction. Same-day leave
 * gets a penalty in days of pay, automatically by the workspace rules or by the approving manager. Payroll deducts
 * the active penalties of the month (see penaltiesForPayroll).
 */
@Injectable()
export class DisciplineService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly days: AttendanceDaysService,
  ) {}

  onModuleInit() {
    this.days.onComputed((tx, e, day) => this.onDayComputed(tx, e, day));
  }

  // ---------------------------------------------------------------------------------------------------------
  // Policy
  // ---------------------------------------------------------------------------------------------------------

  async policyIn(tx: TenantTx): Promise<DisciplinePolicy> {
    const row = await tx.collection('discipline_policies').findOne({ key: 'workspace' });
    if (!row) return DEFAULT_DISCIPLINE;
    return {
      late: latePolicyInput.parse(row.late),
      sameDayLeave: sameDayLeavePolicyInput.parse(row.same_day_leave),
      lateSince: row.late_since ?? null,
      updatedAt: row.updated_at ?? null,
    };
  }

  async policy() {
    return this.db.tenant(async (tx) => this.policyView(tx, await this.policyIn(tx)));
  }

  private async policyView(tx: TenantTx, p: DisciplinePolicy) {
    const types = p.sameDayLeave.exemptLeaveTypeIds.length
      ? await tx.collection('leave_types').find({ id: { $in: p.sameDayLeave.exemptLeaveTypeIds } }, { projection: { name: 1 } })
      : [];
    return { ...p, exemptLeaveTypes: types.map((t) => ({ id: t.id as string, name: t.name as string })) };
  }

  private async save(tx: TenantTx, patch: { late?: LatePolicyInput; same_day_leave?: SameDayLeavePolicyInput; late_since?: string | null }) {
    const current = await this.policyIn(tx);
    const row = { late: current.late, same_day_leave: current.sameDayLeave, late_since: current.lateSince, ...patch, updated_by_membership_id: actorMembership() };
    await tx.collection('discipline_policies').upsert({ key: 'workspace' }, { key: 'workspace', ...row }, { $set: row });
    return current;
  }

  async saveLatePolicy(input: LatePolicyInput) {
    return this.db.tenant(async (tx) => {
      const tenant = await tx.collection('tenants').findOne({});
      const before = await this.policyIn(tx);
      // Automatic reminders start from the day they are switched on, never for days before it.
      const switchedOn = input.enabled && input.autoReminders && !(before.late.enabled && before.late.autoReminders);
      const since = switchedOn ? localToday(tenant?.timezone ?? 'UTC') : before.lateSince;
      await this.save(tx, { late: input, late_since: since });
      await this.audit.record(tx, { action: 'discipline.late_policy_updated', resourceType: 'discipline_policy', resourceId: 'workspace', changes: { before: before.late, after: input } });
      return this.policyView(tx, await this.policyIn(tx));
    });
  }

  async saveSameDayPolicy(input: SameDayLeavePolicyInput) {
    return this.db.tenant(async (tx) => {
      if (input.exemptLeaveTypeIds.length) {
        const found = await tx.collection('leave_types').count({ id: { $in: input.exemptLeaveTypeIds } });
        if (found !== new Set(input.exemptLeaveTypeIds).size) throw Errors.badRequest('invalid_leave_type', 'One of the exempt leave types was not found');
      }
      const before = await this.save(tx, { same_day_leave: input });
      await this.audit.record(tx, { action: 'discipline.same_day_policy_updated', resourceType: 'discipline_policy', resourceId: 'workspace', changes: { before: before.sameDayLeave, after: input } });
      return this.policyView(tx, await this.policyIn(tx));
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Late reminders
  // ---------------------------------------------------------------------------------------------------------

  /** Called for every computed attendance day: sends the automatic reminder, or withdraws it after a correction. */
  private async onDayComputed(tx: TenantTx, e: EmployeeCtx, day: ComputedDay) {
    const p = await this.policyIn(tx);
    if (!p.late.enabled) return;
    const late = day.result.flags.includes('late') && day.result.lateMinutes >= p.late.minLateMinutes;
    const reminders = tx.collection('late_reminders');
    const live = await reminders.findOne({ employee_id: e.id, work_date: day.workDate, status: 'sent' });
    if (!late) {
      // A correction (or approved half-day leave) can show the person was on time: an automatic reminder goes away.
      if (live && live.source === 'auto') {
        await reminders.updateOne({ id: live.id, status: 'sent' }, {
          $set: { status: 'withdrawn', withdrawn_at: new Date(), withdrawn_reason: 'Attendance no longer shows a late arrival on this day.' },
        });
        await this.audit.record(tx, { action: 'late_reminder.withdrawn', resourceType: 'late_reminder', resourceId: live.id, metadata: { automatic: true, workDate: day.workDate } });
        await this.notifications.notify(tx, {
          membershipIds: [e.membership_id], kind: 'attendance.late_reminder_withdrawn', title: `Late reminder for ${day.workDate} withdrawn`,
          body: 'Your attendance for that day no longer shows a late arrival, so the reminder no longer counts.', link: '/attendance',
        });
        await this.syncLatePenalty(tx, e, monthOf(day.workDate), p);
      }
      return;
    }
    if (live || !p.late.autoReminders) return;
    const today = localToday(e.tz, day.now);
    if (day.workDate < addDays(today, -AUTO_LOOKBACK_DAYS) || (p.lateSince && day.workDate < p.lateSince)) return;
    await this.sendReminder(tx, e, day.workDate, { source: 'auto', lateMinutes: day.result.lateMinutes, firstIn: day.result.firstIn, shiftStart: day.shift?.start_time ?? null, note: null }, p);
  }

  private async sendReminder(
    tx: TenantTx,
    e: EmployeeCtx,
    workDate: string,
    r: { source: 'auto' | 'manual'; lateMinutes: number; firstIn: number | null; shiftStart: string | null; note: string | null },
    p: DisciplinePolicy,
  ) {
    const month = monthOf(workDate);
    const reminders = tx.collection('late_reminders');
    const count = (await reminders.count({ employee_id: e.id, month, status: 'sent' })) + 1;
    const row = await reminders.insert({
      employee_id: e.id, work_date: workDate, month, source: r.source, late_minutes: r.lateMinutes, first_in: r.firstIn ? new Date(r.firstIn) : null,
      note: r.note, sequence: count, sent_by_membership_id: r.source === 'manual' ? actorMembership() : null, emailed: p.late.email && Boolean(e.membership_id),
    });
    const body = reminderText({
      workDate, lateMinutes: r.lateMinutes || null, firstIn: r.firstIn ? fmtHhmm(toLocal(r.firstIn, e.tz).minutes) : null, shiftStart: r.shiftStart ? r.shiftStart.slice(0, 5) : null,
      note: r.note, count, tiers: p.late.tiers, manual: r.source === 'manual',
    });
    await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'attendance.late_reminder', title: `Late arrival reminder: ${workDate}`, body, link: '/attendance', email: p.late.email });
    if (p.late.notifyManager) {
      const emp = await tx.collection('employees').findOne({ id: e.id }, { projection: { current_manager_employee_id: 1 } });
      const mgr = emp?.current_manager_employee_id ? await tx.collection('employees').findOne({ id: emp.current_manager_employee_id }, { projection: { membership_id: 1 } }) : undefined;
      const by = actorMembership();
      if (mgr?.membership_id && mgr.membership_id !== by) {
        await this.notifications.notify(tx, {
          membershipIds: [mgr.membership_id], kind: 'attendance.late_reminder_team', title: `${e.name} arrived late on ${workDate}`,
          body: `Late reminder ${count} this month${r.lateMinutes ? ` (${r.lateMinutes} minutes late)` : ''}.`, link: `/attendance/late?month=${month}`,
        });
      }
    }
    await this.audit.record(tx, {
      action: 'late_reminder.sent', resourceType: 'late_reminder', resourceId: row.id as string,
      changes: { employeeId: e.id, workDate, source: r.source, sequence: count, lateMinutes: r.lateMinutes }, metadata: { email: p.late.email },
    });
    await this.syncLatePenalty(tx, e, month, p);
    return row;
  }

  /** A manager or HR reminds someone they can approve attendance for about a late arrival. */
  async remind(input: { employeeId: string; workDate: string; note?: string }) {
    return this.db.tenant(async (tx) => {
      const e = await this.days.employee(tx, input.employeeId);
      if (!e) throw Errors.notFound('Employee');
      await this.authz.require('attendance:read', attrsOf(e), tx);
      await this.authz.require('attendance:approve', attrsOf(e), tx);
      if ((await this.authz.subject(tx)).employeeId === e.id) throw Errors.forbidden('You cannot send a late reminder to yourself');
      const p = await this.policyIn(tx);
      if (!p.late.enabled) throw Errors.conflict('late_reminders_off', 'Late-coming reminders are switched off. Turn them on in Settings, Attendance.');
      if (input.workDate > localToday(e.tz)) throw Errors.badRequest('future_date', 'That day has not happened yet.');
      if (input.workDate < e.date_of_joining) throw Errors.badRequest('before_joining', 'That date is before the joining date.');
      if (await isLocked(tx, e.id, input.workDate)) throw Errors.conflict('period_locked', 'This date is in a period locked for payroll.');
      await tx.collection('employees').lock({ id: e.id });
      if (await tx.collection('late_reminders').exists({ employee_id: e.id, work_date: input.workDate, status: 'sent' })) {
        throw Errors.conflict('already_reminded', 'A reminder was already sent for this day.');
      }
      let day = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: input.workDate });
      if (!day) {
        await this.days.recompute(tx, e.id, input.workDate, input.workDate);
        day = await tx.collection('attendance_days').findOne({ employee_id: e.id, work_date: input.workDate });
        // Computing the day may itself have sent the automatic reminder.
        const auto = await tx.collection('late_reminders').findOne({ employee_id: e.id, work_date: input.workDate, status: 'sent' });
        if (auto) return this.reminderView(tx, auto);
      }
      const lateMinutes = Number(day?.late_minutes ?? 0);
      if (!lateMinutes && !input.note) throw Errors.badRequest('not_late', 'Attendance does not show a late arrival on this day. Add a note to explain the reminder.');
      const shift = day?.shift_template_id ? await tx.collection('shift_templates').findOne({ id: day.shift_template_id }, { projection: { start_time: 1 } }) : undefined;
      const row = await this.sendReminder(tx, e, input.workDate, {
        source: 'manual', lateMinutes, firstIn: day?.first_in ? new Date(day.first_in).getTime() : null, shiftStart: shift?.start_time ?? null, note: input.note ?? null,
      }, p);
      return this.reminderView(tx, row);
    });
  }

  async withdrawReminder(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('late_reminders').findOne({ id });
      if (!r) throw Errors.notFound('Late reminder');
      const e = (await this.days.employee(tx, r.employee_id))!;
      await this.authz.require('attendance:read', attrsOf(e), tx);
      await this.authz.require('attendance:approve', attrsOf(e), tx);
      if ((await this.authz.subject(tx)).employeeId === e.id) throw Errors.forbidden('You cannot withdraw your own reminder');
      if (r.status !== 'sent') throw Errors.conflict('invalid_state', 'This reminder was already withdrawn.');
      if (await isLocked(tx, e.id, r.work_date)) throw Errors.conflict('period_locked', 'This date is in a period locked for payroll.');
      await tx.collection('late_reminders').updateOne({ id, status: 'sent' }, { $set: { status: 'withdrawn', withdrawn_at: new Date(), withdrawn_reason: reason, withdrawn_by_membership_id: actorMembership() } });
      await this.audit.record(tx, { action: 'late_reminder.withdrawn', resourceType: 'late_reminder', resourceId: id, metadata: { reason, workDate: r.work_date } });
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'attendance.late_reminder_withdrawn', title: `Late reminder for ${r.work_date} withdrawn`, body: reason, link: '/attendance',
      });
      await this.syncLatePenalty(tx, e, r.month, await this.policyIn(tx));
      return this.reminderView(tx, (await tx.collection('late_reminders').findOne({ id }))!);
    });
  }

  private async reminderView(tx: TenantTx, r: Doc) {
    const names = await membershipUserNames(tx, [r.sent_by_membership_id, r.withdrawn_by_membership_id]);
    return {
      id: r.id as string, employeeId: r.employee_id as string, workDate: r.work_date as string, month: r.month as string, source: r.source as string,
      sequence: r.sequence as number, lateMinutes: r.late_minutes as number, firstIn: r.first_in ?? null, note: r.note ?? null, status: r.status as string,
      emailed: Boolean(r.emailed), sentBy: names.get(r.sent_by_membership_id) ?? null, createdAt: r.created_at,
      withdrawnAt: r.withdrawn_at ?? null, withdrawnReason: r.withdrawn_reason ?? null, withdrawnBy: names.get(r.withdrawn_by_membership_id) ?? null,
    };
  }

  /**
   * Brings the month's late-coming deduction in line with its live reminders: the highest tier reached applies. A
   * waived deduction stays waived until a higher tier is reached.
   */
  private async syncLatePenalty(tx: TenantTx, e: EmployeeCtx, month: string, p: DisciplinePolicy) {
    const penalties = tx.collection('attendance_penalties');
    const count = await tx.collection('late_reminders').count({ employee_id: e.id, month, status: 'sent' });
    const tier: LateTier | null = tierFor(count, p.late.tiers);
    const existing = await penalties.findOne({ employee_id: e.id, month, kind: 'late_coming' });
    if (!tier) {
      if (existing?.status === 'active') {
        await penalties.updateOne({ id: existing.id }, { $set: { status: 'cancelled', status_reason: 'Fewer late reminders than the first deduction tier.', reminder_count: count } });
        await this.audit.record(tx, { action: 'attendance_penalty.cancelled', resourceType: 'attendance_penalty', resourceId: existing.id, metadata: { reminders: count } });
        await this.notifications.notify(tx, { membershipIds: [e.membership_id], kind: 'attendance.penalty_cancelled', title: `Late-coming deduction for ${month} removed`, body: `You now have ${count} late reminder(s) this month, fewer than the first deduction tier.`, link: '/attendance' });
      } else if (existing) await penalties.updateOne({ id: existing.id }, { $set: { reminder_count: count } });
      return;
    }
    const values = { basis: tier.basis, value: tier.value, tier_reminders: tier.reminders, reminder_count: count };
    if (existing?.status === 'waived' && Number(existing.tier_reminders ?? 0) >= tier.reminders) {
      await penalties.updateOne({ id: existing.id }, { $set: { reminder_count: count } });
      return;
    }
    const changed = !existing || existing.status !== 'active' || existing.tier_reminders !== tier.reminders || existing.basis !== tier.basis || existing.value !== tier.value;
    let id: string;
    if (!existing) {
      id = (await penalties.insert({ employee_id: e.id, month, kind: 'late_coming', source: 'auto', status: 'active', ...values })).id as string;
    } else {
      id = existing.id as string;
      await penalties.updateOne({ id }, { $set: { ...values, status: 'active', status_reason: null, status_by_membership_id: null } });
    }
    if (!changed) return;
    await this.audit.record(tx, { action: 'attendance_penalty.applied', resourceType: 'attendance_penalty', resourceId: id, changes: { employeeId: e.id, month, kind: 'late_coming', ...values } });
    await this.notifications.notify(tx, {
      membershipIds: [e.membership_id], kind: 'attendance.penalty_applied', title: `Late-coming deduction for ${month}`,
      body: `You have ${count} late reminders this month, so ${deductionText(tier.basis, tier.value)} will be deducted from your salary for ${month}.`,
      link: '/attendance', email: p.late.email,
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Same-day leave
  // ---------------------------------------------------------------------------------------------------------

  /**
   * Called when a leave request is made: marks it same-day leave when it starts on or before the employee's local
   * date, and applies the automatic penalty when the workspace wants one. Returns a line for the approver's summary.
   */
  async onLeaveRequested(tx: TenantTx, req: { id: string; employee_id: string; leave_type_id: string; start_date: string }): Promise<string | null> {
    const e = await this.days.employee(tx, req.employee_id);
    if (!e) return null;
    const appliedOn = localToday(e.tz);
    const p = await this.policyIn(tx);
    const sameDay = isSameDayLeave(req.start_date, appliedOn, p.sameDayLeave.enabled ? p.sameDayLeave.includeBackdated : true);
    await tx.collection('leave_requests').updateOne({ id: req.id }, { $set: { applied_on: appliedOn, same_day: sameDay || null } });
    if (!sameDay || !p.sameDayLeave.enabled) return sameDay ? 'Applied on the day the leave starts.' : null;
    if (p.sameDayLeave.exemptLeaveTypeIds.includes(req.leave_type_id)) return 'Same-day leave (this leave type has no penalty).';
    if (p.sameDayLeave.mode === 'manual') return `Same-day leave: you can apply a penalty (suggested ${deductionText('days', p.sameDayLeave.penaltyDays)}).`;
    const row = await tx.collection('attendance_penalties').insert({
      employee_id: e.id, month: monthOf(req.start_date), kind: 'same_day_leave', source: 'auto', status: 'active', basis: 'days', value: p.sameDayLeave.penaltyDays,
      leave_request_id: req.id, work_date: req.start_date, reason: 'Leave applied on the day it starts (workspace rule).',
    });
    await this.audit.record(tx, { action: 'attendance_penalty.applied', resourceType: 'attendance_penalty', resourceId: row.id as string, changes: { employeeId: e.id, kind: 'same_day_leave', days: p.sameDayLeave.penaltyDays, leaveRequestId: req.id } });
    await this.notifications.notify(tx, {
      membershipIds: [e.membership_id], kind: 'leave.same_day_penalty', title: `Same-day leave penalty: ${deductionText('days', p.sameDayLeave.penaltyDays)}`,
      body: `Your leave from ${req.start_date} was applied on ${appliedOn}. Under your workspace's rules ${deductionText('days', p.sameDayLeave.penaltyDays)} will be deducted from your salary for ${monthOf(req.start_date)} if the leave is approved. Your manager can change or waive it.`,
      link: '/leave', email: true,
    });
    return `Same-day leave: ${deductionText('days', p.sameDayLeave.penaltyDays)} penalty applied automatically. You can change or waive it.`;
  }

  /** A rejected or cancelled leave request takes its penalty with it. */
  async onLeaveClosed(tx: TenantTx, requestId: string, status: 'rejected' | 'cancelled') {
    const p = await tx.collection('attendance_penalties').findOne({ leave_request_id: requestId, kind: 'same_day_leave', status: 'active' });
    if (!p) return;
    await tx.collection('attendance_penalties').updateOne({ id: p.id }, { $set: { status: 'cancelled', status_reason: `The leave request was ${status}.` } });
    await this.audit.record(tx, { action: 'attendance_penalty.cancelled', resourceType: 'attendance_penalty', resourceId: p.id, metadata: { leaveRequestId: requestId, status } });
  }

  /** What the approver sees on a leave request: whether it is same-day leave, its penalty, and the suggested one. */
  async leaveDetails(tx: TenantTx, requestId: string) {
    const r = await tx.collection('leave_requests').findOne({ id: requestId }, { projection: { same_day: 1, applied_on: 1, leave_type_id: 1 } });
    if (!r?.same_day) return null;
    const p = await this.policyIn(tx);
    const pen = await tx.collection('attendance_penalties').findOne({ leave_request_id: requestId, kind: 'same_day_leave' });
    const exempt = p.sameDayLeave.exemptLeaveTypeIds.includes(r.leave_type_id);
    return {
      sameDay: true,
      appliedOn: (r.applied_on ?? null) as string | null,
      policyEnabled: p.sameDayLeave.enabled,
      mode: p.sameDayLeave.mode,
      exempt,
      suggestedDays: p.sameDayLeave.enabled && !exempt ? p.sameDayLeave.penaltyDays : null,
      penalty: pen ? { id: pen.id as string, days: pen.value as string, source: pen.source as string, status: pen.status as string } : null,
    };
  }

  /** A manager or HR applies (or changes) a same-day leave penalty of some days of pay. */
  async setLeavePenalty(requestId: string, input: { days: string; reason?: string }) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('leave_requests').findOne({ id: requestId });
      if (!r) throw Errors.notFound('Leave request');
      const e = (await this.days.employee(tx, r.employee_id))!;
      await this.authz.require('leave:read', attrsOf(e), tx);
      await this.authz.require('leave:approve', attrsOf(e), tx);
      if ((await this.authz.subject(tx)).employeeId === e.id) throw Errors.forbidden('You cannot set a penalty on your own leave');
      if (r.status !== 'pending' && r.status !== 'approved') throw Errors.conflict('invalid_state', `This request is ${r.status}`);
      if (await isLocked(tx, e.id, r.start_date)) throw Errors.conflict('period_locked', 'This month is locked for payroll.');
      const penalties = tx.collection('attendance_penalties');
      const existing = await penalties.findOne({ leave_request_id: requestId, kind: 'same_day_leave' });
      const values = {
        basis: 'days', value: input.days, source: 'manual', status: 'active', reason: input.reason ?? (r.same_day ? 'Same-day leave.' : 'Leave applied at short notice.'),
        status_reason: null, status_by_membership_id: null, created_by_membership_id: actorMembership(),
      };
      let id: string;
      if (existing) {
        id = existing.id as string;
        await penalties.updateOne({ id }, { $set: values });
      } else {
        id = (await penalties.insert({ employee_id: e.id, month: monthOf(r.start_date), kind: 'same_day_leave', leave_request_id: requestId, work_date: r.start_date, ...values })).id as string;
      }
      await this.audit.record(tx, {
        action: 'attendance_penalty.applied', resourceType: 'attendance_penalty', resourceId: id,
        changes: { employeeId: e.id, kind: 'same_day_leave', days: input.days, before: existing ? { days: existing.value, status: existing.status } : null, leaveRequestId: requestId },
        metadata: { reason: input.reason ?? null },
      });
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'leave.same_day_penalty', title: `Leave penalty: ${deductionText('days', input.days)}`,
        body: `${deductionText('days', input.days)} will be deducted from your salary for ${monthOf(r.start_date)} for your leave from ${r.start_date}${input.reason ? `. Reason: ${input.reason}` : '.'}`,
        link: '/leave', email: true,
      });
      return this.penaltyView(tx, (await penalties.findOne({ id }))!);
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Penalties
  // ---------------------------------------------------------------------------------------------------------

  async waive(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const p = await tx.collection('attendance_penalties').findOne({ id });
      if (!p) throw Errors.notFound('Penalty');
      const e = (await this.days.employee(tx, p.employee_id))!;
      const permission = p.kind === 'late_coming' ? 'attendance:approve' : 'leave:approve';
      await this.authz.require(p.kind === 'late_coming' ? 'attendance:read' : 'leave:read', attrsOf(e), tx);
      await this.authz.require(permission, attrsOf(e), tx);
      if ((await this.authz.subject(tx)).employeeId === e.id) throw Errors.forbidden('You cannot waive your own penalty');
      if (p.status !== 'active') throw Errors.conflict('invalid_state', `This penalty is already ${p.status}.`);
      if (await isLocked(tx, e.id, p.work_date ?? `${p.month}-01`)) throw Errors.conflict('period_locked', 'This month is locked for payroll.');
      await tx.collection('attendance_penalties').updateOne({ id, status: 'active' }, { $set: { status: 'waived', status_reason: reason, status_by_membership_id: actorMembership() } });
      await this.audit.record(tx, { action: 'attendance_penalty.waived', resourceType: 'attendance_penalty', resourceId: id, metadata: { reason, kind: p.kind, month: p.month } });
      await this.notifications.notify(tx, {
        membershipIds: [e.membership_id], kind: 'attendance.penalty_waived', title: `${p.kind === 'late_coming' ? 'Late-coming deduction' : 'Leave penalty'} for ${p.month} waived`, body: reason,
        link: p.kind === 'late_coming' ? '/attendance' : '/leave', email: true,
      });
      return this.penaltyView(tx, (await tx.collection('attendance_penalties').findOne({ id }))!);
    });
  }

  private async penaltyView(tx: TenantTx, p: Doc, names?: Map<string, string | null>, people?: Map<string, { name: string; doc: Doc }>) {
    const n = names ?? (await membershipUserNames(tx, [p.created_by_membership_id, p.status_by_membership_id]));
    const who = people ?? (await employeeNames(tx, [p.employee_id]));
    return {
      id: p.id as string, employeeId: p.employee_id as string, employeeName: who.get(p.employee_id)?.name ?? null, employeeCode: (who.get(p.employee_id)?.doc.employee_code as string) ?? null,
      kind: p.kind as string, month: p.month as string, source: p.source as string, status: p.status as string, basis: p.basis as string, value: p.value as string,
      deduction: deductionText(p.basis, p.value), label: penaltyLabel(p), reminderCount: p.reminder_count ?? null, tierReminders: p.tier_reminders ?? null,
      leaveRequestId: p.leave_request_id ?? null, workDate: p.work_date ?? null, reason: p.reason ?? null, statusReason: p.status_reason ?? null,
      createdBy: n.get(p.created_by_membership_id) ?? null, statusBy: n.get(p.status_by_membership_id) ?? null, createdAt: p.created_at, updatedAt: p.updated_at,
    };
  }

  /** Ids of the employees the caller may see for a permission. */
  private async visible(tx: TenantTx, permission: string, employeeId?: string): Promise<string[]> {
    const scope = await this.authz.filter(permission, EMPLOYEE_FIELDS, tx);
    return (await tx.collection('employees').find({ $and: [scope, employeeId ? { id: employeeId } : {}] }, { projection: { _id: 1 } })).map((x) => x.id as string);
  }

  /**
   * The month's late arrivals, reminders and penalties for everyone the caller can see (or one person): what a
   * manager works from, and what an employee sees about themselves.
   */
  async month(q: { month: string; employeeId?: string }) {
    return this.db.tenant(async (tx) => {
      const from = `${q.month}-01`;
      const to = monthEnd(q.month);
      const ids = await this.visible(tx, 'attendance:read', q.employeeId);
      if (q.employeeId && !ids.length) throw Errors.notFound('Employee');
      const leaveIds = new Set(await this.visible(tx, 'leave:read', q.employeeId));
      await this.fillMissingDays(tx, ids, from, to);
      const p = await this.policyIn(tx);
      const s = await this.authz.subject(tx);
      const [lateDays, reminders, penalties] = await Promise.all([
        tx.collection('attendance_days').find({ employee_id: { $in: ids }, work_date: { $gte: from, $lte: to }, late_minutes: { $gt: 0 } }, { sort: { work_date: 1 }, limit: 5000 }),
        tx.collection('late_reminders').find({ employee_id: { $in: ids }, month: q.month }, { sort: { work_date: 1, created_at: 1 } }),
        tx.collection('attendance_penalties').find({ employee_id: { $in: [...new Set([...ids, ...leaveIds])] }, month: q.month }, { sort: { created_at: 1 } }),
      ]);
      const visiblePenalties = penalties.filter((x) => (x.kind === 'late_coming' ? ids.includes(x.employee_id) : leaveIds.has(x.employee_id)));
      const people = await employeeNames(tx, [...lateDays, ...reminders, ...visiblePenalties].map((x) => x.employee_id));
      const names = await membershipUserNames(tx, [...reminders.flatMap((r) => [r.sent_by_membership_id, r.withdrawn_by_membership_id]), ...visiblePenalties.flatMap((x) => [x.created_by_membership_id, x.status_by_membership_id])]);
      const live = new Map(reminders.filter((r) => r.status === 'sent').map((r) => [`${r.employee_id}|${r.work_date}`, r]));
      const canRemind = async (employeeId: string) => {
        const e = await this.days.employee(tx, employeeId);
        return Boolean(e && s.employeeId !== employeeId && grantsFor(s, 'attendance:approve').some((g) => grantCovers(s, g, attrsOf(e))));
      };
      const remindable = new Map<string, boolean>();
      for (const id of new Set([...lateDays.map((d) => d.employee_id as string), ...visiblePenalties.map((x) => x.employee_id as string)])) remindable.set(id, await canRemind(id));
      const minLate = p.late.minLateMinutes;
      const days = lateDays.map((d) => {
        const r = live.get(`${d.employee_id}|${d.work_date}`);
        return {
          employeeId: d.employee_id as string, employeeName: people.get(d.employee_id)?.name ?? null, employeeCode: (people.get(d.employee_id)?.doc.employee_code as string) ?? null,
          workDate: d.work_date as string, lateMinutes: d.late_minutes as number, firstIn: d.first_in ?? null, counts: (d.late_minutes as number) >= minLate,
          reminder: r ? { id: r.id as string, source: r.source as string, sequence: r.sequence as number, createdAt: r.created_at } : null,
          canRemind: !r && remindable.get(d.employee_id) === true,
        };
      });
      const reminderViews = reminders.map((r) => ({
        id: r.id as string, employeeId: r.employee_id as string, employeeName: people.get(r.employee_id)?.name ?? null, workDate: r.work_date as string, source: r.source as string,
        sequence: r.sequence as number, lateMinutes: r.late_minutes as number, note: r.note ?? null, status: r.status as string, emailed: Boolean(r.emailed),
        sentBy: names.get(r.sent_by_membership_id) ?? null, createdAt: r.created_at, withdrawnReason: r.withdrawn_reason ?? null, withdrawnBy: names.get(r.withdrawn_by_membership_id) ?? null,
        canWithdraw: r.status === 'sent' && remindable.get(r.employee_id) === true,
      }));
      for (const r of reminders) if (!remindable.has(r.employee_id)) remindable.set(r.employee_id, await canRemind(r.employee_id));
      for (const v of reminderViews) v.canWithdraw = v.status === 'sent' && remindable.get(v.employeeId) === true;
      const penaltyViews = [];
      for (const x of visiblePenalties) {
        const view = await this.penaltyView(tx, x, names, people);
        const e = await this.days.employee(tx, x.employee_id);
        const perm = x.kind === 'late_coming' ? 'attendance:approve' : 'leave:approve';
        const canWaive = Boolean(x.status === 'active' && e && s.employeeId !== e.id && grantsFor(s, perm).some((g) => grantCovers(s, g, attrsOf(e))));
        penaltyViews.push({ ...view, canWaive });
      }
      // One line per person: late days, reminders, and what is deducted.
      const summary = new Map<string, { employeeId: string; employeeName: string | null; lateDays: number; reminders: number; deductions: string[] }>();
      const row = (id: string) => {
        if (!summary.has(id)) summary.set(id, { employeeId: id, employeeName: people.get(id)?.name ?? null, lateDays: 0, reminders: 0, deductions: [] });
        return summary.get(id)!;
      };
      for (const d of days) row(d.employeeId).lateDays++;
      for (const r of reminders) if (r.status === 'sent') row(r.employee_id).reminders++;
      for (const x of penaltyViews) if (x.status === 'active') row(x.employeeId).deductions.push(`${x.label}: ${x.deduction}`);
      return {
        month: q.month,
        policy: { late: p.late, sameDayLeave: { enabled: p.sameDayLeave.enabled, mode: p.sameDayLeave.mode, penaltyDays: p.sameDayLeave.penaltyDays } },
        people: [...summary.values()].sort((a, b) => String(a.employeeName).localeCompare(String(b.employeeName))),
        lateDays: days,
        reminders: reminderViews,
        penalties: penaltyViews,
      };
    });
  }

  /**
   * Days of the month nobody has opened yet (for example punches imported from a machine) are computed first, so
   * every late arrival is listed. Days already stored are left as they are; the hourly refresh keeps recent ones
   * current.
   */
  private async fillMissingDays(tx: TenantTx, ids: string[], from: string, to: string) {
    const people = await tx.collection('employees').find(
      { id: { $in: ids }, status: { $ne: 'pre_boarding' }, date_of_joining: { $lte: to }, $or: [{ last_working_day: null }, { last_working_day: { $gte: from } }] },
      { projection: { _id: 1 } },
    );
    for (const x of people) {
      const e = await this.days.employee(tx, x.id);
      if (!e) continue;
      const end = [to, localToday(e.tz), e.last_working_day ?? to].sort()[0]!;
      const start = from < e.date_of_joining ? e.date_of_joining : from;
      if (start > end) continue;
      const have = new Set((await tx.collection('attendance_days').find({ employee_id: e.id, work_date: { $gte: start, $lte: end } }, { projection: { work_date: 1 } })).map((d) => d.work_date as string));
      for (let d = start; d <= end; d = addDays(d, 1)) if (!have.has(d)) await this.days.recompute(tx, e.id, d, d);
    }
  }

  /**
   * The active penalties payroll deducts for one employee and month. Same-day leave penalties count only once their
   * leave is approved; one on a request still waiting is reported so payroll can warn.
   */
  async penaltiesForPayroll(tx: TenantTx, employeeId: string, month: string) {
    const rows = await tx.collection('attendance_penalties').find({ employee_id: employeeId, month, status: 'active' }, { sort: { created_at: 1 } });
    const leave = new Map(
      (await tx.collection('leave_requests').find({ id: { $in: rows.map((r) => r.leave_request_id).filter(Boolean) } }, { projection: { status: 1 } })).map((r) => [r.id as string, r.status as string]),
    );
    const out: { id: string; label: string; basis: 'percent' | 'days'; value: string; note?: string }[] = [];
    const waiting: string[] = [];
    for (const r of rows) {
      if (r.kind === 'same_day_leave' && leave.get(r.leave_request_id) !== 'approved') {
        waiting.push(r.work_date ?? r.month);
        continue;
      }
      out.push({
        id: r.id, label: penaltyLabel(r), basis: r.basis, value: r.value,
        note: r.kind === 'late_coming' ? `Tier: ${r.tier_reminders} reminders` : r.source === 'auto' ? 'Applied by the workspace rule' : 'Applied by a manager',
      });
    }
    return { penalties: out, waiting };
  }
}

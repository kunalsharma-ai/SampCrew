import { Injectable } from '@nestjs/common';
import { DEFAULT_REWARD_RULES, evaluateReward, money, type RewardDay, type RewardRuleInput, type rewardGrantInput, zonedTime } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { AttendanceDaysService } from '../attendance/attendance-days.service';
import { AttendanceService } from '../attendance/attendance.service';
import { displayName, fieldById } from '../employees/employee-view';

const { addDays, localToday } = zonedTime;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const monthStart = (m: string) => `${m}-01`;
const monthEnd = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};
const prevMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

function ruleView(r: Doc) {
  return {
    id: r.id as string, name: r.name as string, kind: r.kind, description: r.description ?? null, icon: r.icon, active: r.active as boolean,
    maxLateDays: r.max_late_days as number, excusedLeaveTypeIds: (r.excused_leave_type_ids ?? []) as string[], allowHalfDays: r.allow_half_days as boolean, minWorkingDays: r.min_working_days as number,
    payoutType: (r.payout_type ?? 'none') as RewardRuleInput['payoutType'], payoutAmount: (r.payout_amount ?? null) as string | null,
    payoutLeaveTypeId: (r.payout_leave_type_id ?? null) as string | null, payoutDays: (r.payout_days ?? null) as string | null,
  };
}
const toRow = (i: RewardRuleInput) => ({
  name: i.name, kind: i.kind, description: i.description, icon: i.icon, active: i.active, max_late_days: i.maxLateDays,
  excused_leave_type_ids: i.excusedLeaveTypeIds, allow_half_days: i.allowHalfDays, min_working_days: i.minWorkingDays,
  // Only the fields of the chosen payout are kept, so a rule never carries a stale amount or leave type.
  payout_type: i.payoutType, payout_amount: i.payoutType === 'bonus' ? i.payoutAmount : null,
  payout_leave_type_id: i.payoutType === 'leave_credit' ? i.payoutLeaveTypeId : null, payout_days: i.payoutType === 'leave_credit' ? i.payoutDays : null,
});

/** "Bonus INR 500.00" or "1 day of Earned leave": what a payout gives, in words. */
function payoutLabel(g: { payout_type: string; amount?: string | null; currency?: string | null; days?: string | null }, leaveTypeName?: string | null) {
  if (g.payout_type === 'bonus') return `a bonus of ${money.formatMoney(money.toMinor(g.amount ?? '0'), g.currency ?? '')}`;
  const d = Number(g.days ?? 0);
  return `${d} ${d === 1 ? 'day' : 'days'} of ${leaveTypeName ?? 'leave'}`;
}

function grantView(g: Doc, leaveTypeName?: string | null) {
  return {
    id: g.id as string, ruleId: g.rule_id as string, ruleName: g.rule_name as string, employeeId: g.employee_id as string, month: g.month as string,
    payoutType: g.payout_type as 'bonus' | 'leave_credit', amount: (g.amount ?? null) as string | null, currency: (g.currency ?? null) as string | null,
    leaveTypeId: (g.leave_type_id ?? null) as string | null, leaveTypeName: leaveTypeName ?? null, days: (g.days ?? null) as string | null,
    status: g.status as 'granted' | 'credited' | 'paid' | 'revoked', payrollRunId: (g.payroll_run_id ?? null) as string | null,
    label: payoutLabel(g as { payout_type: string }, leaveTypeName), grantedAt: g.created_at, paidAt: g.paid_at ?? null, revokedAt: g.revoked_at ?? null, revokeReason: (g.revoke_reason ?? null) as string | null,
  };
}

/**
 * The employee's own workspace: attendance rewards (rules HR sets, evaluated on the person's attendance days) and a
 * month calendar of working days, holidays, weekly offs, leave and deadlines.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly attendance: AttendanceService,
    private readonly days: AttendanceDaysService,
    private readonly notifications: NotificationService,
  ) {}

  private async myEmployee(tx: TenantTx) {
    const s = await this.authz.subject(tx);
    if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
    return (await this.days.employee(tx, s.employeeId))!;
  }

  // Rules ---------------------------------------------------------------------------------------------------------

  async rules() {
    return this.db.tenant(async (tx) => (await tx.collection('attendance_reward_rules').find({}, { sort: { created_at: 1 } })).map(ruleView));
  }

  async createRule(input: RewardRuleInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      await this.checkLeaveTypes(tx, [...input.excusedLeaveTypeIds, ...(input.payoutType === 'leave_credit' && input.payoutLeaveTypeId ? [input.payoutLeaveTypeId] : [])]);
      const row = await tx.collection('attendance_reward_rules').insert(toRow(input));
      await this.audit.record(tx, { action: 'attendance_reward.created', resourceType: 'attendance_reward_rule', resourceId: row.id, metadata: { name: input.name, kind: input.kind } });
      return ruleView(row);
    });
  }

  async updateRule(id: string, input: RewardRuleInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      if (!(await tx.collection('attendance_reward_rules').exists({ id }))) throw Errors.notFound('Reward rule');
      await this.checkLeaveTypes(tx, [...input.excusedLeaveTypeIds, ...(input.payoutType === 'leave_credit' && input.payoutLeaveTypeId ? [input.payoutLeaveTypeId] : [])]);
      const row = await tx.collection('attendance_reward_rules').updateAndGet({ id }, { $set: toRow(input) });
      await this.audit.record(tx, {
        action: 'attendance_reward.updated', resourceType: 'attendance_reward_rule', resourceId: id,
        metadata: { name: input.name, payoutType: input.payoutType, payoutAmount: input.payoutAmount, payoutDays: input.payoutDays, payoutLeaveTypeId: input.payoutLeaveTypeId },
      });
      return ruleView(row!);
    });
  }

  async deleteRule(id: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      if (!(await tx.collection('attendance_reward_rules').delete({ id }))) throw Errors.notFound('Reward rule');
      await this.audit.record(tx, { action: 'attendance_reward.deleted', resourceType: 'attendance_reward_rule', resourceId: id });
      return { deleted: true };
    });
  }

  /** Adds the standard rules, with sick leave types excused. */
  async addDefaults() {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      const sick = (await tx.collection('leave_types').find({ archived_at: null })).filter((t) => /sick/i.test(`${t.code} ${t.name}`)).map((t) => t.id as string);
      const have = new Set((await tx.collection('attendance_reward_rules').find({})).map((r) => r.kind));
      const added = [];
      for (const r of DEFAULT_REWARD_RULES) {
        if (have.has(r.kind)) continue;
        added.push(ruleView(await tx.collection('attendance_reward_rules').insert(toRow({ ...r, excusedLeaveTypeIds: sick }))));
      }
      return added;
    });
  }

  private async checkLeaveTypes(tx: TenantTx, ids: string[]) {
    if (ids.length && (await tx.collection('leave_types').count({ id: { $in: ids } })) !== new Set(ids).size) throw Errors.badRequest('unknown_leave_type', 'A leave type does not exist');
  }

  // Rewards -------------------------------------------------------------------------------------------------------

  /** My rewards for a month (this month by default), with the last six months' results. */
  async rewards(month?: string, withHistory = true) {
    const { e, rules, today, payouts, grants } = await this.db.tenant(async (tx) => {
      const e = await this.myEmployee(tx);
      const rules = (await tx.collection('attendance_reward_rules').find({ active: true }, { sort: { created_at: 1 } })).map(ruleView);
      const today = localToday(e.tz);
      const current = today.slice(0, 7);
      const target = month && month <= current ? month : current;
      const tenant = await tx.collection('tenants').findOne({}, { projection: { currency: 1 } });
      const mine = await tx.collection('attendance_reward_grants').find({ employee_id: e.id, month: target, status: { $ne: 'revoked' } });
      const names = await fieldById(tx, 'leave_types', [...rules.map((r) => r.payoutLeaveTypeId), ...mine.map((g) => g.leave_type_id)].filter(Boolean), 'name');
      // What each rule pays, in words, and what HR has granted me for the month.
      const payouts = new Map(rules.map((r) => [r.id, r.payoutType === 'none' ? null : payoutLabel({ payout_type: r.payoutType, amount: r.payoutAmount, currency: tenant?.currency, days: r.payoutDays }, names.get(r.payoutLeaveTypeId ?? ''))]));
      const grants = new Map(mine.map((g) => [g.rule_id as string, grantView(g, names.get(g.leave_type_id))]));
      return { e, rules, today, payouts, grants };
    });
    const current = today.slice(0, 7);
    const target = month && month <= current ? month : current;
    const evaluate = async (m: string) => {
      if (monthEnd(m) < e.date_of_joining) return null;
      const from = monthStart(m);
      const to = monthEnd(m);
      // Days up to today are computed by the attendance engine (the same days the attendance pages show).
      const days = await this.attendance.employeeDays(undefined, from, to > today ? today : to);
      const leaves = await this.db.tenant((tx) => tx.collection('leave_requests').find({ employee_id: e.id, status: 'approved', start_date: { $lte: to }, end_date: { $gte: from } }));
      const leaveOn = (d: string) => leaves.find((l) => l.start_date <= d && l.end_date >= d)?.leave_type_id ?? null;
      const rows: RewardDay[] = days.days.filter((d: Doc) => d.workDate < today || m < current).map((d: Doc) => ({ date: d.workDate, dayType: d.dayType, status: d.status, lateMinutes: d.lateMinutes ?? 0, leaveTypeId: leaveOn(d.workDate) }));
      const complete = m < current;
      return rules.map((r) => ({ ...r, ...evaluateReward(r, rows, complete) }));
    };
    const results = (await evaluate(target))?.map((r) => ({ ...r, payout: payouts.get(r.id) ?? null, grant: grants.get(r.id) ?? null }));
    const history: { month: string; earned: { id: string; name: string; icon: string }[] }[] = [];
    if (rules.length && withHistory) {
      const months: string[] = [];
      for (let i = 0, m = prevMonth(target); i < 6; i++, m = prevMonth(m)) months.push(m);
      // The six months are independent, so they are worked out together; history stops at the joining month.
      const results = await Promise.all(months.map(evaluate));
      for (const [i, r] of results.entries()) {
        if (!r) break;
        history.push({ month: months[i]!, earned: r.filter((x) => x.status === 'earned').map((x) => ({ id: x.id, name: x.name, icon: x.icon })) });
      }
    }
    return { month: target, complete: target < current, rewards: results ?? [], history };
  }

  // Winners (HR) --------------------------------------------------------------------------------------------------

  /**
   * Who earned each active reward rule in a finished month (last month by default), for HR. Every employee working
   * in the month is evaluated on the same attendance days the employee sees; days the engine has not computed yet are
   * computed first. Only finished months have winners.
   */
  async winners(month?: string) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      return this.winnersIn(tx, month);
    });
  }

  private async winnersIn(tx: TenantTx, month?: string) {
    {
      const tenant = await tx.collection('tenants').findOne({});
      const today = localToday((tenant?.timezone as string | undefined) ?? 'UTC');
      const current = today.slice(0, 7);
      const m = month && month < current ? month : prevMonth(current);
      const from = monthStart(m);
      const to = monthEnd(m);
      const rules = (await tx.collection('attendance_reward_rules').find({ active: true }, { sort: { created_at: 1 } })).map(ruleView);
      const employees = await tx.collection('employees').find(
        { date_of_joining: { $lte: to }, $or: [{ last_working_day: null }, { last_working_day: { $gte: from } }] },
        { sort: { employee_code: 1 }, limit: 5000 },
      );
      const ids = employees.map((e) => e.id as string);
      // Fill in any day the attendance engine has not computed yet, so a winner is never decided on missing days.
      const have = new Map<string, Set<string>>();
      for (const d of await tx.collection('attendance_days').find({ employee_id: { $in: ids }, work_date: { $gte: from, $lte: to } }, { projection: { employee_id: 1, work_date: 1 } })) {
        (have.get(d.employee_id) ?? have.set(d.employee_id, new Set()).get(d.employee_id)!).add(d.work_date);
      }
      for (const e of employees) {
        const start = e.date_of_joining > from ? (e.date_of_joining as string) : from;
        const end = e.last_working_day && e.last_working_day < to ? (e.last_working_day as string) : to;
        const got = have.get(e.id)?.size ?? 0;
        if (start <= end && got < Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1) await this.days.recompute(tx, e.id, start, end);
      }
      const [days, leaves, depts] = await Promise.all([
        tx.collection('attendance_days').find({ employee_id: { $in: ids }, work_date: { $gte: from, $lte: to } }, { sort: { work_date: 1 } }),
        tx.collection('leave_requests').find({ employee_id: { $in: ids }, status: 'approved', start_date: { $lte: to }, end_date: { $gte: from } }),
        fieldById(tx, 'departments', employees.map((e) => e.current_department_id)),
      ]);
      const byEmployee = new Map<string, Doc[]>();
      for (const d of days) (byEmployee.get(d.employee_id) ?? byEmployee.set(d.employee_id, []).get(d.employee_id)!).push(d);
      const out = rules.map((r) => ({ ...r, winners: [] as { employeeId: string; name: string; code: string | null; departmentName: string | null; daysCounted: number }[] }));
      for (const e of employees) {
        const mine = leaves.filter((l) => l.employee_id === e.id);
        const rows: RewardDay[] = (byEmployee.get(e.id) ?? []).map((d) => ({
          date: d.work_date, dayType: d.day_type, status: d.status, lateMinutes: d.late_minutes ?? 0,
          leaveTypeId: mine.find((l) => l.start_date <= d.work_date && l.end_date >= d.work_date)?.leave_type_id ?? null,
        }));
        if (!rows.length) continue;
        for (const r of out) {
          const v = evaluateReward(r, rows, true);
          if (v.status === 'earned') r.winners.push({ employeeId: e.id, name: displayName(e as never), code: (e.employee_code ?? null) as string | null, departmentName: depts.get(e.current_department_id) ?? null, daysCounted: v.done });
        }
      }
      // What HR has already granted for the month, shown next to each winner.
      const grants = await tx.collection('attendance_reward_grants').find({ month: m });
      const leaveNames = await fieldById(tx, 'leave_types', [...grants.map((g) => g.leave_type_id), ...rules.map((r) => r.payoutLeaveTypeId)].filter(Boolean), 'name');
      const grantOf = new Map(grants.map((g) => [`${g.rule_id}:${g.employee_id}`, grantView(g, leaveNames.get(g.leave_type_id))]));
      const currency = (tenant?.currency as string | undefined) ?? 'USD';
      const rulesOut = out.map((r) => {
        const winners = r.winners.map((x) => ({ ...x, grant: grantOf.get(`${r.id}:${x.employeeId}`) ?? null }));
        const payout = r.payoutType === 'none' ? null : { type: r.payoutType, label: payoutLabel({ payout_type: r.payoutType, amount: r.payoutAmount, currency, days: r.payoutDays }, leaveNames.get(r.payoutLeaveTypeId ?? '')) };
        return { ...r, payout, winners, toGrant: payout ? winners.filter((x) => !x.grant).length : 0 };
      });
      return { month: m, evaluated: employees.length, currency, rules: rulesOut };
    }
  }

  /**
   * Turns a finished month's rewards into real benefits for the winners not granted yet: a bonus that the next payroll
   * run of each person's legal entity pays as an earning, or leave days credited now. Winners are decided again here
   * on the same attendance days, so only people who really earned the reward are paid, and each rule pays a person
   * at most once a month. One rule or chosen people can be granted on their own.
   */
  async grant(input: z.infer<typeof rewardGrantInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      const w = await this.winnersIn(tx, input.month);
      if (w.month !== input.month) throw Errors.badRequest('month_not_finished', 'Rewards can be granted only for a month that is over');
      const only = input.employeeIds ? new Set(input.employeeIds) : null;
      const rules = await tx.collection('attendance_reward_rules').find({ id: { $in: w.rules.map((r) => r.id) } });
      const ruleRow = new Map(rules.map((r) => [r.id as string, r]));
      if (input.ruleId && !ruleRow.has(input.ruleId)) throw Errors.notFound('Reward rule');
      const leaveNames = await fieldById(tx, 'leave_types', rules.map((r) => r.payout_leave_type_id).filter(Boolean), 'name');
      const people = await tx.collection('employees').find({ id: { $in: w.rules.flatMap((r) => r.winners.map((x) => x.employeeId)) } }, { projection: { membership_id: 1 } });
      const login = new Map(people.map((e) => [e.id as string, (e.membership_id ?? null) as string | null]));
      const granted: ReturnType<typeof grantView>[] = [];
      for (const r of w.rules) {
        if (input.ruleId && r.id !== input.ruleId) continue;
        const row = ruleRow.get(r.id)!;
        if (r.payoutType === 'none') {
          if (input.ruleId) throw Errors.badRequest('no_payout', `${r.name} pays nothing yet. Set a bonus or leave credit on the rule first.`);
          continue;
        }
        for (const x of r.winners) {
          if (x.grant || (only && !only.has(x.employeeId))) continue;
          const bonus = r.payoutType === 'bonus';
          const g = await tx.collection('attendance_reward_grants').insert({
            rule_id: r.id, rule_name: r.name, employee_id: x.employeeId, month: w.month, payout_type: r.payoutType,
            amount: bonus ? row.payout_amount : null, currency: bonus ? w.currency : null,
            leave_type_id: bonus ? null : row.payout_leave_type_id, days: bonus ? null : row.payout_days,
            status: bonus ? 'granted' : 'credited', payroll_run_id: null, granted_by: actor.userId,
          });
          if (!bonus) {
            await tx.collection('leave_ledger').insert({
              employee_id: x.employeeId, leave_type_id: row.payout_leave_type_id, leave_year: Number(new Date().toISOString().slice(0, 4)), kind: 'adjustment',
              quantity: row.payout_days, effective_on: new Date().toISOString().slice(0, 10), accrual_key: `RWD:${g.id}`,
              note: `Reward: ${r.name} for ${w.month}`, created_by: actor.userId,
            });
          }
          const view = grantView(g, leaveNames.get(row.payout_leave_type_id));
          granted.push(view);
          await this.audit.record(tx, {
            action: 'attendance_reward.granted', resourceType: 'employee', resourceId: x.employeeId,
            changes: { payoutType: r.payoutType, amount: view.amount, currency: view.currency, leaveTypeId: view.leaveTypeId, days: view.days },
            metadata: { grantId: view.id, ruleId: r.id, ruleName: r.name, month: w.month },
          });
          const membership = login.get(x.employeeId);
          if (membership) {
            await this.notifications.notify(tx, {
              membershipIds: [membership], kind: 'attendance.reward_granted', title: `You earned ${r.name} for ${w.month}`,
              body: bonus ? `You get ${view.label}, paid with your next salary.` : `${view.label[0]!.toUpperCase()}${view.label.slice(1)} were added to your leave balance.`,
              link: bonus ? '/' : '/leave',
            });
          }
        }
      }
      return { month: w.month, granted: granted.length, grants: granted };
    });
  }

  /**
   * Takes a granted reward back, with a reason. A bonus not paid yet leaves payroll (a run holding it shows the change
   * when it is computed again; one waiting for approval must be sent back first); leave days are taken off again.
   * A bonus already paid cannot be revoked: recover it in payroll as a deduction.
   */
  async revoke(id: string, reason: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      const grants = tx.collection('attendance_reward_grants');
      const g = await grants.findOne({ id });
      if (!g) throw Errors.notFound('Reward grant');
      if (g.status === 'revoked') throw Errors.conflict('already_revoked', 'This reward was already taken back');
      if (g.status === 'paid') throw Errors.conflict('already_paid', 'This bonus was already paid. Recover it in payroll as a deduction.');
      if (g.payroll_run_id) {
        const run = await tx.collection('payroll_runs').findOne({ id: g.payroll_run_id }, { projection: { status: 1 } });
        if (run?.status === 'pending_approval') throw Errors.conflict('payroll_pending', 'The payroll run paying this bonus is waiting for approval. Send it back first.');
      }
      if (g.payout_type === 'leave_credit') {
        await tx.collection('leave_ledger').insert({
          employee_id: g.employee_id, leave_type_id: g.leave_type_id, leave_year: Number(new Date().toISOString().slice(0, 4)), kind: 'adjustment',
          quantity: `-${g.days}`, effective_on: new Date().toISOString().slice(0, 10), accrual_key: `RWD-REV:${g.id}`,
          note: `Reward taken back: ${g.rule_name} for ${g.month}. ${reason}`.slice(0, 500), created_by: actor.userId,
        });
      }
      const row = await grants.updateAndGet({ id }, { $set: { status: 'revoked', payroll_run_id: null, revoked_at: new Date(), revoked_by: actor.userId, revoke_reason: reason } });
      await this.audit.record(tx, { action: 'attendance_reward.revoked', resourceType: 'employee', resourceId: g.employee_id, metadata: { grantId: id, ruleName: g.rule_name, month: g.month, reason } });
      const leaveName = g.leave_type_id ? (await tx.collection('leave_types').findOne({ id: g.leave_type_id }))?.name : null;
      return grantView(row!, leaveName);
    });
  }

  /** The winners as rows for an Excel download. */
  async winnerRows(month?: string) {
    const w = await this.winners(month);
    const rows: (string | number)[][] = [['Month', 'Reward', 'Employee ID', 'Name', 'Department', 'Days counted', 'Payout', 'Payout status']];
    for (const r of w.rules) {
      for (const x of r.winners) {
        const status = x.grant ? { granted: 'Granted, paid with the next payroll', credited: 'Credited to leave', paid: 'Paid in payroll', revoked: 'Taken back' }[x.grant.status] : r.payout ? 'Not granted yet' : '';
        rows.push([w.month, r.name, x.code ?? '', x.name, x.departmentName ?? '', x.daysCounted, x.grant?.label ?? r.payout?.label ?? 'Recognition only', status]);
      }
    }
    return { month: w.month, rows };
  }

  // Calendar ------------------------------------------------------------------------------------------------------

  /** My month: day types (working, weekly off, holiday) and my leave, task deadlines and appraisal deadlines. */
  async calendar(month?: string) {
    return this.db.tenant(async (tx) => {
      const e = await this.myEmployee(tx);
      const m = month ?? localToday(e.tz).slice(0, 7);
      const from = monthStart(m);
      const to = monthEnd(m);
      const plan = await this.days.plan(tx, e, from, to);
      const [leaves, types, tasks, appraisals] = await Promise.all([
        tx.collection('leave_requests').find({ employee_id: e.id, status: { $in: ['approved', 'pending'] }, start_date: { $lte: to }, end_date: { $gte: from } }),
        tx.collection('leave_types').find({}),
        tx.collection('employee_tasks').find({ employee_id: e.id, due_on: { $gte: from, $lte: to }, status: { $nin: ['completed', 'cancelled'] } }),
        tx.collection('appraisals').find({ employee_id: e.id, stage: 'self' }),
      ]);
      const typeName = new Map(types.map((t) => [t.id as string, { name: t.name as string, color: t.color as string | null }]));
      const cycles = appraisals.length ? await tx.collection('appraisal_cycles').find({ id: { $in: appraisals.map((a) => a.cycle_id) } }) : [];
      const out = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const p = plan.get(d);
        const events: { kind: string; title: string; href: string; status?: string; color?: string | null }[] = [];
        for (const l of leaves) {
          if (l.start_date > d || l.end_date < d) continue;
          const t = typeName.get(l.leave_type_id);
          events.push({ kind: 'leave', title: `${t?.name ?? 'Leave'}${l.status === 'pending' ? ' (pending)' : ''}`, href: '/leave', status: l.status, color: t?.color ?? null });
        }
        for (const t of tasks) if (t.due_on === d) events.push({ kind: 'task', title: `Due: ${t.title}`, href: `/tasks/${t.id}`, status: t.status });
        for (const a of appraisals) {
          const c = cycles.find((x) => x.id === a.cycle_id);
          if (c?.self_due === d) events.push({ kind: 'appraisal', title: `Self-appraisal due: ${c.name}`, href: `/appraisal/${a.id}` });
        }
        out.push({ date: d, dayType: p?.dayType ?? 'working', holidayName: p?.holidayName ?? null, events });
      }
      return { month: m, today: localToday(e.tz), days: out };
    });
  }
}

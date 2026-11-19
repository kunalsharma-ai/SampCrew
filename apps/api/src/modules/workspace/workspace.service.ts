import { Injectable } from '@nestjs/common';
import { DEFAULT_REWARD_RULES, evaluateReward, type RewardDay, type RewardRuleInput, zonedTime } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { AttendanceDaysService } from '../attendance/attendance-days.service';
import { AttendanceService } from '../attendance/attendance.service';

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
  };
}
const toRow = (i: RewardRuleInput) => ({
  name: i.name, kind: i.kind, description: i.description, icon: i.icon, active: i.active, max_late_days: i.maxLateDays,
  excused_leave_type_ids: i.excusedLeaveTypeIds, allow_half_days: i.allowHalfDays, min_working_days: i.minWorkingDays,
});

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
      await this.checkLeaveTypes(tx, input.excusedLeaveTypeIds);
      const row = await tx.collection('attendance_reward_rules').insert(toRow(input));
      await this.audit.record(tx, { action: 'attendance_reward.created', resourceType: 'attendance_reward_rule', resourceId: row.id, metadata: { name: input.name, kind: input.kind } });
      return ruleView(row);
    });
  }

  async updateRule(id: string, input: RewardRuleInput) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('attendance:configure', {}, tx);
      if (!(await tx.collection('attendance_reward_rules').exists({ id }))) throw Errors.notFound('Reward rule');
      await this.checkLeaveTypes(tx, input.excusedLeaveTypeIds);
      const row = await tx.collection('attendance_reward_rules').updateAndGet({ id }, { $set: toRow(input) });
      await this.audit.record(tx, { action: 'attendance_reward.updated', resourceType: 'attendance_reward_rule', resourceId: id, metadata: { name: input.name } });
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
    const { e, rules, today } = await this.db.tenant(async (tx) => {
      const e = await this.myEmployee(tx);
      const rules = (await tx.collection('attendance_reward_rules').find({ active: true }, { sort: { created_at: 1 } })).map(ruleView);
      return { e, rules, today: localToday(e.tz) };
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
    const results = await evaluate(target);
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

import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { zonedTime, type rosterInput, type shiftAssignmentsInput, type ShiftTemplateInput, type swapRequestInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { countBy, MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService, type ApprovalRequestRow } from '../approvals/approvals.service';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { employeeNames, fieldById } from '../employees/employee-view';
import { AttendanceDaysService, type EmployeeCtx, isLocked } from './attendance-days.service';

const { addDays, localToday } = zonedTime;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const templateView = (t: Record<string, any>) => ({
  id: t.id,
  code: t.code,
  name: t.name,
  startTime: String(t.start_time).slice(0, 5),
  endTime: String(t.end_time).slice(0, 5),
  breakMinutes: t.break_minutes,
  graceLateMinutes: t.grace_late_minutes,
  graceEarlyMinutes: t.grace_early_minutes,
  halfDayMinutes: t.half_day_minutes,
  fullDayMinutes: t.full_day_minutes,
  overtimeEnabled: t.overtime_enabled,
  overtimeMinMinutes: t.overtime_min_minutes,
  color: t.color,
  archivedAt: t.archived_at ?? null,
});

const COLUMN_OF: Record<keyof ShiftTemplateInput, string> = {
  code: 'code', name: 'name', startTime: 'start_time', endTime: 'end_time', breakMinutes: 'break_minutes', graceLateMinutes: 'grace_late_minutes',
  graceEarlyMinutes: 'grace_early_minutes', halfDayMinutes: 'half_day_minutes', fullDayMinutes: 'full_day_minutes', overtimeEnabled: 'overtime_enabled',
  overtimeMinMinutes: 'overtime_min_minutes', color: 'color',
};

const attrsOf = (e: EmployeeCtx) =>
  employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });

/** Shift templates, rosters, assignments and shift swaps. */
@Injectable()
export class ShiftsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly days: AttendanceDaysService,
  ) {}

  onModuleInit() {
    this.approvals.register('shift_swap', {
      permission: 'attendance:approve',
      configurePermission: 'attendance:configure',
      defaultSteps: [{ type: 'manager' }],
      fallbackRole: 'hr_admin',
      label: 'Shift swap',
      link: () => '/shifts',
      attributes: async (tx, id) => {
        const r = await tx.collection('shift_swap_requests').findOne({ id });
        return attrsOf((await this.days.employee(tx, r!.requester_employee_id))!);
      },
      onApproved: (tx, req) => this.swapApproved(tx, req),
      onRejected: async (tx, req) => {
        await tx.collection('shift_swap_requests').updateOne({ id: req.resource_id, status: 'pending' }, { $set: { status: 'rejected', decided_at: new Date() } });
        await this.audit.record(tx, { action: 'shift_swap.rejected', resourceType: 'shift_swap', resourceId: req.resource_id });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------------------------------------

  listTemplates(includeArchived = false) {
    return this.db.tenant(async (tx) => (await tx.collection('shift_templates').find(includeArchived ? {} : { archived_at: null }, { sort: { start_time: 1, code: 1 } })).map(templateView));
  }

  createTemplate(input: ShiftTemplateInput) {
    return this.db.tenant(async (tx) => {
      const keys = Object.keys(COLUMN_OF) as (keyof ShiftTemplateInput)[];
      const row = await tx.collection('shift_templates').insert(Object.fromEntries(keys.map((k) => [COLUMN_OF[k], input[k]]))).catch(dup);
      await this.audit.record(tx, { action: 'shift_template.created', resourceType: 'shift_template', resourceId: row.id, changes: input });
      return templateView(row);
    });
  }

  updateTemplate(id: string, input: ShiftTemplateInput) {
    return this.db.tenant(async (tx) => {
      const keys = Object.keys(COLUMN_OF) as (keyof ShiftTemplateInput)[];
      const n = await tx.collection('shift_templates').updateOne({ id, archived_at: null }, { $set: Object.fromEntries(keys.map((k) => [COLUMN_OF[k], input[k]])) }).catch(dup);
      if (!n) throw Errors.notFound('Shift');
      await this.audit.record(tx, { action: 'shift_template.updated', resourceType: 'shift_template', resourceId: id, changes: input });
      return templateView((await tx.collection('shift_templates').findOne({ id }))!);
    });
  }

  archiveTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      if (await tx.collection('attendance_policies').exists({ default_shift_id: id })) {
        throw Errors.conflict('shift_in_use', 'This shift is the default in an attendance policy. Choose another default first.');
      }
      if (!(await tx.collection('shift_templates').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } }))) throw Errors.notFound('Shift');
      await this.audit.record(tx, { action: 'shift_template.archived', resourceType: 'shift_template', resourceId: id });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Rosters and assignments
  // ---------------------------------------------------------------------------------------------------------

  listRosters() {
    return this.db.tenant(async (tx) => {
      const rosters = await tx.collection('rosters').find({}, { sort: { start_date: -1 }, limit: 100 });
      const departments = await fieldById(tx, 'departments', rosters.map((x) => x.department_id));
      const locations = await fieldById(tx, 'locations', rosters.map((x) => x.location_id));
      const counts = await countBy(tx, 'shift_assignments', 'roster_id', rosters.map((x) => x.id));
      return rosters.map((x) => ({
        id: x.id,
        name: x.name,
        startDate: x.start_date,
        endDate: x.end_date,
        status: x.status,
        publishedAt: x.published_at ?? null,
        departmentId: x.department_id ?? null,
        departmentName: departments.get(x.department_id) ?? null,
        locationId: x.location_id ?? null,
        locationName: locations.get(x.location_id) ?? null,
        assignments: counts.get(x.id) ?? 0,
      }));
    });
  }

  createRoster(input: z.infer<typeof rosterInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const row = (await tx.collection('rosters').insert({
        name: input.name,
        start_date: input.startDate,
        end_date: input.endDate,
        department_id: input.departmentId ?? null,
        location_id: input.locationId ?? null,
        created_by: actor.userId,
      }).catch((err: { code?: string }) => {
        if (err.code === '23503') throw Errors.badRequest('invalid_reference', 'Department or location not found');
        throw err;
      }))!;
      await this.audit.record(tx, { action: 'roster.created', resourceType: 'roster', resourceId: row.id, changes: input });
      return this.roster(row.id, tx);
    });
  }

  /** A roster grid: the people it covers (that the caller can see), and each day's planned shift. */
  async roster(id: string, existingTx?: TenantTx) {
    const run = async (tx: TenantTx) => {
      const r = await tx.collection<{ id: string; name: string; start_date: string; end_date: string; status: string; department_id: string | null; location_id: string | null; published_at: string | null }>(
        'rosters',
      ).findOne({ id });
      if (!r) throw Errors.notFound('Roster');
      const scope = await this.authz.filter('shifts:read', EMPLOYEE_FIELDS, tx);
      const people = await tx.collection('employees').find(
        {
          $and: [
            scope,
            { date_of_joining: { $lte: r.end_date } },
            { $or: [{ last_working_day: null }, { last_working_day: { $gte: r.start_date } }] },
            ...(r.department_id ? [{ current_department_id: r.department_id }] : []),
            ...(r.location_id ? [{ current_location_id: r.location_id }] : []),
          ],
        },
        { sort: { first_name: 1, last_name: 1 }, limit: 300, projection: { _id: 1 } },
      );
      const rows = [];
      for (const p of people) {
        const e = (await this.days.employee(tx, p.id))!;
        const plan = await this.days.plan(tx, e, r.start_date, r.end_date);
        const own = new Map((await tx.collection('shift_assignments').find({ roster_id: id, employee_id: e.id })).map((a) => [a.work_date as string, (a.shift_template_id as string | null) ?? null]));
        const cells = [];
        for (let d = r.start_date; d <= r.end_date; d = addDays(d, 1)) {
          const pd = plan.get(d)!;
          cells.push({
            date: d,
            // In a draft, the roster's own entry is what will apply once published.
            shiftId: own.has(d) ? own.get(d) ?? null : pd.shift?.id ?? null,
            inRoster: own.has(d),
            dayType: own.has(d) ? (pd.holidayName ? 'holiday' : own.get(d) ? 'working' : 'weekly_off') : pd.dayType,
            holidayName: pd.holidayName,
          });
        }
        rows.push({ employeeId: e.id, name: e.name, code: e.code, cells });
      }
      return {
        id: r.id, name: r.name, startDate: r.start_date, endDate: r.end_date, status: r.status, publishedAt: r.published_at ?? null, departmentId: r.department_id ?? null, locationId: r.location_id ?? null,
        canEdit: await this.canManageAll(tx, people.map((p) => p.id)),
        rows,
      };
    };
    return existingTx ? run(existingTx) : this.db.tenant(run);
  }

  private async canManageAll(tx: TenantTx, employeeIds: string[]) {
    for (const id of employeeIds.slice(0, 300)) {
      const e = (await this.days.employee(tx, id))!;
      try {
        await this.authz.require('shifts:manage', attrsOf(e), tx);
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Sets shifts for people and dates. Each person must be within the caller's shift-management scope. */
  async assign(input: z.infer<typeof shiftAssignmentsInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      let roster: { id: string; start_date: string; end_date: string; status: string } | undefined;
      if (input.rosterId) {
        roster = await tx.collection<{ id: string; start_date: string; end_date: string; status: string }>('rosters').findOne({ id: input.rosterId });
        if (!roster) throw Errors.notFound('Roster');
        await tx.collection('rosters').lock({ id: input.rosterId });
      }
      const templates = new Set((await tx.collection('shift_templates').find({ archived_at: null }, { projection: { _id: 1 } })).map((t) => t.id as string));
      const checked = new Map<string, EmployeeCtx>();
      for (const a of input.assignments) {
        if (a.shiftTemplateId && !templates.has(a.shiftTemplateId)) throw Errors.badRequest('invalid_shift', 'Shift not found');
        if (roster && (a.workDate < roster.start_date || a.workDate > roster.end_date)) throw Errors.badRequest('outside_roster', `${a.workDate} is outside the roster dates`);
        if (!checked.has(a.employeeId)) {
          const e = await this.days.employee(tx, a.employeeId);
          if (!e) throw Errors.notFound('Employee');
          await this.authz.require('shifts:read', attrsOf(e), tx);
          await this.authz.require('shifts:manage', attrsOf(e), tx);
          checked.set(a.employeeId, e);
        }
        const e = checked.get(a.employeeId)!;
        if (await isLocked(tx, e.id, a.workDate)) {
          throw Errors.conflict('period_locked', `${a.workDate} is in a period locked for payroll.`);
        }
        const values = { shift_template_id: a.shiftTemplateId ?? null, roster_id: input.rosterId ?? null, source: input.rosterId ? 'roster' : 'manual', created_by: actor.userId };
        await tx.collection('shift_assignments').upsert({ employee_id: a.employeeId, work_date: a.workDate }, { employee_id: a.employeeId, work_date: a.workDate, ...values }, { $set: values });
      }
      if (!roster || roster.status === 'published') await this.recomputeAssigned(tx, input.assignments);
      await this.audit.record(tx, { action: 'shift_assignments.saved', resourceType: input.rosterId ? 'roster' : 'shift_assignment', resourceId: input.rosterId ?? 'manual', metadata: { count: input.assignments.length } });
      return { saved: input.assignments.length };
    });
  }

  private async recomputeAssigned(tx: TenantTx, list: { employeeId: string; workDate: string }[]) {
    const byEmployee = new Map<string, string[]>();
    for (const a of list) byEmployee.set(a.employeeId, [...(byEmployee.get(a.employeeId) ?? []), a.workDate]);
    for (const [id, dates] of byEmployee) {
      const e = (await this.days.employee(tx, id))!;
      const today = localToday(e.tz);
      const past = dates.filter((d) => d <= today).sort();
      if (past.length) await this.days.recompute(tx, id, past[0]!, past[past.length - 1]!);
    }
  }

  async publish(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await tx.collection<{ status: string; name: string; start_date: string; end_date: string }>('rosters').findOne({ id });
      if (!r) throw Errors.notFound('Roster');
      if (r.status === 'published') throw Errors.conflict('already_published', 'This roster is already published');
      const rows = await tx.collection('shift_assignments').find({ roster_id: id });
      const holders = await employeeNames(tx, rows.map((a) => a.employee_id));
      const people = rows
        .filter((a) => holders.has(a.employee_id))
        .map((a) => ({ employee_id: a.employee_id as string, work_date: a.work_date as string, membership_id: holders.get(a.employee_id)!.membershipId }));
      for (const id2 of new Set(people.map((p) => p.employee_id))) {
        const e = (await this.days.employee(tx, id2))!;
        await this.authz.require('shifts:manage', attrsOf(e), tx);
      }
      if (!(await tx.collection('rosters').updateOne({ id, status: { $ne: 'published' } }, { $set: { status: 'published', published_at: new Date(), published_by: actor.userId } }))) {
        throw Errors.conflict('already_published', 'This roster is already published');
      }
      await this.recomputeAssigned(tx, people.map((p) => ({ employeeId: p.employee_id, workDate: p.work_date })));
      await this.notifications.notify(tx, {
        membershipIds: [...new Set(people.map((p) => p.membership_id))],
        kind: 'roster.published',
        title: `Your shifts for ${r.start_date} to ${r.end_date} are published`,
        body: r.name,
        link: '/shifts',
      });
      await this.audit.record(tx, { action: 'roster.published', resourceType: 'roster', resourceId: id, metadata: { assignments: people.length } });
      return this.roster(id, tx);
    });
  }

  async deleteRoster(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.collection('rosters').findOne({ id });
      if (!r) throw Errors.notFound('Roster');
      if (r.status === 'published') throw Errors.conflict('roster_published', 'A published roster cannot be deleted. Change its shifts instead.');
      if (!(await tx.collection('rosters').deleteOne({ id, status: { $ne: 'published' } }))) throw Errors.conflict('roster_published', 'A published roster cannot be deleted. Change its shifts instead.');
      await this.audit.record(tx, { action: 'roster.deleted', resourceType: 'roster', resourceId: id });
    });
  }

  /** The planned shift per day for me (or someone I can see). */
  async schedule(employeeId: string | undefined, from: string, to: string) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const id = employeeId ?? s.employeeId;
      if (!id) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet. Ask HR to link it.');
      const e = await this.days.employee(tx, id);
      if (!e) throw Errors.notFound('Employee');
      await this.authz.require('shifts:read', attrsOf(e), tx);
      const plan = await this.days.plan(tx, e, from, to);
      return {
        employeeId: e.id,
        days: [...plan.entries()].map(([date, p]) => ({
          date, dayType: p.dayType, holidayName: p.holidayName, source: p.source,
          shift: p.shift ? { id: p.shift.id, code: p.shift.code, name: p.shift.name, start: p.shift.start_time.slice(0, 5), end: p.shift.end_time.slice(0, 5), color: p.shift.color } : null,
        })),
        swaps: await this.swapsFor(tx, e.id),
      };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Swaps
  // ---------------------------------------------------------------------------------------------------------

  private async swapsFor(tx: TenantTx, employeeId: string) {
    const swaps = await tx.collection('shift_swap_requests').find({ $or: [{ requester_employee_id: employeeId }, { counterpart_employee_id: employeeId }] }, { sort: { created_at: -1 }, limit: 50 });
    const people = await employeeNames(tx, swaps.flatMap((w) => [w.requester_employee_id, w.counterpart_employee_id]));
    const codes = await fieldById(tx, 'shift_templates', swaps.flatMap((w) => [w.requester_shift_id, w.counterpart_shift_id]), 'code');
    return swaps
      .filter((w) => people.has(w.requester_employee_id) && people.has(w.counterpart_employee_id))
      .map((w) => ({
        id: w.id,
        workDate: w.work_date,
        status: w.status,
        reason: w.reason ?? null,
        createdAt: w.created_at,
        requesterId: w.requester_employee_id,
        requesterName: people.get(w.requester_employee_id)!.name,
        counterpartId: w.counterpart_employee_id,
        counterpartName: people.get(w.counterpart_employee_id)!.name,
        requesterShift: codes.get(w.requester_shift_id) ?? null,
        counterpartShift: codes.get(w.counterpart_shift_id) ?? null,
      }));
  }

  /** Colleagues someone could swap with on a date: same department and location, with a different shift. */
  swapCandidates(date: string) {
    return this.db.tenant((tx) => this.candidates(tx, date));
  }

  private async candidates(tx: TenantTx, date: string) {
    {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet.');
      const me = (await this.days.employee(tx, s.employeeId))!;
      const mine = (await this.days.plan(tx, me, date, date)).get(date)!;
      const peers = await tx.collection('employees').find(
        { id: { $ne: me.id }, current_department_id: me.department_id, current_location_id: me.location_id, status: { $ne: 'exited' }, date_of_joining: { $lte: date }, membership_id: { $ne: null } },
        { sort: { first_name: 1 }, limit: 100, projection: { _id: 1 } },
      );
      const out = [];
      for (const p of peers) {
        const e = (await this.days.employee(tx, p.id))!;
        const theirs = (await this.days.plan(tx, e, date, date)).get(date)!;
        if ((theirs.shift?.id ?? null) !== (mine.shift?.id ?? null)) out.push({ employeeId: e.id, name: e.name, shift: theirs.shift ? `${theirs.shift.code} ${theirs.shift.start_time.slice(0, 5)}-${theirs.shift.end_time.slice(0, 5)}` : 'Off' });
      }
      return { date, myShift: mine.shift ? `${mine.shift.code} ${mine.shift.start_time.slice(0, 5)}-${mine.shift.end_time.slice(0, 5)}` : 'Off', candidates: out };
    }
  }

  async requestSwap(input: z.infer<typeof swapRequestInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet.');
      const me = (await this.days.employee(tx, s.employeeId))!;
      await this.authz.require('shifts:read', attrsOf(me), tx);
      if (input.workDate <= localToday(me.tz)) throw Errors.badRequest('too_late', 'Swaps can only be requested for future dates.');
      const candidates = (await this.candidates(tx, input.workDate)).candidates;
      if (!candidates.some((c) => c.employeeId === input.counterpartEmployeeId)) {
        throw Errors.badRequest('invalid_colleague', 'Choose a colleague in your department and location who works a different shift that day.');
      }
      const other = (await this.days.employee(tx, input.counterpartEmployeeId))!;
      const mine = (await this.days.plan(tx, me, input.workDate, input.workDate)).get(input.workDate)!;
      const theirs = (await this.days.plan(tx, other, input.workDate, input.workDate)).get(input.workDate)!;
      const row = await tx.collection('shift_swap_requests').insert({
        requester_employee_id: me.id,
        counterpart_employee_id: other.id,
        work_date: input.workDate,
        counterpart_date: input.workDate,
        requester_shift_id: mine.shift?.id ?? null,
        counterpart_shift_id: theirs.shift?.id ?? null,
        reason: input.reason ?? null,
        requested_by_membership_id: actor.membershipId,
      });
      await this.notifications.notify(tx, {
        membershipIds: [other.membership_id], kind: 'shift_swap.asked', title: `${me.name} asks to swap shifts with you on ${input.workDate}`,
        body: input.reason, link: '/shifts', email: true,
      });
      await this.audit.record(tx, { action: 'shift_swap.requested', resourceType: 'shift_swap', resourceId: row.id, changes: { workDate: input.workDate, counterpart: other.id } });
      return { id: row.id, status: 'awaiting_colleague' };
    });
  }

  async respondSwap(id: string, accept: boolean) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const w = await tx.collection<{ id: string; status: string; requester_employee_id: string; counterpart_employee_id: string; work_date: string; reason: string | null }>('shift_swap_requests').findOne({ id });
      if (!w) throw Errors.notFound('Swap request');
      await tx.collection('shift_swap_requests').lock({ id });
      const other = (await this.days.employee(tx, w.counterpart_employee_id))!;
      if (other.membership_id !== actor.membershipId) throw Errors.notFound('Swap request');
      if (w.status !== 'awaiting_colleague') throw Errors.conflict('invalid_state', `This swap is already ${w.status.replace('_', ' ')}`);
      const me = (await this.days.employee(tx, w.requester_employee_id))!;
      if (!accept) {
        await tx.collection('shift_swap_requests').updateOne({ id }, { $set: { status: 'declined', decided_at: new Date() } });
        await this.notifications.notify(tx, { membershipIds: [me.membership_id], kind: 'shift_swap.declined', title: `${other.name} declined your shift swap on ${w.work_date}`, link: '/shifts' });
        await this.audit.record(tx, { action: 'shift_swap.declined', resourceType: 'shift_swap', resourceId: id });
        return { id, status: 'declined' };
      }
      await tx.collection('shift_swap_requests').updateOne({ id }, { $set: { status: 'pending' } });
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'shift_swap', resourceId: id, subjectEmployeeId: me.id,
        summary: `${me.name} and ${other.name} swap shifts on ${w.work_date}${w.reason ? `. "${w.reason}"` : ''}`,
      });
      await tx.collection('shift_swap_requests').updateOne({ id }, { $set: { approval_request_id: approvalId } });
      await this.audit.record(tx, { action: 'shift_swap.accepted', resourceType: 'shift_swap', resourceId: id });
      return { id, status: 'pending' };
    });
  }

  async cancelSwap(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const w = await tx.collection('shift_swap_requests').findOne({ id });
      if (w) await tx.collection('shift_swap_requests').lock({ id });
      if (!w || w.requested_by_membership_id !== actor.membershipId) throw Errors.notFound('Swap request');
      if (!['awaiting_colleague', 'pending'].includes(w.status)) throw Errors.conflict('invalid_state', `This swap is already ${w.status}`);
      await tx.collection('shift_swap_requests').updateOne({ id }, { $set: { status: 'cancelled', decided_at: new Date() } });
      if (w.approval_request_id) await this.approvals.cancel(tx, w.approval_request_id);
      await this.audit.record(tx, { action: 'shift_swap.cancelled', resourceType: 'shift_swap', resourceId: id });
      return { id, status: 'cancelled' };
    });
  }

  private async swapApproved(tx: TenantTx, req: ApprovalRequestRow) {
    const w = await tx.collection<{ id: string; requester_employee_id: string; counterpart_employee_id: string; work_date: string; requester_shift_id: string | null; counterpart_shift_id: string | null }>(
      'shift_swap_requests',
    ).findOne({ id: req.resource_id, status: 'pending' });
    if (!w) return;
    await tx.collection('shift_swap_requests').lock({ id: w.id });
    // Both people's plans must still be what they agreed to swap.
    for (const [emp, expected] of [[w.requester_employee_id, w.requester_shift_id], [w.counterpart_employee_id, w.counterpart_shift_id]] as const) {
      const e = (await this.days.employee(tx, emp))!;
      const now = (await this.days.plan(tx, e, w.work_date, w.work_date)).get(w.work_date)!;
      if ((now.shift?.id ?? null) !== expected) throw Errors.conflict('roster_changed', `${e.name}'s shift on ${w.work_date} changed after the swap was requested. Ask them to request it again.`);
    }
    const actor = requestContext.tenantActor();
    for (const [emp, shift] of [[w.requester_employee_id, w.counterpart_shift_id], [w.counterpart_employee_id, w.requester_shift_id]] as const) {
      const values = { shift_template_id: shift ?? null, roster_id: null, source: 'swap', created_by: actor.userId };
      await tx.collection('shift_assignments').upsert({ employee_id: emp, work_date: w.work_date }, { employee_id: emp, work_date: w.work_date, ...values }, { $set: values });
    }
    await tx.collection('shift_swap_requests').updateOne({ id: w.id }, { $set: { status: 'approved', decided_at: new Date() } });
    const other = (await this.days.employee(tx, w.counterpart_employee_id))!;
    await this.notifications.notify(tx, { membershipIds: [other.membership_id], kind: 'shift_swap.approved', title: `Shift swap on ${w.work_date} approved`, link: '/shifts' });
    await this.audit.record(tx, { action: 'shift_swap.approved', resourceType: 'shift_swap', resourceId: w.id });
  }
}

function dup(err: { code?: string }): never {
  if (err.code === '23505') throw Errors.conflict('shift_exists', 'A shift with this code already exists');
  throw err;
}

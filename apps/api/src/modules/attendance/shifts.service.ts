import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { z } from 'zod';
import { zonedTime, type rosterInput, type shiftAssignmentsInput, type ShiftTemplateInput, type swapRequestInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService, type ApprovalRequestRow } from '../approvals/approvals.service';
import { EMPLOYEE_SCOPE, employeeAttrs } from '../employees/employee-attrs';
import { AttendanceDaysService, type EmployeeCtx } from './attendance-days.service';

const { addDays, localToday } = zonedTime;

const TEMPLATE_COLUMNS = `id, code, name, to_char(start_time, 'HH24:MI') as "startTime", to_char(end_time, 'HH24:MI') as "endTime", break_minutes as "breakMinutes",
  grace_late_minutes as "graceLateMinutes", grace_early_minutes as "graceEarlyMinutes", half_day_minutes as "halfDayMinutes", full_day_minutes as "fullDayMinutes",
  overtime_enabled as "overtimeEnabled", overtime_min_minutes as "overtimeMinMinutes", color, archived_at as "archivedAt"`;

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
        const r = await one<{ requester_employee_id: string }>(tx, 'select requester_employee_id from shift_swap_requests where id = $1', [id]);
        return attrsOf((await this.days.employee(tx, r!.requester_employee_id))!);
      },
      onApproved: (tx, req) => this.swapApproved(tx, req),
      onRejected: async (tx, req) => {
        await tx.query(`update shift_swap_requests set status = 'rejected', decided_at = now() where id = $1 and status = 'pending'`, [req.resource_id]);
        await this.audit.record(tx, { action: 'shift_swap.rejected', resourceType: 'shift_swap', resourceId: req.resource_id });
      },
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------------------------------------

  listTemplates(includeArchived = false) {
    return this.db.tenant((tx) => many(tx, `select ${TEMPLATE_COLUMNS} from shift_templates ${includeArchived ? '' : 'where archived_at is null'} order by start_time, code`));
  }

  createTemplate(input: ShiftTemplateInput) {
    return this.db.tenant(async (tx) => {
      const keys = Object.keys(COLUMN_OF) as (keyof ShiftTemplateInput)[];
      const row = (await one<{ id: string }>(
        tx,
        `insert into shift_templates (tenant_id, ${keys.map((k) => COLUMN_OF[k]).join(', ')}) values (app_tenant_id(), ${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
        keys.map((k) => input[k]),
      ).catch(dup))!;
      await this.audit.record(tx, { action: 'shift_template.created', resourceType: 'shift_template', resourceId: row.id, changes: input });
      return one(tx, `select ${TEMPLATE_COLUMNS} from shift_templates where id = $1`, [row.id]);
    });
  }

  updateTemplate(id: string, input: ShiftTemplateInput) {
    return this.db.tenant(async (tx) => {
      const keys = Object.keys(COLUMN_OF) as (keyof ShiftTemplateInput)[];
      const r = await tx.query(
        `update shift_templates set ${keys.map((k, i) => `${COLUMN_OF[k]} = $${i + 2}`).join(', ')} where id = $1 and archived_at is null`,
        [id, ...keys.map((k) => input[k])],
      ).catch(dup);
      if (!r.rowCount) throw Errors.notFound('Shift');
      await this.audit.record(tx, { action: 'shift_template.updated', resourceType: 'shift_template', resourceId: id, changes: input });
      return one(tx, `select ${TEMPLATE_COLUMNS} from shift_templates where id = $1`, [id]);
    });
  }

  archiveTemplate(id: string) {
    return this.db.tenant(async (tx) => {
      if (await one(tx, 'select 1 from attendance_policies where default_shift_id = $1', [id])) {
        throw Errors.conflict('shift_in_use', 'This shift is the default in an attendance policy. Choose another default first.');
      }
      const r = await tx.query('update shift_templates set archived_at = now() where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Shift');
      await this.audit.record(tx, { action: 'shift_template.archived', resourceType: 'shift_template', resourceId: id });
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Rosters and assignments
  // ---------------------------------------------------------------------------------------------------------

  listRosters() {
    return this.db.tenant((tx) =>
      many(tx, `select r.id, r.name, r.start_date as "startDate", r.end_date as "endDate", r.status, r.published_at as "publishedAt",
                       r.department_id as "departmentId", d.name as "departmentName", r.location_id as "locationId", l.name as "locationName",
                       (select count(*)::int from shift_assignments a where a.roster_id = r.id) as "assignments"
                  from rosters r left join departments d on d.id = r.department_id left join locations l on l.id = r.location_id
                 order by r.start_date desc limit 100`),
    );
  }

  createRoster(input: z.infer<typeof rosterInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const row = (await one<{ id: string }>(
        tx, `insert into rosters (tenant_id, name, start_date, end_date, department_id, location_id, created_by) values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [input.name, input.startDate, input.endDate, input.departmentId, input.locationId, actor.userId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23503') throw Errors.badRequest('invalid_reference', 'Department or location not found');
        throw err;
      }))!;
      await this.audit.record(tx, { action: 'roster.created', resourceType: 'roster', resourceId: row.id, changes: input });
      return this.roster(row.id, tx);
    });
  }

  /** A roster grid: the people it covers (that the caller can see), and each day's planned shift. */
  async roster(id: string, existingTx?: Tx) {
    const run = async (tx: Tx) => {
      const r = await one<{ id: string; name: string; start_date: string; end_date: string; status: string; department_id: string | null; location_id: string | null; published_at: string | null }>(
        tx, 'select id, name, start_date, end_date, status, department_id, location_id, published_at from rosters where id = $1', [id],
      );
      if (!r) throw Errors.notFound('Roster');
      const params: unknown[] = [r.end_date, r.start_date];
      const where = [await this.authz.predicate('shifts:read', EMPLOYEE_SCOPE, params, tx), 'e.date_of_joining <= $1', '(e.last_working_day is null or e.last_working_day >= $2)'];
      if (r.department_id) { params.push(r.department_id); where.push(`e.current_department_id = $${params.length}`); }
      if (r.location_id) { params.push(r.location_id); where.push(`e.current_location_id = $${params.length}`); }
      const people = await many<{ id: string }>(tx, `select e.id from employees e where ${where.join(' and ')} order by e.first_name, e.last_name limit 300`, params);
      const rows = [];
      for (const p of people) {
        const e = (await this.days.employee(tx, p.id))!;
        const plan = await this.days.plan(tx, e, r.start_date, r.end_date);
        const own = new Map((await many<{ work_date: string; shift_template_id: string | null }>(tx, 'select work_date, shift_template_id from shift_assignments where roster_id = $1 and employee_id = $2', [id, e.id])).map((a) => [a.work_date, a.shift_template_id]));
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
        id: r.id, name: r.name, startDate: r.start_date, endDate: r.end_date, status: r.status, publishedAt: r.published_at, departmentId: r.department_id, locationId: r.location_id,
        canEdit: await this.canManageAll(tx, people.map((p) => p.id)),
        rows,
      };
    };
    return existingTx ? run(existingTx) : this.db.tenant(run);
  }

  private async canManageAll(tx: Tx, employeeIds: string[]) {
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
        roster = await one(tx, 'select id, start_date, end_date, status from rosters where id = $1 for update', [input.rosterId]);
        if (!roster) throw Errors.notFound('Roster');
      }
      const templates = new Set((await many<{ id: string }>(tx, 'select id from shift_templates where archived_at is null')).map((t) => t.id));
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
        if ((await one<{ locked: boolean }>(tx, 'select attendance_is_locked($1, $2) as locked', [e.id, a.workDate]))!.locked) {
          throw Errors.conflict('period_locked', `${a.workDate} is in a period locked for payroll.`);
        }
        await tx.query(
          `insert into shift_assignments (tenant_id, employee_id, work_date, shift_template_id, roster_id, source, created_by)
           values (app_tenant_id(), $1, $2, $3, $4, $5, $6)
           on conflict (tenant_id, employee_id, work_date) do update set shift_template_id = excluded.shift_template_id, roster_id = excluded.roster_id, source = excluded.source, created_by = excluded.created_by`,
          [a.employeeId, a.workDate, a.shiftTemplateId, input.rosterId, input.rosterId ? 'roster' : 'manual', actor.userId],
        );
      }
      if (!roster || roster.status === 'published') await this.recomputeAssigned(tx, input.assignments);
      await this.audit.record(tx, { action: 'shift_assignments.saved', resourceType: input.rosterId ? 'roster' : 'shift_assignment', resourceId: input.rosterId ?? 'manual', metadata: { count: input.assignments.length } });
      return { saved: input.assignments.length };
    });
  }

  private async recomputeAssigned(tx: Tx, list: { employeeId: string; workDate: string }[]) {
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
      const r = await one<{ status: string; name: string; start_date: string; end_date: string }>(tx, 'select status, name, start_date, end_date from rosters where id = $1 for update', [id]);
      if (!r) throw Errors.notFound('Roster');
      if (r.status === 'published') throw Errors.conflict('already_published', 'This roster is already published');
      const people = await many<{ employee_id: string; work_date: string; membership_id: string | null }>(
        tx, `select a.employee_id, a.work_date, e.membership_id from shift_assignments a join employees e on e.id = a.employee_id where a.roster_id = $1`, [id],
      );
      for (const id2 of new Set(people.map((p) => p.employee_id))) {
        const e = (await this.days.employee(tx, id2))!;
        await this.authz.require('shifts:manage', attrsOf(e), tx);
      }
      await tx.query(`update rosters set status = 'published', published_at = now(), published_by = $2 where id = $1`, [id, actor.userId]);
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
      const r = await one<{ status: string }>(tx, 'select status from rosters where id = $1 for update', [id]);
      if (!r) throw Errors.notFound('Roster');
      if (r.status === 'published') throw Errors.conflict('roster_published', 'A published roster cannot be deleted. Change its shifts instead.');
      await tx.query('delete from rosters where id = $1', [id]);
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

  private swapsFor(tx: Tx, employeeId: string) {
    return many(
      tx,
      `select w.id, w.work_date as "workDate", w.status, w.reason, w.created_at as "createdAt",
              w.requester_employee_id as "requesterId", trim(coalesce(r.preferred_name, r.first_name) || ' ' || r.last_name) as "requesterName",
              w.counterpart_employee_id as "counterpartId", trim(coalesce(c.preferred_name, c.first_name) || ' ' || c.last_name) as "counterpartName",
              rs.code as "requesterShift", cs.code as "counterpartShift"
         from shift_swap_requests w join employees r on r.id = w.requester_employee_id join employees c on c.id = w.counterpart_employee_id
         left join shift_templates rs on rs.id = w.requester_shift_id left join shift_templates cs on cs.id = w.counterpart_shift_id
        where w.requester_employee_id = $1 or w.counterpart_employee_id = $1 order by w.created_at desc limit 50`,
      [employeeId],
    );
  }

  /** Colleagues someone could swap with on a date: same department and location, with a different shift. */
  swapCandidates(date: string) {
    return this.db.tenant((tx) => this.candidates(tx, date));
  }

  private async candidates(tx: Tx, date: string) {
    {
      const s = await this.authz.subject(tx);
      if (!s.employeeId) throw Errors.badRequest('no_employee_record', 'Your login is not linked to an employee record yet.');
      const me = (await this.days.employee(tx, s.employeeId))!;
      const mine = (await this.days.plan(tx, me, date, date)).get(date)!;
      const peers = await many<{ id: string }>(
        tx,
        `select id from employees where id <> $1 and current_department_id is not distinct from $2 and current_location_id is not distinct from $3
            and status <> 'exited' and date_of_joining <= $4 and membership_id is not null order by first_name limit 100`,
        [me.id, me.department_id, me.location_id, date],
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
      const row = (await one<{ id: string }>(
        tx,
        `insert into shift_swap_requests (tenant_id, requester_employee_id, counterpart_employee_id, work_date, counterpart_date, requester_shift_id, counterpart_shift_id, reason, requested_by_membership_id)
         values (app_tenant_id(), $1, $2, $3, $3, $4, $5, $6, $7) returning id`,
        [me.id, other.id, input.workDate, mine.shift?.id ?? null, theirs.shift?.id ?? null, input.reason ?? null, actor.membershipId],
      ))!;
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
      const w = await one<{ id: string; status: string; requester_employee_id: string; counterpart_employee_id: string; work_date: string; reason: string | null }>(
        tx, 'select * from shift_swap_requests where id = $1 for update', [id],
      );
      if (!w) throw Errors.notFound('Swap request');
      const other = (await this.days.employee(tx, w.counterpart_employee_id))!;
      if (other.membership_id !== actor.membershipId) throw Errors.notFound('Swap request');
      if (w.status !== 'awaiting_colleague') throw Errors.conflict('invalid_state', `This swap is already ${w.status.replace('_', ' ')}`);
      const me = (await this.days.employee(tx, w.requester_employee_id))!;
      if (!accept) {
        await tx.query(`update shift_swap_requests set status = 'declined', decided_at = now() where id = $1`, [id]);
        await this.notifications.notify(tx, { membershipIds: [me.membership_id], kind: 'shift_swap.declined', title: `${other.name} declined your shift swap on ${w.work_date}`, link: '/shifts' });
        await this.audit.record(tx, { action: 'shift_swap.declined', resourceType: 'shift_swap', resourceId: id });
        return { id, status: 'declined' };
      }
      await tx.query(`update shift_swap_requests set status = 'pending' where id = $1`, [id]);
      const approvalId = await this.approvals.start(tx, {
        resourceType: 'shift_swap', resourceId: id, subjectEmployeeId: me.id,
        summary: `${me.name} and ${other.name} swap shifts on ${w.work_date}${w.reason ? `. "${w.reason}"` : ''}`,
      });
      await tx.query('update shift_swap_requests set approval_request_id = $2 where id = $1', [id, approvalId]);
      await this.audit.record(tx, { action: 'shift_swap.accepted', resourceType: 'shift_swap', resourceId: id });
      return { id, status: 'pending' };
    });
  }

  async cancelSwap(id: string) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const w = await one<{ status: string; requested_by_membership_id: string | null; approval_request_id: string | null }>(tx, 'select status, requested_by_membership_id, approval_request_id from shift_swap_requests where id = $1 for update', [id]);
      if (!w || w.requested_by_membership_id !== actor.membershipId) throw Errors.notFound('Swap request');
      if (!['awaiting_colleague', 'pending'].includes(w.status)) throw Errors.conflict('invalid_state', `This swap is already ${w.status}`);
      await tx.query(`update shift_swap_requests set status = 'cancelled', decided_at = now() where id = $1`, [id]);
      if (w.approval_request_id) await this.approvals.cancel(tx, w.approval_request_id);
      await this.audit.record(tx, { action: 'shift_swap.cancelled', resourceType: 'shift_swap', resourceId: id });
      return { id, status: 'cancelled' };
    });
  }

  private async swapApproved(tx: Tx, req: ApprovalRequestRow) {
    const w = await one<{ id: string; requester_employee_id: string; counterpart_employee_id: string; work_date: string; requester_shift_id: string | null; counterpart_shift_id: string | null }>(
      tx, `select * from shift_swap_requests where id = $1 and status = 'pending' for update`, [req.resource_id],
    );
    if (!w) return;
    // Both people's plans must still be what they agreed to swap.
    for (const [emp, expected] of [[w.requester_employee_id, w.requester_shift_id], [w.counterpart_employee_id, w.counterpart_shift_id]] as const) {
      const e = (await this.days.employee(tx, emp))!;
      const now = (await this.days.plan(tx, e, w.work_date, w.work_date)).get(w.work_date)!;
      if ((now.shift?.id ?? null) !== expected) throw Errors.conflict('roster_changed', `${e.name}'s shift on ${w.work_date} changed after the swap was requested. Ask them to request it again.`);
    }
    const actor = requestContext.tenantActor();
    for (const [emp, shift] of [[w.requester_employee_id, w.counterpart_shift_id], [w.counterpart_employee_id, w.requester_shift_id]] as const) {
      await tx.query(
        `insert into shift_assignments (tenant_id, employee_id, work_date, shift_template_id, roster_id, source, created_by) values (app_tenant_id(), $1, $2, $3, null, 'swap', $4)
         on conflict (tenant_id, employee_id, work_date) do update set shift_template_id = excluded.shift_template_id, roster_id = null, source = 'swap', created_by = excluded.created_by`,
        [emp, w.work_date, shift, actor.userId],
      );
    }
    await tx.query(`update shift_swap_requests set status = 'approved', decided_at = now() where id = $1`, [w.id]);
    const other = (await this.days.employee(tx, w.counterpart_employee_id))!;
    await this.notifications.notify(tx, { membershipIds: [other.membership_id], kind: 'shift_swap.approved', title: `Shift swap on ${w.work_date} approved`, link: '/shifts' });
    await this.audit.record(tx, { action: 'shift_swap.approved', resourceType: 'shift_swap', resourceId: w.id });
  }
}

function dup(err: { code?: string }): never {
  if (err.code === '23505') throw Errors.conflict('shift_exists', 'A shift with this code already exists');
  throw err;
}

import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { money, payrollEngine, type adjustmentInput, type itemOverrideInput, type payrollRunInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttendanceDaysService } from '../attendance/attendance-days.service';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { csv, dayCount, ENTITY_SCOPE, employedDays, legalEntity, lossOfPay, monthPeriod, periodLabel, statutoryOn, type StatutoryRow } from './payroll-common';

interface RunRow {
  id: string;
  legal_entity_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  currency: string;
  status: 'draft' | 'computed' | 'pending_approval' | 'finalised' | 'cancelled';
  approval_request_id: string | null;
  created_by: string | null;
}

const RUN_COLS = `id, legal_entity_id, to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(period_end, 'YYYY-MM-DD') as period_end,
                  to_char(pay_date, 'YYYY-MM-DD') as pay_date, currency, status, approval_request_id, created_by`;

const { toMinor, fromMinor, sum } = money;

/**
 * Payroll runs: one legal entity, one calendar month. Draft, computed (any number of times), sent for approval,
 * finalised by an approver other than the preparer. Finalising freezes the run in the database, locks attendance
 * for the month, pays the included expense claims and publishes payslips.
 */
@Injectable()
export class PayrollRunsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly approvals: ApprovalsService,
    private readonly days: AttendanceDaysService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    this.approvals.register('payroll_run', {
      permission: 'payroll:approve',
      configurePermission: 'payroll:configure',
      defaultSteps: [{ type: 'role', role: 'finance_manager' }],
      fallbackRole: 'tenant_owner',
      label: 'Payroll run',
      link: (id) => `/payroll/runs/${id}`,
      attributes: async (tx, id) => ({ legalEntityId: (await this.load(tx, id)).legal_entity_id }),
      onApproved: (tx, req) => this.finalise(tx, req.resource_id),
      onRejected: async (tx, req) => {
        const r = await one<{ id: string }>(tx, `update payroll_runs set status = 'computed', approval_request_id = null, status_note = 'Sent back by the approver. Make changes, compute again and resubmit.' where id = $1 and status = 'pending_approval' returning id`, [req.resource_id]);
        if (!r) return;
        await this.audit.record(tx, { action: 'payroll_run.rejected', resourceType: 'payroll_run', resourceId: req.resource_id });
        const run = await this.load(tx, req.resource_id);
        const by = await one<{ id: string }>(tx, 'select id from memberships where user_id = $1', [run.created_by]);
        await this.notifications.notify(tx, { membershipIds: [by?.id ?? null], kind: 'payroll_run.rejected', title: `Payroll for ${periodLabel(run.period_start)} was sent back`, link: `/payroll/runs/${run.id}` });
      },
    });
  }

  private async load(tx: Tx, id: string, lock = false) {
    const r = await one<RunRow>(tx, `select ${RUN_COLS} from payroll_runs where id = $1${lock ? ' for update' : ''}`, [id]);
    if (!r) throw Errors.notFound('Payroll run');
    return r;
  }

  /** Loads a run the caller may act on with `permission` (404 when the entity is out of their scope). */
  private async access(tx: Tx, id: string, permission: string, lock = false) {
    const r = await this.load(tx, id, lock);
    await this.authz.require('payroll:read', { legalEntityId: r.legal_entity_id }, tx);
    if (permission !== 'payroll:read') await this.authz.require(permission, { legalEntityId: r.legal_entity_id }, tx);
    return r;
  }

  private editable(r: RunRow) {
    if (r.status === 'pending_approval') throw Errors.conflict('run_pending', 'This run is waiting for approval. Withdraw it to make changes.');
    if (r.status !== 'draft' && r.status !== 'computed') throw Errors.conflict('run_closed', `This run is ${r.status}`);
  }

  // Reading -------------------------------------------------------------------------------------------------

  async list(q: { legalEntityId?: string; status?: string }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [q.legalEntityId ?? null, q.status ?? null];
      const pred = await this.authz.predicate('payroll:read', ENTITY_SCOPE('r.legal_entity_id'), params, tx);
      return many(
        tx,
        `select r.id, r.legal_entity_id as "legalEntityId", le.name as "legalEntityName", to_char(r.period_start, 'YYYY-MM') as month,
                to_char(r.period_start, 'YYYY-MM-DD') as "periodStart", to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd", to_char(r.pay_date, 'YYYY-MM-DD') as "payDate",
                r.currency, r.status, r.employee_count as "employeeCount", r.gross::text, r.deductions::text, r.reimbursements::text, r.net::text,
                r.employer_contributions::text as "employerContributions", r.computed_at as "computedAt", r.finalised_at as "finalisedAt"
           from payroll_runs r join legal_entities le on le.id = r.legal_entity_id
          where ${pred} and ($1::uuid is null or r.legal_entity_id = $1) and ($2::text is null or r.status = $2)
          order by r.period_start desc, le.name limit 200`,
        params,
      );
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:read');
      const run = await one<Record<string, unknown>>(
        tx,
        `select r.id, r.legal_entity_id as "legalEntityId", le.name as "legalEntityName", to_char(r.period_start, 'YYYY-MM') as month,
                to_char(r.period_start, 'YYYY-MM-DD') as "periodStart", to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd", to_char(r.pay_date, 'YYYY-MM-DD') as "payDate",
                r.currency, r.status, r.status_note as "statusNote", r.employee_count as "employeeCount", r.gross::text, r.deductions::text,
                r.reimbursements::text, r.net::text, r.employer_contributions::text as "employerContributions", r.computed_at as "computedAt",
                r.finalised_at as "finalisedAt", r.approval_request_id as "approvalRequestId", u.full_name as "createdBy",
                to_char(s.effective_from, 'YYYY-MM-DD') as "statutoryEffectiveFrom", s.lop_source as "lopSource"
           from payroll_runs r join legal_entities le on le.id = r.legal_entity_id left join users u on u.id = r.created_by
           left join statutory_settings s on s.id = r.statutory_settings_id where r.id = $1`,
        [id],
      );
      const items = await many(
        tx,
        `select i.id, i.employee_id as "employeeId", e.employee_code as code, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name,
                d.name as "departmentName", i.status, i.hold_reason as "holdReason", i.days_in_period as "daysInPeriod", i.employed_days as "employedDays",
                i.lop_days::text as "lopDays", i.lop_override::text as "lopOverride", i.lop_override_reason as "lopOverrideReason", i.paid_days::text as "paidDays",
                i.gross::text, i.deductions::text, i.reimbursements::text, i.net::text, i.employer_contributions::text as "employerContributions", i.tds::text,
                jsonb_array_length(i.warnings) as "warningCount"
           from payroll_items i join employees e on e.id = i.employee_id left join departments d on d.id = e.current_department_id
          where i.run_id = $1 order by name`,
        [id],
      );
      const adjustments = await many(
        tx,
        `select a.id, a.employee_id as "employeeId", trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as "employeeName", a.kind, a.label,
                a.amount::text, a.taxable, a.reason, a.created_at as "createdAt"
           from payroll_adjustments a join employees e on e.id = a.employee_id where a.run_id = $1 order by a.created_at`,
        [id],
      );
      const warnings = await many<{ name: string; w: string }>(
        tx,
        `select trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, w from payroll_items i join employees e on e.id = i.employee_id,
                jsonb_array_elements_text(i.warnings) w where i.run_id = $1 order by name`,
        [id],
      );
      const runWarnings = r.status === 'draft' || r.status === 'computed' ? await this.missingSalaries(tx, r) : [];
      const s = await this.authz.subject(tx);
      const attrs = { legalEntityId: r.legal_entity_id };
      const mayRun = can(s, 'payroll:run', attrs).allowed;
      return {
        ...run,
        items,
        adjustments,
        warnings: [...runWarnings, ...warnings.map((x) => `${x.name}: ${x.w}`)],
        can: {
          compute: mayRun && (r.status === 'draft' || r.status === 'computed'),
          submit: mayRun && r.status === 'computed' && items.length > 0,
          cancel: mayRun && ['draft', 'computed', 'pending_approval'].includes(r.status),
          exportBankFile: mayRun && r.status === 'finalised',
        },
      };
    });
  }

  async item(runId: string, itemId: string) {
    return this.db.tenant(async (tx) => {
      await this.access(tx, runId, 'payroll:read');
      const i = await one(
        tx,
        `select i.id, i.employee_id as "employeeId", e.employee_code as code, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name,
                i.status, i.hold_reason as "holdReason", i.days_in_period as "daysInPeriod", i.employed_days as "employedDays", i.lop_days::text as "lopDays",
                i.lop_override::text as "lopOverride", i.lop_override_reason as "lopOverrideReason", i.paid_days::text as "paidDays", i.gross::text,
                i.deductions::text, i.reimbursements::text, i.net::text, i.employer_contributions::text as "employerContributions", i.taxable::text, i.tds::text,
                i.lines, i.explanation, i.warnings, i.inputs, i.computed_at as "computedAt"
           from payroll_items i join employees e on e.id = i.employee_id where i.id = $1 and i.run_id = $2`,
        [itemId, runId],
      );
      if (!i) throw Errors.notFound('Payroll item');
      return i;
    });
  }

  private async missingSalaries(tx: Tx, r: RunRow) {
    const rows = await many<{ name: string }>(
      tx,
      `select trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name from employees e
        where e.current_legal_entity_id = $1 and e.date_of_joining <= $3 and (e.last_working_day is null or e.last_working_day >= $2)
          and not exists (select 1 from employee_salaries s where s.employee_id = e.id and s.effective_from <= $3)
        order by name`,
      [r.legal_entity_id, r.period_start, r.period_end],
    );
    return rows.map((x) => `${x.name} has no salary for this month and is left out. Assign a salary to include them.`);
  }

  // Preparing -----------------------------------------------------------------------------------------------

  create(input: z.infer<typeof payrollRunInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('payroll:run', { legalEntityId: input.legalEntityId }, tx);
      const le = await legalEntity(tx, input.legalEntityId);
      const p = monthPeriod(input.month);
      if (input.payDate < p.start) throw Errors.badRequest('pay_date', 'The pay date cannot be before the month starts');
      const row = (await one<{ id: string }>(
        tx,
        `insert into payroll_runs (tenant_id, legal_entity_id, period_start, period_end, pay_date, currency, created_by) values (app_tenant_id(), $1, $2, $3, $4, $5, $6) returning id`,
        [input.legalEntityId, p.start, p.end, input.payDate, le.currency, actor.userId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('run_exists', `There is already a payroll run for ${le.name} for ${periodLabel(p.start)}`);
        throw err;
      }))!;
      await this.audit.record(tx, { action: 'payroll_run.created', resourceType: 'payroll_run', resourceId: row.id, changes: input });
      return row;
    });
  }

  compute(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      this.editable(r);
      const result = await this.computeIn(tx, r);
      await this.audit.record(tx, { action: 'payroll_run.computed', resourceType: 'payroll_run', resourceId: id, metadata: { employees: result.employees } });
      return result;
    });
  }

  /** (Re)computes every item of a run. Overrides and holds survive a recompute. */
  private async computeIn(tx: Tx, r: RunRow) {
    const statutory = await statutoryOn(tx, r.legal_entity_id, r.period_start);
    if (!statutory) throw Errors.conflict('statutory_missing', 'Review and save statutory settings for this legal entity first (Settings, Payroll).');
    const period = monthPeriod(r.period_start.slice(0, 7));
    const overrides = new Map(
      (await many<{ employee_id: string; status: string; hold_reason: string | null; lop_override: string | null; lop_override_reason: string | null }>(
        tx, 'select employee_id, status, hold_reason, lop_override::text, lop_override_reason from payroll_items where run_id = $1', [r.id],
      )).map((o) => [o.employee_id, o]),
    );
    await tx.query('delete from payroll_items where run_id = $1', [r.id]);
    await tx.query(`update expense_claims set payroll_run_id = null where payroll_run_id = $1 and status = 'approved'`, [r.id]);

    const people = await many<{ id: string; membership_id: string | null; date_of_joining: string; last_working_day: string | null; legal_entity_id: string; location_id: string | null; region: string | null }>(
      tx,
      `select e.id, e.membership_id, to_char(e.date_of_joining, 'YYYY-MM-DD') as date_of_joining, to_char(e.last_working_day, 'YYYY-MM-DD') as last_working_day,
              e.current_legal_entity_id as legal_entity_id, e.current_location_id as location_id, l.region
         from employees e left join locations l on l.id = e.current_location_id
        where e.current_legal_entity_id = $1 and e.date_of_joining <= $3 and (e.last_working_day is null or e.last_working_day >= $2)`,
      [r.legal_entity_id, period.start, period.end],
    );
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    let count = 0;
    for (const p of people) {
      const salary = await one<{ id: string; effective_from: string; currency: string; pf_enabled: boolean; esi_enabled: boolean; pt_enabled: boolean; tds_enabled: boolean }>(
        tx,
        `select id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, currency, pf_enabled, esi_enabled, pt_enabled, tds_enabled from employee_salaries
          where employee_id = $1 and effective_from <= $2 order by effective_from desc limit 1`,
        [p.id, period.end],
      );
      if (!salary) continue;
      count++;
      const prior = overrides.get(p.id);
      const warnings: string[] = [];
      if (salary.currency !== r.currency) warnings.push(`The salary is in ${salary.currency} but this run pays ${r.currency}. Fix the salary before finalising.`);
      if (salary.effective_from > period.start) {
        const earlier = await one(tx, 'select 1 from employee_salaries where employee_id = $1 and effective_from < $2', [p.id, salary.effective_from]);
        if (earlier) warnings.push(`The salary changed on ${salary.effective_from}; this month uses the new salary for every day. Add an adjustment if the change should be split.`);
      }
      const components = await many<{ code: string; name: string; kind: 'earning' | 'deduction'; monthly: string; prorate: boolean; taxable: boolean; pf_wage: boolean }>(
        tx,
        `select c.code, c.name, c.kind, l.monthly::text, c.prorate, c.taxable, c.pf_wage from employee_salary_lines l join pay_components c on c.id = l.component_id
          where l.salary_id = $1 order by l.position`,
        [salary.id],
      );
      const employed = employedDays(period.start, period.end, p.date_of_joining, p.last_working_day);
      const from = p.date_of_joining > period.start ? p.date_of_joining : period.start;
      const to = [period.end, yesterday, p.last_working_day ?? period.end].sort()[0]!;
      if (statutory.lop_source === 'attendance_and_leave' && to >= from) await this.days.recompute(tx, p.id, from, to);
      const lop = await lossOfPay(tx, p, from, [period.end, p.last_working_day ?? period.end].sort()[0]!, statutory.lop_source);
      if (lop.source === 'leave_only_no_attendance') warnings.push('No attendance was recorded this month; loss of pay counts unpaid leave only. Override it if that is wrong.');
      if (lop.missingPunch) warnings.push(`${lop.missingPunch} day(s) with a missing punch were not counted as loss of pay.`);
      if (period.end > yesterday) warnings.push('The month is not over yet; days after today are treated as paid.');
      const lopDays = prior?.lop_override ?? dayCount(lop.total);

      const adjustments = await many<{ kind: 'earning' | 'deduction'; label: string; amount: string; taxable: boolean }>(
        tx, 'select kind, label, amount::text, taxable from payroll_adjustments where run_id = $1 and employee_id = $2 order by created_at', [r.id, p.id],
      );
      const held = prior?.status === 'on_hold';
      const claims = held
        ? []
        : await many<{ id: string; amount: string; label: string }>(
            tx,
            `select c.id, c.amount::text, cat.name || ': ' || left(c.description, 40) as label from expense_claims c join expense_categories cat on cat.id = c.category_id
              where c.employee_id = $1 and c.status = 'approved' and c.payroll_run_id is null and c.currency = $2 and c.spent_on <= $3 order by c.spent_on`,
            [p.id, r.currency, period.end],
          );
      const ytd = await one<{ taxable: string; tds: string }>(
        tx,
        `select coalesce(sum(i.taxable), 0)::text as taxable, coalesce(sum(i.tds), 0)::text as tds from payroll_items i join payroll_runs x on x.id = i.run_id
          where i.employee_id = $1 and x.status = 'finalised' and i.status = 'included' and x.period_start >= $2 and x.period_start < $3`,
        [p.id, payrollEngine.fyStart(period.start), period.start],
      );
      const input: payrollEngine.PayrollInput = {
        currency: r.currency,
        month: period.month,
        daysInPeriod: period.days,
        employedDays: employed,
        lopDays,
        components: components.map((c) => ({ code: c.code, name: c.name, kind: c.kind, monthly: c.monthly, prorate: c.prorate, taxable: c.taxable, pfWage: c.pf_wage })),
        adjustments,
        reimbursements: claims.map((c) => ({ label: c.label, amount: c.amount })),
        statutory: statutory.settings,
        apply: { pf: salary.pf_enabled, esi: salary.esi_enabled, pt: salary.pt_enabled, tds: salary.tds_enabled, ptState: p.region?.trim() || null },
        tax: { monthsRemaining: payrollEngine.fyMonthsRemaining(period.start), ytdTaxable: ytd!.taxable, ytdTds: ytd!.tds },
      };
      const out = payrollEngine.computePay(input);
      const explanation = [...out.explanation];
      if (prior?.lop_override !== null && prior?.lop_override !== undefined) explanation.splice(1, 0, `Loss-of-pay days set by hand to ${dayCount(Number(toMinor(prior.lop_override)))} (calculated ${dayCount(lop.total)}): ${prior.lop_override_reason}.`);
      else explanation.splice(1, 0, ...lop.notes);
      const tds = out.lines.find((l) => l.code === 'TDS')?.amount ?? '0.00';
      await tx.query(
        `insert into payroll_items (tenant_id, run_id, employee_id, salary_id, status, hold_reason, days_in_period, employed_days, lop_days, lop_override, lop_override_reason,
                                    paid_days, gross, deductions, reimbursements, net, employer_contributions, taxable, tds, lines, explanation, warnings, inputs)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
        [
          r.id, p.id, salary.id, held ? 'on_hold' : 'included', held ? prior?.hold_reason : null, period.days, employed, dayCount(lop.total),
          prior?.lop_override ?? null, prior?.lop_override ? prior.lop_override_reason : null, out.paidDays, out.gross, out.deductions, out.reimbursements, out.net,
          out.employerContributions, out.taxableThisMonth, tds, JSON.stringify(out.lines), JSON.stringify(explanation), JSON.stringify([...warnings, ...out.warnings]),
          JSON.stringify({ lop, ytd, salaryId: salary.id, statutorySettingsId: statutory.id, expenseClaimIds: claims.map((c) => c.id) }),
        ],
      );
      if (claims.length) await tx.query('update expense_claims set payroll_run_id = $1 where id = any($2::uuid[])', [r.id, claims.map((c) => c.id)]);
    }
    const totals = (await one<Record<string, string>>(
      tx,
      `select count(*)::int as n, coalesce(sum(gross), 0)::text as gross, coalesce(sum(deductions), 0)::text as deductions, coalesce(sum(reimbursements), 0)::text as reimbursements,
              coalesce(sum(net), 0)::text as net, coalesce(sum(employer_contributions), 0)::text as employer
         from payroll_items where run_id = $1 and status = 'included'`,
      [r.id],
    ))!;
    await tx.query(
      `update payroll_runs set status = 'computed', statutory_settings_id = $2, employee_count = $3, gross = $4, deductions = $5, reimbursements = $6, net = $7,
              employer_contributions = $8, computed_at = now(), status_note = null where id = $1`,
      [r.id, statutory.id, totals.n, totals.gross, totals.deductions, totals.reimbursements, totals.net, totals.employer],
    );
    return { employees: count, included: Number(totals.n), gross: totals.gross, net: totals.net };
  }

  addAdjustment(id: string, input: z.infer<typeof adjustmentInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      this.editable(r);
      const e = await one<{ legal_entity_id: string | null }>(tx, 'select current_legal_entity_id as legal_entity_id from employees where id = $1', [input.employeeId]);
      if (!e || e.legal_entity_id !== r.legal_entity_id) throw Errors.badRequest('not_in_run', 'That employee is not paid by this legal entity');
      const row = (await one<{ id: string }>(
        tx,
        `insert into payroll_adjustments (tenant_id, run_id, employee_id, kind, label, amount, taxable, reason, created_by) values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [id, input.employeeId, input.kind, input.label, input.amount, input.kind === 'earning' ? input.taxable : false, input.reason, actor.userId],
      ))!;
      await this.audit.record(tx, { action: 'payroll_adjustment.added', resourceType: 'payroll_run', resourceId: id, changes: input, metadata: { adjustmentId: row.id } });
      if (r.status === 'computed') await this.computeIn(tx, r);
      return row;
    });
  }

  removeAdjustment(id: string, adjustmentId: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      this.editable(r);
      const d = await tx.query('delete from payroll_adjustments where id = $1 and run_id = $2', [adjustmentId, id]);
      if (!d.rowCount) throw Errors.notFound('Adjustment');
      await this.audit.record(tx, { action: 'payroll_adjustment.removed', resourceType: 'payroll_run', resourceId: id, metadata: { adjustmentId } });
      if (r.status === 'computed') await this.computeIn(tx, r);
    });
  }

  /** Overrides an item's loss-of-pay days or holds its pay, with a reason, and recomputes. */
  overrideItem(id: string, itemId: string, input: z.infer<typeof itemOverrideInput>) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      this.editable(r);
      const item = await one<{ employee_id: string; employed_days: number; lop_override: string | null; status: string }>(
        tx, 'select employee_id, employed_days, lop_override::text, status from payroll_items where id = $1 and run_id = $2', [itemId, id],
      );
      if (!item) throw Errors.notFound('Payroll item');
      const sets: string[] = [];
      const params: unknown[] = [itemId];
      if (input.lopDays !== undefined) {
        if (input.lopDays !== null && Number(input.lopDays) > item.employed_days) throw Errors.badRequest('lop_too_many', `At most ${item.employed_days} day(s)`);
        params.push(input.lopDays, input.lopDays === null ? null : input.reason);
        sets.push(`lop_override = $${params.length - 1}`, `lop_override_reason = $${params.length}`);
      }
      if (input.hold !== undefined) {
        params.push(input.hold ? 'on_hold' : 'included', input.hold ? input.reason : null);
        sets.push(`status = $${params.length - 1}`, `hold_reason = $${params.length}`);
      }
      if (!sets.length) throw Errors.badRequest('nothing_to_change', 'Set loss-of-pay days or the hold');
      await tx.query(`update payroll_items set ${sets.join(', ')} where id = $1`, params);
      await this.audit.record(tx, { action: 'payroll_item.overridden', resourceType: 'payroll_run', resourceId: id, changes: input, metadata: { itemId, employeeId: item.employee_id } });
      await this.computeIn(tx, r);
      return { id: (await one<{ id: string }>(tx, 'select id from payroll_items where run_id = $1 and employee_id = $2', [id, item.employee_id]))?.id };
    });
  }

  // Approval and finalisation -------------------------------------------------------------------------------

  submit(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      if (r.status !== 'computed') throw Errors.conflict('invalid_state', r.status === 'draft' ? 'Compute the run first' : `This run is ${r.status.replace('_', ' ')}`);
      // Stale inputs (an adjustment changed, leave approved since) would otherwise slip through: recompute right before submitting.
      await this.computeIn(tx, r);
      const t = (await one<{ n: number; net: string; gross: string; negative: number }>(
        tx,
        `select count(*)::int as n, coalesce(sum(net), 0)::text as net, coalesce(sum(gross), 0)::text as gross, count(*) filter (where net < 0)::int as negative
           from payroll_items where run_id = $1 and status = 'included'`,
        [id],
      ))!;
      if (!t.n) throw Errors.conflict('empty_run', 'Nobody is included in this run');
      if (t.negative) throw Errors.conflict('negative_net', `${t.negative} payslip(s) have deductions above pay. Hold them or change the adjustments.`);
      const le = await legalEntity(tx, r.legal_entity_id);
      const summary = `Payroll for ${le.name}, ${periodLabel(r.period_start)}: ${t.n} employee(s), gross ${money.formatMoney(toMinor(t.gross), r.currency)}, net pay ${money.formatMoney(toMinor(t.net), r.currency)}, paid on ${r.pay_date}.`;
      const approvalId = await this.approvals.start(tx, { resourceType: 'payroll_run', resourceId: id, subjectEmployeeId: null, summary });
      await tx.query(`update payroll_runs set status = 'pending_approval', approval_request_id = $2 where id = $1`, [id, approvalId]);
      await this.audit.record(tx, { action: 'payroll_run.submitted', resourceType: 'payroll_run', resourceId: id });
      return { status: 'pending_approval' };
    });
  }

  private async finalise(tx: Tx, id: string) {
    const r = await this.load(tx, id, true);
    if (r.status !== 'pending_approval') return;
    // Lock attendance for the month unless a lock already covers it.
    const lockedAlready = await one(
      tx,
      `select 1 from attendance_periods where unlocked_at is null and (legal_entity_id = $1 or legal_entity_id is null) and period_start <= $2 and period_end >= $3`,
      [r.legal_entity_id, r.period_start, r.period_end],
    );
    let lockId: string | null = null;
    if (!lockedAlready) {
      const overlap = await one(tx, `select 1 from attendance_periods where unlocked_at is null and (legal_entity_id = $1 or legal_entity_id is null) and daterange(period_start, period_end, '[]') && daterange($2, $3, '[]')`, [r.legal_entity_id, r.period_start, r.period_end]);
      if (!overlap) {
        lockId = (await one<{ id: string }>(
          tx,
          `insert into attendance_periods (tenant_id, legal_entity_id, period_start, period_end, note, locked_by) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
          [r.legal_entity_id, r.period_start, r.period_end, `Locked by payroll for ${periodLabel(r.period_start)}`, r.created_by],
        ))!.id;
      }
    }
    const claimIds = (await many<{ id: string }>(
      tx,
      `select c.id from expense_claims c join payroll_items i on i.employee_id = c.employee_id and i.run_id = $1 and i.status = 'included'
        where c.payroll_run_id = $1 and c.status = 'approved'`,
      [id],
    )).map((c) => c.id);
    await tx.query(`update expense_claims set payroll_run_id = null where payroll_run_id = $1 and status = 'approved' and not (id = any($2::uuid[]))`, [id, claimIds]);
    if (claimIds.length) await tx.query(`update expense_claims set status = 'paid', paid_at = now() where id = any($1::uuid[])`, [claimIds]);
    await tx.query(`update payroll_runs set status = 'finalised', finalised_at = now(), status_note = null where id = $1`, [id]);
    await this.audit.record(tx, { action: 'payroll_run.finalised', resourceType: 'payroll_run', resourceId: id, metadata: { attendanceLockId: lockId, expenseClaimsPaid: claimIds.length } });
    const people = await many<{ id: string; membership_id: string | null }>(
      tx, `select i.id, e.membership_id from payroll_items i join employees e on e.id = i.employee_id where i.run_id = $1 and i.status = 'included'`, [id],
    );
    for (const p of people) {
      if (!p.membership_id) continue;
      await this.notifications.notify(tx, { membershipIds: [p.membership_id], kind: 'payslip.published', title: `Your payslip for ${periodLabel(r.period_start)} is ready`, link: `/payslips/${p.id}` });
    }
  }

  cancel(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      if (!['draft', 'computed', 'pending_approval'].includes(r.status)) throw Errors.conflict('run_closed', `This run is ${r.status}`);
      if (r.status === 'pending_approval' && r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await tx.query(`update expense_claims set payroll_run_id = null where payroll_run_id = $1 and status = 'approved'`, [id]);
      await tx.query(`update payroll_runs set status = 'cancelled', status_note = $2 where id = $1`, [id, reason]);
      await this.audit.record(tx, { action: 'payroll_run.cancelled', resourceType: 'payroll_run', resourceId: id, metadata: { reason } });
      return { status: 'cancelled' };
    });
  }

  /** Withdraws a run from approval back to computed, so it can be changed. */
  withdraw(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      if (r.status !== 'pending_approval') throw Errors.conflict('invalid_state', 'Only a run waiting for approval can be withdrawn');
      if (r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await tx.query(`update payroll_runs set status = 'computed', approval_request_id = null where id = $1`, [id]);
      await this.audit.record(tx, { action: 'payroll_run.withdrawn', resourceType: 'payroll_run', resourceId: id });
      return { status: 'computed' };
    });
  }

  // Exports -------------------------------------------------------------------------------------------------

  /** The payroll register: one row per employee with every earning, deduction and employer contribution. */
  register(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:read');
      if (r.status === 'draft' || r.status === 'cancelled') throw Errors.conflict('not_computed', 'Compute the run first');
      const items = await many<{ code: string; name: string; status: string; paid_days: string; lop_days: string; gross: string; deductions: string; reimbursements: string; net: string; employer_contributions: string; lines: payrollEngine.PayLine[] }>(
        tx,
        `select e.employee_code as code, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, i.status, i.paid_days::text,
                coalesce(i.lop_override, i.lop_days)::text as lop_days, i.gross::text, i.deductions::text, i.reimbursements::text, i.net::text,
                i.employer_contributions::text, i.lines
           from payroll_items i join employees e on e.id = i.employee_id where i.run_id = $1 order by e.employee_code`,
        [id],
      );
      const cols = new Map<string, string>();
      for (const i of items) for (const l of i.lines) if (!l.code.startsWith('ADJ') && !l.code.startsWith('REIMB')) cols.set(l.code, l.name);
      const codes = [...cols.keys()];
      const rows: unknown[][] = [['Employee code', 'Name', 'Status', 'Paid days', 'Loss-of-pay days', ...codes.map((c) => cols.get(c)), 'Adjustments (earnings)', 'Adjustments (deductions)', 'Gross', 'Deductions', 'Reimbursements', 'Net pay', 'Employer contributions']];
      for (const i of items) {
        const by = (code: string) => fromMinor(sum(i.lines.filter((l) => l.code === code).map((l) => toMinor(l.amount))));
        const adj = (kind: string) => fromMinor(sum(i.lines.filter((l) => l.code.startsWith('ADJ') && l.kind === kind).map((l) => toMinor(l.amount))));
        rows.push([i.code, i.name, i.status === 'on_hold' ? 'On hold' : 'Included', i.paid_days, i.lop_days, ...codes.map(by), adj('earning'), adj('deduction'), i.gross, i.deductions, i.reimbursements, i.net, i.employer_contributions]);
      }
      await this.audit.record(tx, { action: 'payroll_run.register_exported', resourceType: 'payroll_run', resourceId: id, metadata: { rows: items.length } });
      return { fileName: `payroll-register-${r.period_start.slice(0, 7)}.csv`, content: csv(rows) };
    });
  }

  /**
   * A bank transfer file for a finalised run: a plain CSV of beneficiary, account, IFSC/routing and amount for
   * each included employee. Account numbers are decrypted for this export only, and every export is audited.
   * Formats specific to a bank are not generated; payroll admins upload this file or map it in their bank portal.
   */
  bankFile(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run');
      if (r.status !== 'finalised') throw Errors.conflict('not_finalised', 'The bank file is available once the run is finalised');
      const rows = await many<{ code: string; name: string; net: string; bank_name: string | null; bank_account_enc: string | null; bank_routing_enc: string | null }>(
        tx,
        `select e.employee_code as code, trim(e.first_name || ' ' || e.last_name) as name, i.net::text, s.bank_name, s.bank_account_enc, s.bank_routing_enc
           from payroll_items i join employees e on e.id = i.employee_id left join employee_sensitive s on s.employee_id = e.id
          where i.run_id = $1 and i.status = 'included' and i.net > 0 order by e.employee_code`,
        [id],
      );
      const key = this.config.FIELD_ENCRYPTION_KEY;
      const out: unknown[][] = [['Employee code', 'Beneficiary name', 'Bank', 'Account number', 'IFSC / routing', 'Amount', 'Currency', 'Reference']];
      const missing: string[] = [];
      for (const x of rows) {
        if (!x.bank_account_enc) missing.push(x.code);
        out.push([x.code, x.name, x.bank_name ?? '', x.bank_account_enc ? decryptField(x.bank_account_enc, key) : 'MISSING', x.bank_routing_enc ? decryptField(x.bank_routing_enc, key) : '', x.net, r.currency, `SALARY ${r.period_start.slice(0, 7)}`]);
      }
      await this.audit.record(tx, { action: 'payroll_run.bank_file_exported', resourceType: 'payroll_run', resourceId: id, metadata: { rows: rows.length, missingBankDetails: missing } });
      return { fileName: `bank-transfer-${r.period_start.slice(0, 7)}.csv`, content: csv(out), missingBankDetails: missing };
    });
  }

  /** Who is in scope, for pickers (adjustments). */
  async employeesForRun(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:read');
      const params: unknown[] = [r.legal_entity_id];
      const pred = await this.authz.predicate('payroll:read', EMPLOYEE_SCOPE, params, tx);
      return many(tx, `select e.id, e.employee_code as code, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name from employees e
                        where e.current_legal_entity_id = $1 and e.status <> 'exited' and ${pred} order by name`, params);
    });
  }
}

export type { StatutoryRow };

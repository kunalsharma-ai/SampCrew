import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { money, payrollEngine, type adjustmentInput, type itemOverrideInput, type payrollRunInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { decryptField } from '../../platform/auth/crypto';
import { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { OutboxService } from '../../platform/events/outbox.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AttendanceDaysService } from '../attendance/attendance-days.service';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, employeeNames, fieldById } from '../employees/employee-view';
import { csv, dayCount, ENTITY_FIELDS, employedDays, legalEntity, lossOfPay, monthPeriod, periodLabel, statutoryOn, type StatutoryRow } from './payroll-common';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const runRow = (d: Doc): RunRow => ({
  id: d.id, legal_entity_id: d.legal_entity_id, period_start: d.period_start, period_end: d.period_end, pay_date: d.pay_date, currency: d.currency,
  status: d.status, approval_request_id: d.approval_request_id ?? null, created_by: d.created_by ?? null,
});

const { toMinor, fromMinor, sum } = money;

/** The exact total of a decimal field over rows, as "1234.50". */
const total = (rows: Doc[], field: string) => fromMinor(sum(rows.map((x) => toMinor(String(x[field] ?? '0')))));

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
    private readonly outbox: OutboxService,
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
        const n = await tx.collection('payroll_runs').updateOne(
          { id: req.resource_id, status: 'pending_approval' },
          { $set: { status: 'computed', approval_request_id: null, status_note: 'Sent back by the approver. Make changes, compute again and resubmit.' } },
        );
        if (!n) return;
        await this.audit.record(tx, { action: 'payroll_run.rejected', resourceType: 'payroll_run', resourceId: req.resource_id });
        const run = await this.load(tx, req.resource_id);
        const by = run.created_by ? await tx.collection('memberships').findOne({ user_id: run.created_by }) : undefined;
        await this.notifications.notify(tx, { membershipIds: [by?.id ?? null], kind: 'payroll_run.rejected', title: `Payroll for ${periodLabel(run.period_start)} was sent back`, link: `/payroll/runs/${run.id}` });
      },
    });
  }

  private async load(tx: TenantTx, id: string, lock = false) {
    const runs = tx.collection('payroll_runs');
    if (lock && !(await runs.lock({ id }))) throw Errors.notFound('Payroll run');
    const r = await runs.findOne({ id });
    if (!r) throw Errors.notFound('Payroll run');
    return runRow(r);
  }

  /** Loads a run the caller may act on with `permission` (404 when the entity is out of their scope). */
  private async access(tx: TenantTx, id: string, permission: string, lock = false) {
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
      const scope = await this.authz.filter('payroll:read', ENTITY_FIELDS('legal_entity_id'), tx);
      const runs = await tx.collection('payroll_runs').find({ $and: [scope, q.legalEntityId ? { legal_entity_id: q.legalEntityId } : {}, q.status ? { status: q.status } : {}] });
      const entities = await fieldById(tx, 'legal_entities', runs.map((x) => x.legal_entity_id));
      return runs
        .map((x) => ({
          id: x.id, legalEntityId: x.legal_entity_id, legalEntityName: entities.get(x.legal_entity_id) ?? null, month: (x.period_start as string).slice(0, 7),
          periodStart: x.period_start, periodEnd: x.period_end, payDate: x.pay_date, currency: x.currency, status: x.status, employeeCount: x.employee_count,
          gross: x.gross, deductions: x.deductions, reimbursements: x.reimbursements, net: x.net, employerContributions: x.employer_contributions,
          computedAt: x.computed_at ?? null, finalisedAt: x.finalised_at ?? null,
        }))
        .sort((a, b) => b.periodStart.localeCompare(a.periodStart) || String(a.legalEntityName).localeCompare(String(b.legalEntityName)))
        .slice(0, 200);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:read');
      const x = (await tx.collection('payroll_runs').findOne({ id }))!;
      const le = await tx.collection('legal_entities').findOne({ id: x.legal_entity_id });
      const creator = x.created_by ? await (await usersTable(tx)).findOne({ id: x.created_by }, { projection: { full_name: 1 } }) : undefined;
      const st = x.statutory_settings_id ? await tx.collection('statutory_settings').findOne({ id: x.statutory_settings_id }) : undefined;
      const run = {
        id: x.id, legalEntityId: x.legal_entity_id, legalEntityName: le?.name ?? null, month: (x.period_start as string).slice(0, 7), periodStart: x.period_start,
        periodEnd: x.period_end, payDate: x.pay_date, currency: x.currency, status: x.status, statusNote: x.status_note ?? null, employeeCount: x.employee_count,
        gross: x.gross, deductions: x.deductions, reimbursements: x.reimbursements, net: x.net, employerContributions: x.employer_contributions,
        computedAt: x.computed_at ?? null, finalisedAt: x.finalised_at ?? null, approvalRequestId: x.approval_request_id ?? null, createdBy: creator?.full_name ?? null,
        statutoryEffectiveFrom: st?.effective_from ?? null, lopSource: st?.lop_source ?? null,
      };
      const docs = await tx.collection('payroll_items').find({ run_id: id });
      const emps = await employeeNames(tx, docs.map((i) => i.employee_id));
      const departments = await fieldById(tx, 'departments', [...emps.values()].map((e) => e.doc.current_department_id));
      const nameOf = (employeeId: string) => emps.get(employeeId)?.name ?? '';
      const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      const items = docs
        .map((i) => {
          const e = emps.get(i.employee_id);
          return {
            id: i.id, employeeId: i.employee_id, code: e?.doc.employee_code ?? null, name: nameOf(i.employee_id), departmentName: departments.get(e?.doc.current_department_id) ?? null,
            status: i.status, holdReason: i.hold_reason ?? null, daysInPeriod: i.days_in_period, employedDays: i.employed_days, lopDays: i.lop_days,
            lopOverride: i.lop_override ?? null, lopOverrideReason: i.lop_override_reason ?? null, paidDays: i.paid_days, gross: i.gross, deductions: i.deductions,
            reimbursements: i.reimbursements, net: i.net, employerContributions: i.employer_contributions, tds: i.tds, warningCount: (i.warnings as unknown[]).length,
          };
        })
        .sort(byName);
      const adjDocs = await tx.collection('payroll_adjustments').find({ run_id: id }, { sort: { created_at: 1 } });
      const adjNames = await employeeNames(tx, adjDocs.map((a) => a.employee_id));
      const adjustments = adjDocs.map((a) => ({
        id: a.id, employeeId: a.employee_id, employeeName: adjNames.get(a.employee_id)?.name ?? null, kind: a.kind, label: a.label, amount: a.amount,
        taxable: a.taxable, reason: a.reason, createdAt: a.created_at,
      }));
      const warnings = docs.flatMap((i) => (i.warnings as string[]).map((w) => ({ name: nameOf(i.employee_id), w }))).sort(byName);
      const runWarnings = r.status === 'draft' || r.status === 'computed' ? await this.missingSalaries(tx, r) : [];
      const s = await this.authz.subject(tx);
      const attrs = { legalEntityId: r.legal_entity_id };
      const mayRun = can(s, 'payroll:run', attrs).allowed;
      return {
        ...run,
        items,
        adjustments,
        warnings: [...runWarnings, ...groupWarnings(warnings)],
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
      const d = await tx.collection('payroll_items').findOne({ id: itemId, run_id: runId });
      const e = d ? await tx.collection('employees').findOne({ id: d.employee_id }) : undefined;
      const i = d && {
        id: d.id, employeeId: d.employee_id, code: e?.employee_code ?? null, name: e ? displayName(e as never) : null, status: d.status, holdReason: d.hold_reason ?? null,
        daysInPeriod: d.days_in_period, employedDays: d.employed_days, lopDays: d.lop_days, lopOverride: d.lop_override ?? null, lopOverrideReason: d.lop_override_reason ?? null,
        paidDays: d.paid_days, gross: d.gross, deductions: d.deductions, reimbursements: d.reimbursements, net: d.net, employerContributions: d.employer_contributions,
        taxable: d.taxable, tds: d.tds, lines: d.lines, explanation: d.explanation, warnings: d.warnings, inputs: d.inputs, computedAt: d.computed_at,
      };
      if (!i) throw Errors.notFound('Payroll item');
      return i;
    });
  }

  private async missingSalaries(tx: TenantTx, r: RunRow) {
    const emps = await this.inPeriod(tx, r.legal_entity_id, r.period_start, r.period_end);
    const paid = new Set(await tx.collection('employee_salaries').distinct<string>('employee_id', { employee_id: { $in: emps.map((e) => e.id) }, effective_from: { $lte: r.period_end } }));
    const names = emps.filter((e) => !paid.has(e.id)).map((e) => displayName(e as never)).sort();
    return names.map((name) => `${name} has no salary for this month and is left out. Assign a salary to include them.`);
  }

  /** Employees of a legal entity employed at some point in [start, end]. */
  private inPeriod(tx: TenantTx, legalEntityId: string, start: string, end: string) {
    return tx.collection('employees').find({ current_legal_entity_id: legalEntityId, date_of_joining: { $lte: end }, $or: [{ last_working_day: null }, { last_working_day: { $gte: start } }] });
  }

  // Preparing -----------------------------------------------------------------------------------------------

  create(input: z.infer<typeof payrollRunInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('payroll:run', { legalEntityId: input.legalEntityId }, tx);
      const le = await legalEntity(tx, input.legalEntityId);
      const p = monthPeriod(input.month);
      if (input.payDate < p.start) throw Errors.badRequest('pay_date', 'The pay date cannot be before the month starts');
      const inserted = await tx.collection('payroll_runs')
        .insert({ legal_entity_id: input.legalEntityId, period_start: p.start, period_end: p.end, pay_date: input.payDate, currency: le.currency, created_by: actor.userId })
        .catch((err: { code?: string }) => {
          if (err.code === '23505') throw Errors.conflict('run_exists', `There is already a payroll run for ${le.name} for ${periodLabel(p.start)}`);
          throw err;
        });
      const row = { id: inserted.id as string };
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
  private async computeIn(tx: TenantTx, r: RunRow) {
    const statutory = await statutoryOn(tx, r.legal_entity_id, r.period_start);
    if (!statutory) throw Errors.conflict('statutory_missing', 'Review and save statutory settings for this legal entity first (Settings, Payroll).');
    const period = monthPeriod(r.period_start.slice(0, 7));
    const items = tx.collection('payroll_items');
    const claimsTable = tx.collection('expense_claims');
    const overrides = new Map(
      (await items.find({ run_id: r.id })).map((o) => [
        o.employee_id as string,
        { employee_id: o.employee_id as string, status: o.status as string, hold_reason: (o.hold_reason ?? null) as string | null, lop_override: (o.lop_override ?? null) as string | null, lop_override_reason: (o.lop_override_reason ?? null) as string | null },
      ]),
    );
    await items.delete({ run_id: r.id });
    await claimsTable.update({ payroll_run_id: r.id, status: 'approved' }, { $set: { payroll_run_id: null } });

    const emps = await this.inPeriod(tx, r.legal_entity_id, period.start, period.end);
    const regions = await fieldById(tx, 'locations', emps.map((e) => e.current_location_id), 'region');
    const people = emps.map((e) => ({
      id: e.id as string, membership_id: (e.membership_id ?? null) as string | null, date_of_joining: e.date_of_joining as string, last_working_day: (e.last_working_day ?? null) as string | null,
      legal_entity_id: e.current_legal_entity_id as string, location_id: (e.current_location_id ?? null) as string | null, region: (e.current_location_id ? regions.get(e.current_location_id) : null) ?? null,
    }));
    const categoryNames = new Map((await tx.collection('expense_categories').find({})).map((c) => [c.id as string, c.name as string]));
    const ytdRuns = await tx.collection('payroll_runs').distinct<string>('id', { status: 'finalised', period_start: { $gte: payrollEngine.fyStart(period.start), $lt: period.start } });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    let count = 0;
    for (const p of people) {
      const salary = await tx.collection<{ id: string; effective_from: string; currency: string; pf_enabled: boolean; esi_enabled: boolean; pt_enabled: boolean; tds_enabled: boolean }>('employee_salaries')
        .findOne({ employee_id: p.id, effective_from: { $lte: period.end } }, { sort: { effective_from: -1 } });
      if (!salary) continue;
      count++;
      const prior = overrides.get(p.id);
      const warnings: string[] = [];
      if (salary.currency !== r.currency) warnings.push(`The salary is in ${salary.currency} but this run pays ${r.currency}. Fix the salary before finalising.`);
      if (salary.effective_from > period.start) {
        const earlier = await tx.collection('employee_salaries').exists({ employee_id: p.id, effective_from: { $lt: salary.effective_from } });
        if (earlier) warnings.push(`The salary changed on ${salary.effective_from}; this month uses the new salary for every day. Add an adjustment if the change should be split.`);
      }
      const salaryLines = await tx.collection('employee_salary_lines').find({ salary_id: salary.id }, { sort: { position: 1 } });
      const comps = new Map((await tx.collection('pay_components').find({ id: { $in: salaryLines.map((l) => l.component_id) } })).map((c) => [c.id as string, c]));
      const components = salaryLines.map((l) => {
        const c = comps.get(l.component_id)!;
        return { code: c.code as string, name: c.name as string, kind: c.kind as 'earning' | 'deduction', monthly: l.monthly as string, prorate: c.prorate as boolean, taxable: c.taxable as boolean, pf_wage: c.pf_wage as boolean };
      });
      const employed = employedDays(period.start, period.end, p.date_of_joining, p.last_working_day);
      const from = p.date_of_joining > period.start ? p.date_of_joining : period.start;
      const to = [period.end, yesterday, p.last_working_day ?? period.end].sort()[0]!;
      if (statutory.lop_source === 'attendance_and_leave' && to >= from) await this.days.recompute(tx, p.id, from, to);
      const lop = await lossOfPay(tx, p, from, [period.end, p.last_working_day ?? period.end].sort()[0]!, statutory.lop_source);
      if (lop.source === 'leave_only_no_attendance') warnings.push('No attendance was recorded this month; loss of pay counts unpaid leave only. Override it if that is wrong.');
      if (lop.missingPunch) warnings.push(`${lop.missingPunch} day(s) with a missing punch were not counted as loss of pay.`);
      if (period.end > yesterday) warnings.push('The month is not over yet; days after today are treated as paid.');
      const lopDays = prior?.lop_override ?? dayCount(lop.total);

      const adjustments = (await tx.collection('payroll_adjustments').find({ run_id: r.id, employee_id: p.id }, { sort: { created_at: 1 } })).map((a) => ({
        kind: a.kind as 'earning' | 'deduction', label: a.label as string, amount: a.amount as string, taxable: a.taxable as boolean,
      }));
      const held = prior?.status === 'on_hold';
      const claims = held
        ? []
        : (await claimsTable.find({ employee_id: p.id, status: 'approved', payroll_run_id: null, currency: r.currency, spent_on: { $lte: period.end } }, { sort: { spent_on: 1 } })).map((c) => {
            const d = c.description as string;
            return { id: c.id as string, amount: c.amount as string, label: `${categoryNames.get(c.category_id) ?? ''}: ${d.length > 60 ? d.slice(0, 59) + '…' : d}` };
          });
      const ytdItems = await items.find({ employee_id: p.id, status: 'included', run_id: { $in: ytdRuns } }, { projection: { taxable: 1, tds: 1 } });
      const ytd = { taxable: total(ytdItems, 'taxable'), tds: total(ytdItems, 'tds') };
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
      await items.insert({
        run_id: r.id, employee_id: p.id, salary_id: salary.id, status: held ? 'on_hold' : 'included', hold_reason: held ? (prior?.hold_reason ?? null) : null,
        days_in_period: period.days, employed_days: employed, lop_days: dayCount(lop.total), lop_override: prior?.lop_override ?? null,
        lop_override_reason: prior?.lop_override ? prior.lop_override_reason : null, paid_days: out.paidDays, gross: out.gross, deductions: out.deductions,
        reimbursements: out.reimbursements, net: out.net, employer_contributions: out.employerContributions, taxable: out.taxableThisMonth, tds,
        lines: out.lines, explanation, warnings: [...warnings, ...out.warnings],
        inputs: { lop, ytd, salaryId: salary.id, statutorySettingsId: statutory.id, expenseClaimIds: claims.map((c) => c.id) },
      });
      if (claims.length) await claimsTable.update({ id: { $in: claims.map((c) => c.id) } }, { $set: { payroll_run_id: r.id } });
    }
    const included = await items.find({ run_id: r.id, status: 'included' });
    const totals = {
      n: included.length, gross: total(included, 'gross'), deductions: total(included, 'deductions'), reimbursements: total(included, 'reimbursements'),
      net: total(included, 'net'), employer: total(included, 'employer_contributions'),
    };
    await tx.collection('payroll_runs').updateOne({ id: r.id }, {
      $set: {
        status: 'computed', statutory_settings_id: statutory.id, employee_count: totals.n, gross: totals.gross, deductions: totals.deductions,
        reimbursements: totals.reimbursements, net: totals.net, employer_contributions: totals.employer, computed_at: new Date(), status_note: null,
      },
    });
    return { employees: count, included: Number(totals.n), gross: totals.gross, net: totals.net };
  }

  addAdjustment(id: string, input: z.infer<typeof adjustmentInput>) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      this.editable(r);
      const e = await tx.collection('employees').findOne({ id: input.employeeId });
      if (!e || e.current_legal_entity_id !== r.legal_entity_id) throw Errors.badRequest('not_in_run', 'That employee is not paid by this legal entity');
      const adj = await tx.collection('payroll_adjustments').insert({
        run_id: id, employee_id: input.employeeId, kind: input.kind, label: input.label, amount: input.amount,
        taxable: input.kind === 'earning' ? input.taxable : false, reason: input.reason, created_by: actor.userId,
      });
      const row = { id: adj.id as string };
      await this.audit.record(tx, { action: 'payroll_adjustment.added', resourceType: 'payroll_run', resourceId: id, changes: input, metadata: { adjustmentId: row.id } });
      if (r.status === 'computed') await this.computeIn(tx, r);
      return row;
    });
  }

  removeAdjustment(id: string, adjustmentId: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      this.editable(r);
      if (!(await tx.collection('payroll_adjustments').deleteOne({ id: adjustmentId, run_id: id }))) throw Errors.notFound('Adjustment');
      await this.audit.record(tx, { action: 'payroll_adjustment.removed', resourceType: 'payroll_run', resourceId: id, metadata: { adjustmentId } });
      if (r.status === 'computed') await this.computeIn(tx, r);
    });
  }

  /** Overrides an item's loss-of-pay days or holds its pay, with a reason, and recomputes. */
  overrideItem(id: string, itemId: string, input: z.infer<typeof itemOverrideInput>) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      this.editable(r);
      const items = tx.collection('payroll_items');
      const item = await items.findOne({ id: itemId, run_id: id });
      if (!item) throw Errors.notFound('Payroll item');
      const set: Doc = {};
      if (input.lopDays !== undefined) {
        if (input.lopDays !== null && Number(input.lopDays) > item.employed_days) throw Errors.badRequest('lop_too_many', `At most ${item.employed_days} day(s)`);
        set.lop_override = input.lopDays;
        set.lop_override_reason = input.lopDays === null ? null : input.reason;
      }
      if (input.hold !== undefined) {
        set.status = input.hold ? 'on_hold' : 'included';
        set.hold_reason = input.hold ? input.reason : null;
      }
      if (!Object.keys(set).length) throw Errors.badRequest('nothing_to_change', 'Set loss-of-pay days or the hold');
      await items.updateOne({ id: itemId }, { $set: set });
      await this.audit.record(tx, { action: 'payroll_item.overridden', resourceType: 'payroll_run', resourceId: id, changes: input, metadata: { itemId, employeeId: item.employee_id } });
      await this.computeIn(tx, r);
      return { id: (await items.findOne({ run_id: id, employee_id: item.employee_id }))?.id };
    });
  }

  // Approval and finalisation -------------------------------------------------------------------------------

  submit(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await this.access(tx, id, 'payroll:run', true);
      if (r.status !== 'computed') throw Errors.conflict('invalid_state', r.status === 'draft' ? 'Compute the run first' : `This run is ${r.status.replace('_', ' ')}`);
      // Stale inputs (an adjustment changed, leave approved since) would otherwise slip through: recompute right before submitting.
      await this.computeIn(tx, r);
      const included = await tx.collection('payroll_items').find({ run_id: id, status: 'included' }, { projection: { net: 1, gross: 1 } });
      const t = { n: included.length, net: total(included, 'net'), gross: total(included, 'gross'), negative: included.filter((i) => toMinor(i.net) < 0n).length };
      if (!t.n) throw Errors.conflict('empty_run', 'Nobody is included in this run');
      if (t.negative) throw Errors.conflict('negative_net', `${t.negative} payslip(s) have deductions above pay. Hold them or change the adjustments.`);
      const le = await legalEntity(tx, r.legal_entity_id);
      const summary = `Payroll for ${le.name}, ${periodLabel(r.period_start)}: ${t.n} employee(s), gross ${money.formatMoney(toMinor(t.gross), r.currency)}, net pay ${money.formatMoney(toMinor(t.net), r.currency)}, paid on ${r.pay_date}.`;
      const approvalId = await this.approvals.start(tx, { resourceType: 'payroll_run', resourceId: id, subjectEmployeeId: null, summary });
      await tx.collection('payroll_runs').updateOne({ id }, { $set: { status: 'pending_approval', approval_request_id: approvalId } });
      await this.audit.record(tx, { action: 'payroll_run.submitted', resourceType: 'payroll_run', resourceId: id });
      return { status: 'pending_approval' };
    });
  }

  private async finalise(tx: TenantTx, id: string) {
    const r = await this.load(tx, id, true);
    if (r.status !== 'pending_approval') return;
    // Lock attendance for the month unless a lock already covers it.
    const periods = tx.collection('attendance_periods');
    const sameEntity = { unlocked_at: null, $or: [{ legal_entity_id: r.legal_entity_id }, { legal_entity_id: null }] };
    const lockedAlready = await periods.exists({ ...sameEntity, period_start: { $lte: r.period_start }, period_end: { $gte: r.period_end } });
    let lockId: string | null = null;
    if (!lockedAlready) {
      const overlap = await periods.exists({ ...sameEntity, period_start: { $lte: r.period_end }, period_end: { $gte: r.period_start } });
      if (!overlap) {
        lockId = (await periods.insert({ legal_entity_id: r.legal_entity_id, period_start: r.period_start, period_end: r.period_end, note: `Locked by payroll for ${periodLabel(r.period_start)}`, locked_by: r.created_by })).id as string;
      }
    }
    const paidEmployees = await tx.collection('payroll_items').distinct<string>('employee_id', { run_id: id, status: 'included' });
    const claims = tx.collection('expense_claims');
    const claimIds = await claims.distinct<string>('id', { payroll_run_id: id, status: 'approved', employee_id: { $in: paidEmployees } });
    await claims.update({ payroll_run_id: id, status: 'approved', id: { $nin: claimIds } }, { $set: { payroll_run_id: null } });
    if (claimIds.length) await claims.update({ id: { $in: claimIds } }, { $set: { status: 'paid', paid_at: new Date() } });
    await tx.collection('payroll_runs').updateOne({ id }, { $set: { status: 'finalised', finalised_at: new Date(), status_note: null } });
    await this.audit.record(tx, { action: 'payroll_run.finalised', resourceType: 'payroll_run', resourceId: id, metadata: { attendanceLockId: lockId, expenseClaimsPaid: claimIds.length } });
    await this.outbox.publish(tx, tx.tenantId, 'payroll.run_finalised', { runId: id, legalEntityId: r.legal_entity_id, periodStart: String(r.period_start).slice(0, 10), periodEnd: String(r.period_end).slice(0, 10) });
    const paidItems = await tx.collection('payroll_items').find({ run_id: id, status: 'included' }, { projection: { employee_id: 1 } });
    const logins = await employeeNames(tx, paidItems.map((i) => i.employee_id));
    const people = paidItems.map((i) => ({ id: i.id as string, membership_id: logins.get(i.employee_id)?.membershipId ?? null }));
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
      await tx.collection('expense_claims').update({ payroll_run_id: id, status: 'approved' }, { $set: { payroll_run_id: null } });
      await tx.collection('payroll_runs').updateOne({ id }, { $set: { status: 'cancelled', status_note: reason } });
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
      await tx.collection('payroll_runs').updateOne({ id }, { $set: { status: 'computed', approval_request_id: null } });
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
      const docs = await tx.collection('payroll_items').find({ run_id: id });
      const emps = await employeeNames(tx, docs.map((i) => i.employee_id));
      const items = docs
        .map((i) => ({
          code: emps.get(i.employee_id)?.doc.employee_code as string, name: emps.get(i.employee_id)?.name ?? '', status: i.status as string, paid_days: i.paid_days as string,
          lop_days: (i.lop_override ?? i.lop_days) as string, gross: i.gross as string, deductions: i.deductions as string, reimbursements: i.reimbursements as string,
          net: i.net as string, employer_contributions: i.employer_contributions as string, lines: i.lines as payrollEngine.PayLine[],
        }))
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
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
      const paid = (await tx.collection('payroll_items').find({ run_id: id, status: 'included' })).filter((i) => toMinor(i.net) > 0n);
      const emps = await employeeNames(tx, paid.map((i) => i.employee_id));
      const sensitive = new Map((await tx.collection('employee_sensitive').find({ employee_id: { $in: paid.map((i) => i.employee_id) } })).map((x) => [x.employee_id as string, x]));
      const rows = paid
        .map((i) => {
          const e = emps.get(i.employee_id)!.doc;
          const x = sensitive.get(i.employee_id);
          return {
            code: e.employee_code as string, name: `${e.first_name} ${e.last_name ?? ''}`.trim(), net: i.net as string, bank_name: (x?.bank_name ?? null) as string | null,
            bank_account_enc: (x?.bank_account_enc ?? null) as string | null, bank_routing_enc: (x?.bank_routing_enc ?? null) as string | null,
          };
        })
        .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      const key = this.config.fieldKeys;
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
      const scope = await this.authz.filter('payroll:read', EMPLOYEE_FIELDS, tx);
      return (await tx.collection('employees').find({ $and: [scope, { current_legal_entity_id: r.legal_entity_id, status: { $ne: 'exited' } }] }))
        .map((e) => ({ id: e.id, code: e.employee_code, name: displayName(e as never) }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }
}

export type { StatutoryRow };

/** The same warning for many people reads as one line with their names. */
function groupWarnings(rows: { name: string; w: string }[]) {
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.w, [...(by.get(r.w) ?? []), r.name]);
  return [...by.entries()].map(([w, names]) => (names.length === 1 ? `${names[0]}: ${w}` : `${names.length} people (${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}): ${w}`));
}

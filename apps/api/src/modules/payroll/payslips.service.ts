import { Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_FIELDS } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
import { money, payrollEngine } from '@crew/contracts';
import { attrsOf, payrollEmployee } from './salaries.service';

/** Payslips are the included items of finalised runs. People see their own; payroll and HR see the ones in their scope. */
@Injectable()
export class PayslipsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  async list(q: { employeeId?: string; mine?: boolean }) {
    return this.db.tenant(async (tx) => {
      const s = await this.authz.subject(tx);
      const employeeId = q.mine ? s.employeeId : q.employeeId;
      if (q.mine && !employeeId) return [];
      const scope = await this.authz.filter('payslips:read', EMPLOYEE_FIELDS, tx);
      const emps = new Map((await tx.collection('employees').find({ $and: [scope, employeeId ? { id: employeeId } : {}] })).map((e) => [e.id as string, e]));
      const runs = new Map((await tx.collection('payroll_runs').find({ status: 'finalised' })).map((x) => [x.id as string, x]));
      const items = await tx.collection('payroll_items').find({ status: 'included', run_id: { $in: [...runs.keys()] }, employee_id: { $in: [...emps.keys()] } });
      const entities = await fieldById(tx, 'legal_entities', [...runs.values()].map((x) => x.legal_entity_id));
      return items
        .map((i) => {
          const run = runs.get(i.run_id)!;
          const e = emps.get(i.employee_id)!;
          return {
            id: i.id, employeeId: i.employee_id, code: e.employee_code, name: displayName(e as never), month: (run.period_start as string).slice(0, 7), payDate: run.pay_date,
            legalEntityName: entities.get(run.legal_entity_id) ?? null, currency: run.currency, gross: i.gross, deductions: i.deductions, reimbursements: i.reimbursements, net: i.net,
          };
        })
        .sort((a, b) => b.month.localeCompare(a.month) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, 500);
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const item = await tx.collection('payroll_items').findOne({ id, status: 'included' });
      const run = item ? await tx.collection('payroll_runs').findOne({ id: item.run_id, status: 'finalised' }) : undefined;
      const emp = run ? await tx.collection('employees').findOne({ id: item!.employee_id }) : undefined;
      let p: ({ employee_id: string; period_start: string } & Record<string, unknown>) | undefined;
      if (item && run && emp) {
        const le = await tx.collection('legal_entities').findOne({ id: run.legal_entity_id });
        const t = await tx.collection('tenants').findOne({ id: tx.tenantId });
        const [des, dep, loc] = await Promise.all([
          emp.current_designation_id ? tx.collection('designations').findOne({ id: emp.current_designation_id }) : undefined,
          emp.current_department_id ? tx.collection('departments').findOne({ id: emp.current_department_id }) : undefined,
          emp.current_location_id ? tx.collection('locations').findOne({ id: emp.current_location_id }) : undefined,
        ]);
        p = {
          id: item.id, employee_id: item.employee_id, period_start: run.period_start, month: (run.period_start as string).slice(0, 7), periodEnd: run.period_end, payDate: run.pay_date,
          currency: run.currency, legalEntityName: le?.legal_name ?? null, workspaceName: t?.name ?? null, isDemo: t?.is_demo ?? false,
          code: emp.employee_code, name: displayName(emp as never), dateOfJoining: emp.date_of_joining,
          designation: des?.name ?? null, department: dep?.name ?? null, location: loc?.name ?? null,
          daysInPeriod: item.days_in_period, employedDays: item.employed_days, lopDays: item.lop_override ?? item.lop_days, paidDays: item.paid_days,
          gross: item.gross, deductions: item.deductions, reimbursements: item.reimbursements, net: item.net, employerContributions: item.employer_contributions,
          taxable: item.taxable, tds: item.tds, lines: item.lines, explanation: item.explanation,
        };
      }
      if (!p) throw Errors.notFound('Payslip');
      const e = await payrollEmployee(tx, p.employee_id);
      await this.authz.require('payslips:read', attrsOf(e), tx);
      const ytdRuns = await tx.collection('payroll_runs').distinct<string>('id', { status: 'finalised', period_start: { $gte: payrollEngine.fyStart(p.period_start), $lte: p.period_start } });
      const ytdItems = await tx.collection('payroll_items').find({ employee_id: p.employee_id, status: 'included', run_id: { $in: ytdRuns } }, { projection: { gross: 1, tds: 1, net: 1 } });
      const total = (f: string) => money.fromMinor(ytdItems.reduce((acc, i) => acc + money.toMinor(i[f] as string), 0n));
      const ytd = { gross: total('gross'), tds: total('tds'), net: total('net') };
      const s = await this.authz.subject(tx);
      if (s.employeeId !== p.employee_id) await this.audit.record(tx, { action: 'payslip.viewed', resourceType: 'employee', resourceId: p.employee_id, metadata: { payslipId: id } });
      const { employee_id, period_start, ...rest } = p;
      return { ...rest, employeeId: employee_id, periodStart: period_start, yearToDate: { financialYearFrom: payrollEngine.fyStart(period_start), ...ytd } };
    });
  }
}

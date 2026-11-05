import { Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { DatabaseService, many, one } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_SCOPE } from '../employees/employee-attrs';
import { payrollEngine } from '@crew/contracts';
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
      const params: unknown[] = [employeeId ?? null];
      const pred = await this.authz.predicate('payslips:read', EMPLOYEE_SCOPE, params, tx);
      return many(
        tx,
        `select i.id, i.employee_id as "employeeId", e.employee_code as code, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name,
                to_char(r.period_start, 'YYYY-MM') as month, to_char(r.pay_date, 'YYYY-MM-DD') as "payDate", le.name as "legalEntityName", r.currency,
                i.gross::text, i.deductions::text, i.reimbursements::text, i.net::text
           from payroll_items i join payroll_runs r on r.id = i.run_id join employees e on e.id = i.employee_id join legal_entities le on le.id = r.legal_entity_id
          where r.status = 'finalised' and i.status = 'included' and ${pred} and ($1::uuid is null or i.employee_id = $1)
          order by r.period_start desc, name limit 500`,
        params,
      );
    });
  }

  async get(id: string) {
    return this.db.tenant(async (tx) => {
      const p = await one<{ employee_id: string; period_start: string } & Record<string, unknown>>(
        tx,
        `select i.id, i.employee_id, to_char(r.period_start, 'YYYY-MM-DD') as period_start, to_char(r.period_start, 'YYYY-MM') as month,
                to_char(r.period_end, 'YYYY-MM-DD') as "periodEnd", to_char(r.pay_date, 'YYYY-MM-DD') as "payDate", r.currency,
                le.legal_name as "legalEntityName", t.name as "workspaceName", t.is_demo as "isDemo",
                e.employee_code as code, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, to_char(e.date_of_joining, 'YYYY-MM-DD') as "dateOfJoining",
                des.name as designation, d.name as department, l.name as location,
                i.days_in_period as "daysInPeriod", i.employed_days as "employedDays", coalesce(i.lop_override, i.lop_days)::text as "lopDays", i.paid_days::text as "paidDays",
                i.gross::text, i.deductions::text, i.reimbursements::text, i.net::text, i.employer_contributions::text as "employerContributions",
                i.taxable::text, i.tds::text, i.lines, i.explanation
           from payroll_items i join payroll_runs r on r.id = i.run_id join employees e on e.id = i.employee_id join legal_entities le on le.id = r.legal_entity_id
           join tenants t on t.id = i.tenant_id
           left join designations des on des.id = e.current_designation_id left join departments d on d.id = e.current_department_id
           left join locations l on l.id = e.current_location_id
          where i.id = $1 and r.status = 'finalised' and i.status = 'included'`,
        [id],
      );
      if (!p) throw Errors.notFound('Payslip');
      const e = await payrollEmployee(tx, p.employee_id);
      await this.authz.require('payslips:read', attrsOf(e), tx);
      const ytd = await one<{ gross: string; tds: string; net: string }>(
        tx,
        `select coalesce(sum(i.gross), 0)::text as gross, coalesce(sum(i.tds), 0)::text as tds, coalesce(sum(i.net), 0)::text as net
           from payroll_items i join payroll_runs r on r.id = i.run_id
          where i.employee_id = $1 and r.status = 'finalised' and i.status = 'included' and r.period_start >= $2 and r.period_start <= $3`,
        [p.employee_id, payrollEngine.fyStart(p.period_start), p.period_start],
      );
      const s = await this.authz.subject(tx);
      if (s.employeeId !== p.employee_id) await this.audit.record(tx, { action: 'payslip.viewed', resourceType: 'employee', resourceId: p.employee_id, metadata: { payslipId: id } });
      const { employee_id, period_start, ...rest } = p;
      return { ...rest, employeeId: employee_id, periodStart: period_start, yearToDate: { financialYearFrom: payrollEngine.fyStart(period_start), ...ytd } };
    });
  }
}

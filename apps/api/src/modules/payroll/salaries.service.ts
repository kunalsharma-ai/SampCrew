import { Injectable } from '@nestjs/common';
import { DEFAULT_IN_STATUTORY, payrollEngine, type SalaryInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_SCOPE, employeeAttrs } from '../employees/employee-attrs';
import { legalEntity, statutoryOn } from './payroll-common';

interface EmpRow {
  id: string;
  membership_id: string | null;
  legal_entity_id: string | null;
  department_id: string | null;
  location_id: string | null;
  name: string;
  code: string;
}

export const attrsOf = (e: EmpRow) =>
  employeeAttrs({ id: e.id, membershipId: e.membership_id, legalEntityId: e.legal_entity_id, departmentId: e.department_id, locationId: e.location_id });

export async function payrollEmployee(tx: Tx, id: string) {
  const e = await one<EmpRow>(
    tx,
    `select id, membership_id, current_legal_entity_id as legal_entity_id, current_department_id as department_id, current_location_id as location_id,
            trim(coalesce(preferred_name, first_name) || ' ' || last_name) as name, employee_code as code
       from employees where id = $1`,
    [id],
  );
  if (!e) throw Errors.notFound('Employee');
  return e;
}

/** Effective-dated employee salaries. Each revision stores its monthly breakdown so later structure edits never change history. */
@Injectable()
export class SalariesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  async list(q: { legalEntityId?: string; q?: string }) {
    return this.db.tenant(async (tx) => {
      const params: unknown[] = [q.legalEntityId ?? null, q.q ? `%${q.q}%` : null];
      const pred = await this.authz.predicate('payroll:read', EMPLOYEE_SCOPE, params, tx);
      return many(
        tx,
        `select e.id, e.employee_code as code, trim(coalesce(e.preferred_name, e.first_name) || ' ' || e.last_name) as name, e.status,
                le.name as "legalEntityName", d.name as "departmentName",
                s.id as "salaryId", to_char(s.effective_from, 'YYYY-MM-DD') as "effectiveFrom", s.annual_ctc::text as "annualCtc", s.currency, st.name as "structureName",
                (select count(*)::int from employee_salaries x where x.employee_id = e.id and x.effective_from > current_date) as "upcomingRevisions"
           from employees e
           left join legal_entities le on le.id = e.current_legal_entity_id
           left join departments d on d.id = e.current_department_id
           left join lateral (select * from employee_salaries x where x.employee_id = e.id
                               order by (x.effective_from <= current_date) desc, case when x.effective_from <= current_date then x.effective_from end desc, x.effective_from
                               limit 1) s on true
           left join salary_structures st on st.id = s.structure_id
          where e.status <> 'exited' and ${pred} and ($1::uuid is null or e.current_legal_entity_id = $1)
            and ($2::text is null or e.first_name ilike $2 or e.last_name ilike $2 or e.employee_code ilike $2)
          order by name limit 500`,
        params,
      );
    });
  }

  async history(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const e = await payrollEmployee(tx, employeeId);
      await this.authz.require('payroll:read', attrsOf(e), tx);
      const revisions = await many(
        tx,
        `select s.id, to_char(s.effective_from, 'YYYY-MM-DD') as "effectiveFrom", s.annual_ctc::text as "annualCtc", s.currency, s.structure_id as "structureId",
                st.name as "structureName", s.pf_enabled as "pfEnabled", s.esi_enabled as "esiEnabled", s.pt_enabled as "ptEnabled", s.tds_enabled as "tdsEnabled",
                s.employer_pf_monthly::text as "employerPfMonthly", s.note, s.created_at as "createdAt", u.full_name as "createdBy",
                exists (select 1 from payroll_items i where i.salary_id = s.id) as "usedByPayroll",
                coalesce((select json_agg(json_build_object('code', c.code, 'name', c.name, 'kind', c.kind, 'monthly', l.monthly::text) order by l.position)
                            from employee_salary_lines l join pay_components c on c.id = l.component_id where l.salary_id = s.id), '[]') as lines
           from employee_salaries s join salary_structures st on st.id = s.structure_id left join users u on u.id = s.created_by
          where s.employee_id = $1 order by s.effective_from desc`,
        [employeeId],
      );
      return { employee: { id: e.id, name: e.name, code: e.code }, revisions };
    });
  }

  /** Splits a CTC with a structure, using the statutory settings that will apply (or India starting values when none are saved yet). */
  private async build(tx: Tx, e: EmpRow, input: Pick<SalaryInput, 'annualCtc' | 'structureId' | 'pfEnabled' | 'effectiveFrom'>) {
    if (!e.legal_entity_id) throw Errors.badRequest('no_legal_entity', 'Place the employee in a legal entity first');
    const le = await legalEntity(tx, e.legal_entity_id);
    const st = await one<{ archived_at: string | null }>(tx, 'select archived_at from salary_structures where id = $1', [input.structureId]);
    if (!st || st.archived_at) throw Errors.badRequest('unknown_structure', 'Choose an active salary structure');
    const lines = await many<{ component_id: string; code: string; name: string; kind: 'earning' | 'deduction'; calc: payrollEngine.CalcMethod; value: string; is_basic: boolean }>(
      tx,
      `select c.id as component_id, c.code, c.name, c.kind, l.calc, l.value::text, c.is_basic from salary_structure_lines l join pay_components c on c.id = l.component_id
        where l.structure_id = $1 order by l.position`,
      [input.structureId],
    );
    const statutory = await statutoryOn(tx, e.legal_entity_id, input.effectiveFrom);
    const warnings: string[] = [];
    if (!statutory) warnings.push('No statutory settings are saved for this legal entity yet, so employer PF uses the India starting values. Payroll cannot run until settings are saved.');
    try {
      const out = payrollEngine.buildSalary(
        input.annualCtc,
        lines.map((l) => ({ code: l.code, name: l.name, kind: l.kind, calc: l.calc, value: l.value, isBasic: l.is_basic })),
        { pf: input.pfEnabled, settings: statutory?.settings ?? DEFAULT_IN_STATUTORY },
      );
      return { ...out, warnings: [...warnings, ...out.warnings], currency: le.currency, componentIds: lines.map((l) => l.component_id) };
    } catch (err) {
      throw Errors.badRequest('structure_does_not_fit', (err as Error).message);
    }
  }

  preview(employeeId: string, input: SalaryInput) {
    return this.db.tenant(async (tx) => {
      const e = await payrollEmployee(tx, employeeId);
      await this.authz.require('payroll:run', attrsOf(e), tx);
      const b = await this.build(tx, e, input);
      return { currency: b.currency, components: b.components, employerPfMonthly: b.employerPfMonthly, warnings: b.warnings };
    });
  }

  assign(employeeId: string, input: SalaryInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      const e = await payrollEmployee(tx, employeeId);
      await this.authz.require('payroll:run', attrsOf(e), tx);
      const paid = await one(
        tx,
        `select 1 from payroll_items i join payroll_runs r on r.id = i.run_id where i.employee_id = $1 and r.status in ('pending_approval', 'finalised') and r.period_end >= $2`,
        [employeeId, input.effectiveFrom],
      );
      if (paid) throw Errors.conflict('period_paid', 'Payroll from this date is already finalised or waiting for approval. Use a later effective date, or an adjustment for arrears.');
      const b = await this.build(tx, e, input);
      const row = (await one<{ id: string }>(
        tx,
        `insert into employee_salaries (tenant_id, employee_id, effective_from, annual_ctc, currency, structure_id, pf_enabled, esi_enabled, pt_enabled, tds_enabled, employer_pf_monthly, note, created_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [employeeId, input.effectiveFrom, input.annualCtc, b.currency, input.structureId, input.pfEnabled, input.esiEnabled, input.ptEnabled, input.tdsEnabled, b.employerPfMonthly, input.note ?? null, actor.userId],
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('revision_exists', 'This employee already has a salary from that date. Remove it first if it was a mistake.');
        throw err;
      }))!;
      await tx.query(
        `insert into employee_salary_lines (tenant_id, salary_id, component_id, position, monthly)
         select app_tenant_id(), $1, x.component_id, x.pos, x.monthly from unnest($2::uuid[], $3::numeric[]) with ordinality as x(component_id, monthly, pos)`,
        [row.id, b.componentIds, b.components.map((c) => c.monthly)],
      );
      // Amounts stay out of the audit trail (it is readable by auditors who should not see pay); the revision itself is recorded.
      await this.audit.record(tx, {
        action: 'employee_salary.assigned', resourceType: 'employee', resourceId: employeeId,
        metadata: { salaryId: row.id, effectiveFrom: input.effectiveFrom, structureId: input.structureId, statutory: { pf: input.pfEnabled, esi: input.esiEnabled, pt: input.ptEnabled, tds: input.tdsEnabled } },
      });
      return { id: row.id, warnings: b.warnings };
    });
  }

  remove(salaryId: string) {
    return this.db.tenant(async (tx) => {
      const s = await one<{ employee_id: string }>(tx, 'select employee_id from employee_salaries where id = $1', [salaryId]);
      if (!s) throw Errors.notFound('Salary');
      const e = await payrollEmployee(tx, s.employee_id);
      await this.authz.require('payroll:run', attrsOf(e), tx);
      if (await one(tx, 'select 1 from payroll_items where salary_id = $1', [salaryId])) {
        throw Errors.conflict('salary_used', 'Payroll has used this salary, so it is kept as history. Add a new revision instead.');
      }
      await tx.query('delete from employee_salaries where id = $1', [salaryId]);
      await this.audit.record(tx, { action: 'employee_salary.removed', resourceType: 'employee', resourceId: s.employee_id, metadata: { salaryId } });
    });
  }
}

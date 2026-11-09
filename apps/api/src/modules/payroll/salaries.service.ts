import { Injectable } from '@nestjs/common';
import { DEFAULT_IN_STATUTORY, payrollEngine, type SalaryInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, ilike, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { EMPLOYEE_FIELDS, employeeAttrs } from '../employees/employee-attrs';
import { displayName, fieldById } from '../employees/employee-view';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function empRow(e: Record<string, any>): EmpRow {
  return {
    id: e.id, membership_id: e.membership_id ?? null, legal_entity_id: e.current_legal_entity_id ?? null, department_id: e.current_department_id ?? null,
    location_id: e.current_location_id ?? null, name: displayName(e as never), code: e.employee_code,
  };
}

export async function payrollEmployee(tx: TenantTx, id: string) {
  const e = await tx.collection('employees').findOne({ id });
  if (!e) throw Errors.notFound('Employee');
  return empRow(e);
}

const today = () => new Date().toISOString().slice(0, 10);

/** The salary in effect today, else the earliest upcoming one. */
function currentSalary<T extends { effective_from: string }>(rows: T[], on: string): T | undefined {
  const past = rows.filter((x) => x.effective_from <= on).sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  return past[0] ?? rows.filter((x) => x.effective_from > on).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
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
      const scope = await this.authz.filter('payroll:read', EMPLOYEE_FIELDS, tx);
      const like = q.q ? ilike(q.q) : null;
      const emps = await tx.collection('employees').find({
        $and: [scope, { status: { $ne: 'exited' } }, q.legalEntityId ? { current_legal_entity_id: q.legalEntityId } : {}, like ? { $or: [{ first_name: like }, { last_name: like }, { employee_code: like }] } : {}],
      });
      const ids = emps.map((e) => e.id as string);
      const salaries = await tx.collection<{ id: string; employee_id: string; effective_from: string; annual_ctc: string; currency: string; structure_id: string }>('employee_salaries').find({ employee_id: { $in: ids } });
      const byEmp = new Map<string, typeof salaries>();
      for (const x of salaries) byEmp.set(x.employee_id, [...(byEmp.get(x.employee_id) ?? []), x]);
      const [entities, departments, structures] = await Promise.all([
        fieldById(tx, 'legal_entities', emps.map((e) => e.current_legal_entity_id)),
        fieldById(tx, 'departments', emps.map((e) => e.current_department_id)),
        fieldById(tx, 'salary_structures', salaries.map((x) => x.structure_id)),
      ]);
      const on = today();
      return emps
        .map((e) => {
          const mine = byEmp.get(e.id) ?? [];
          const s = currentSalary(mine, on);
          return {
            id: e.id, code: e.employee_code, name: displayName(e as never), status: e.status,
            legalEntityName: entities.get(e.current_legal_entity_id) ?? null, departmentName: departments.get(e.current_department_id) ?? null,
            salaryId: s?.id ?? null, effectiveFrom: s?.effective_from ?? null, annualCtc: s?.annual_ctc ?? null, currency: s?.currency ?? null,
            structureName: s ? (structures.get(s.structure_id) ?? null) : null, upcomingRevisions: mine.filter((x) => x.effective_from > on).length,
          };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, 500);
    });
  }

  async history(employeeId: string) {
    return this.db.tenant(async (tx) => {
      const e = await payrollEmployee(tx, employeeId);
      await this.authz.require('payroll:read', attrsOf(e), tx);
      const salaries = await tx.collection('employee_salaries').find({ employee_id: employeeId }, { sort: { effective_from: -1 } });
      const ids = salaries.map((x) => x.id as string);
      const lines = await tx.collection('employee_salary_lines').find({ salary_id: { $in: ids } }, { sort: { position: 1 } });
      const comps = new Map((await tx.collection('pay_components').find({ id: { $in: lines.map((l) => l.component_id) } })).map((c) => [c.id as string, c]));
      const structures = await fieldById(tx, 'salary_structures', salaries.map((x) => x.structure_id));
      const users = new Map((await (await usersTable(tx)).find({ id: { $in: salaries.map((x) => x.created_by).filter(Boolean) } }, { projection: { full_name: 1 } })).map((u) => [u.id as string, u.full_name as string]));
      const used = new Set(await tx.collection('payroll_items').distinct<string>('salary_id', { salary_id: { $in: ids } }));
      const revisions = salaries.map((x) => ({
        id: x.id, effectiveFrom: x.effective_from, annualCtc: x.annual_ctc, currency: x.currency, structureId: x.structure_id,
        structureName: structures.get(x.structure_id) ?? null, pfEnabled: x.pf_enabled, esiEnabled: x.esi_enabled, ptEnabled: x.pt_enabled, tdsEnabled: x.tds_enabled,
        employerPfMonthly: x.employer_pf_monthly, note: x.note ?? null, createdAt: x.created_at, createdBy: (x.created_by && users.get(x.created_by)) ?? null,
        usedByPayroll: used.has(x.id),
        lines: lines.filter((l) => l.salary_id === x.id).map((l) => {
          const c = comps.get(l.component_id);
          return { code: c?.code, name: c?.name, kind: c?.kind, monthly: l.monthly };
        }),
      }));
      return { employee: { id: e.id, name: e.name, code: e.code }, revisions };
    });
  }

  /** Splits a CTC with a structure, using the statutory settings that will apply (or India starting values when none are saved yet). */
  private async build(tx: TenantTx, e: EmpRow, input: Pick<SalaryInput, 'annualCtc' | 'structureId' | 'pfEnabled' | 'effectiveFrom'>) {
    if (!e.legal_entity_id) throw Errors.badRequest('no_legal_entity', 'Place the employee in a legal entity first');
    const le = await legalEntity(tx, e.legal_entity_id);
    const st = await tx.collection('salary_structures').findOne({ id: input.structureId });
    if (!st || st.archived_at) throw Errors.badRequest('unknown_structure', 'Choose an active salary structure');
    const structureLines = await tx.collection('salary_structure_lines').find({ structure_id: input.structureId }, { sort: { position: 1 } });
    const comps = new Map((await tx.collection('pay_components').find({ id: { $in: structureLines.map((l) => l.component_id) } })).map((c) => [c.id as string, c]));
    const lines = structureLines.map((l) => {
      const c = comps.get(l.component_id)!;
      return { component_id: c.id as string, code: c.code as string, name: c.name as string, kind: c.kind as 'earning' | 'deduction', calc: l.calc as payrollEngine.CalcMethod, value: l.value as string, is_basic: c.is_basic as boolean };
    });
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
      const items = await tx.collection('payroll_items').distinct<string>('run_id', { employee_id: employeeId });
      const paid = await tx.collection('payroll_runs').exists({ id: { $in: items }, status: { $in: ['pending_approval', 'finalised'] }, period_end: { $gte: input.effectiveFrom } });
      if (paid) throw Errors.conflict('period_paid', 'Payroll from this date is already finalised or waiting for approval. Use a later effective date, or an adjustment for arrears.');
      const b = await this.build(tx, e, input);
      const row = await tx.collection('employee_salaries').insert({
        employee_id: employeeId, effective_from: input.effectiveFrom, annual_ctc: input.annualCtc, currency: b.currency, structure_id: input.structureId,
        pf_enabled: input.pfEnabled, esi_enabled: input.esiEnabled, pt_enabled: input.ptEnabled, tds_enabled: input.tdsEnabled, employer_pf_monthly: b.employerPfMonthly,
        note: input.note ?? null, created_by: actor.userId,
      }).catch((err: { code?: string }) => {
        if (err.code === '23505') throw Errors.conflict('revision_exists', 'This employee already has a salary from that date. Remove it first if it was a mistake.');
        throw err;
      });
      await tx.collection('employee_salary_lines').insertMany(b.componentIds.map((componentId, i) => ({ salary_id: row.id, component_id: componentId, position: i + 1, monthly: b.components[i]!.monthly })));
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
      const s = await tx.collection('employee_salaries').findOne({ id: salaryId });
      if (!s) throw Errors.notFound('Salary');
      const e = await payrollEmployee(tx, s.employee_id);
      await this.authz.require('payroll:run', attrsOf(e), tx);
      if (await tx.collection('payroll_items').exists({ salary_id: salaryId })) {
        throw Errors.conflict('salary_used', 'Payroll has used this salary, so it is kept as history. Add a new revision instead.');
      }
      await tx.collection('employee_salaries').deleteOne({ id: salaryId });
      await this.audit.record(tx, { action: 'employee_salary.removed', resourceType: 'employee', resourceId: s.employee_id, metadata: { salaryId } });
    });
  }
}

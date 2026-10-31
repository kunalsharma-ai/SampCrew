import { Injectable } from '@nestjs/common';
import { type ComponentInput, DEFAULT_IN_STATUTORY, type expenseCategoryInput, type StatutoryInput, type StructureInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { ENTITY_SCOPE, legalEntity } from './payroll-common';

const uniqueViolation = (code: string, message: string) => (err: { code?: string }) => {
  if (err.code === '23505') throw Errors.conflict(code, message);
  throw err;
};

/** Pay components, salary structures, statutory settings per legal entity, and expense categories. */
@Injectable()
export class PayrollConfigService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
  ) {}

  // Components ----------------------------------------------------------------------------------------------

  listComponents() {
    return this.db.tenant((tx) =>
      many(tx, `select id, code, name, kind, taxable, prorate, pf_wage as "pfWage", is_basic as "isBasic", is_system as "isSystem", description,
                       archived_at as "archivedAt",
                       exists (select 1 from salary_structure_lines l join salary_structures s on s.id = l.structure_id where l.component_id = c.id and s.archived_at is null) as "inUse"
                  from pay_components c order by archived_at nulls first, is_basic desc, kind, code`),
    );
  }

  createComponent(input: ComponentInput) {
    return this.db.tenant(async (tx) => {
      if (input.kind === 'deduction' && input.pfWage) throw Errors.badRequest('pf_wage_deduction', 'Only an earning can count as PF wages');
      const row = (await one<{ id: string }>(
        tx,
        `insert into pay_components (tenant_id, code, name, kind, taxable, prorate, pf_wage, description) values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [input.code, input.name, input.kind, input.kind === 'earning' ? input.taxable : false, input.kind === 'earning' ? input.prorate : false, input.pfWage, input.description],
      ).catch(uniqueViolation('component_exists', 'A component with this code already exists')))!;
      await this.audit.record(tx, { action: 'pay_component.created', resourceType: 'pay_component', resourceId: row.id, changes: input });
      return row;
    });
  }

  updateComponent(id: string, input: ComponentInput) {
    return this.db.tenant(async (tx) => {
      const c = await one<{ code: string; kind: string; is_system: boolean; is_basic: boolean }>(tx, 'select code, kind, is_system, is_basic from pay_components where id = $1 for update', [id]);
      if (!c) throw Errors.notFound('Component');
      if (input.code !== c.code) throw Errors.badRequest('code_fixed', 'A component’s code cannot change. Create a new component instead.');
      if (input.kind !== c.kind) throw Errors.badRequest('kind_fixed', 'A component cannot switch between earning and deduction');
      if (c.is_basic && !input.pfWage) throw Errors.badRequest('basic_pf_wage', 'Basic always counts as PF wages');
      if (input.kind === 'deduction' && input.pfWage) throw Errors.badRequest('pf_wage_deduction', 'Only an earning can count as PF wages');
      await tx.query('update pay_components set name = $2, taxable = $3, prorate = $4, pf_wage = $5, description = $6 where id = $1', [
        id, input.name, input.kind === 'earning' ? input.taxable : false, input.kind === 'earning' ? input.prorate : false, input.pfWage, input.description,
      ]);
      await this.audit.record(tx, { action: 'pay_component.updated', resourceType: 'pay_component', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveComponent(id: string) {
    return this.db.tenant(async (tx) => {
      const c = await one<{ is_basic: boolean }>(tx, 'select is_basic from pay_components where id = $1 and archived_at is null for update', [id]);
      if (!c) throw Errors.notFound('Component');
      if (c.is_basic) throw Errors.conflict('basic_required', 'Basic is required by every structure and cannot be archived');
      const used = await one(tx, 'select 1 from salary_structure_lines l join salary_structures s on s.id = l.structure_id where l.component_id = $1 and s.archived_at is null', [id]);
      if (used) throw Errors.conflict('component_in_use', 'Remove the component from every active salary structure first');
      await tx.query('update pay_components set archived_at = now() where id = $1', [id]);
      await this.audit.record(tx, { action: 'pay_component.archived', resourceType: 'pay_component', resourceId: id });
    });
  }

  // Structures ----------------------------------------------------------------------------------------------

  listStructures() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select s.id, s.name, s.description, s.archived_at as "archivedAt",
                (select count(distinct es.employee_id)::int from employee_salaries es where es.structure_id = s.id) as "employeeCount",
                coalesce((select json_agg(json_build_object('componentId', c.id, 'code', c.code, 'name', c.name, 'kind', c.kind, 'isBasic', c.is_basic,
                                                            'calc', l.calc, 'value', l.value::text) order by l.position)
                            from salary_structure_lines l join pay_components c on c.id = l.component_id where l.structure_id = s.id), '[]') as lines
           from salary_structures s order by s.archived_at nulls first, s.name`,
      ),
    );
  }

  private async checkStructure(tx: Tx, input: StructureInput) {
    const comps = await many<{ id: string; kind: string; is_basic: boolean; archived_at: string | null }>(
      tx, 'select id, kind, is_basic, archived_at from pay_components where id = any($1::uuid[])', [input.lines.map((l) => l.componentId)],
    );
    if (comps.length !== input.lines.length || comps.some((c) => c.archived_at)) throw Errors.badRequest('unknown_component', 'One of the components does not exist or is archived');
    const byId = new Map(comps.map((c) => [c.id, c]));
    const basic = input.lines.find((l) => byId.get(l.componentId)!.is_basic);
    if (!basic) throw Errors.badRequest('basic_required', 'A structure needs the Basic component');
    if (!['fixed', 'percent_of_ctc'].includes(basic.calc)) throw Errors.badRequest('basic_calc', 'Basic must be a fixed amount or a percentage of CTC');
    for (const l of input.lines) {
      const c = byId.get(l.componentId)!;
      if (l.calc === 'balance' && c.kind !== 'earning') throw Errors.badRequest('balance_earning', 'Only an earning can take the balance');
      if (l.calc.startsWith('percent') && Number(l.value) > 100) throw Errors.badRequest('percent_range', 'A percentage can be at most 100');
      if (c.kind === 'deduction' && l.calc !== 'fixed') throw Errors.badRequest('deduction_fixed', 'A deduction in a structure is a fixed annual amount');
    }
  }

  private async writeLines(tx: Tx, structureId: string, input: StructureInput) {
    await tx.query('delete from salary_structure_lines where structure_id = $1', [structureId]);
    await tx.query(
      `insert into salary_structure_lines (tenant_id, structure_id, component_id, position, calc, value)
       select app_tenant_id(), $1, x.component_id, x.pos, x.calc, x.value
         from unnest($2::uuid[], $3::text[], $4::numeric[]) with ordinality as x(component_id, calc, value, pos)`,
      [structureId, input.lines.map((l) => l.componentId), input.lines.map((l) => l.calc), input.lines.map((l) => l.value)],
    );
  }

  createStructure(input: StructureInput) {
    return this.db.tenant(async (tx) => {
      await this.checkStructure(tx, input);
      const row = (await one<{ id: string }>(tx, 'insert into salary_structures (tenant_id, name, description) values (app_tenant_id(), $1, $2) returning id', [input.name, input.description])
        .catch(uniqueViolation('structure_exists', 'A structure with this name already exists')))!;
      await this.writeLines(tx, row.id, input);
      await this.audit.record(tx, { action: 'salary_structure.created', resourceType: 'salary_structure', resourceId: row.id, changes: input });
      return row;
    });
  }

  /** Changing a structure affects salaries assigned from now on; existing salaries keep the breakdown they were given. */
  updateStructure(id: string, input: StructureInput) {
    return this.db.tenant(async (tx) => {
      if (!(await one(tx, 'select 1 from salary_structures where id = $1 and archived_at is null for update', [id]))) throw Errors.notFound('Salary structure');
      await this.checkStructure(tx, input);
      await tx.query('update salary_structures set name = $2, description = $3 where id = $1', [id, input.name, input.description])
        .catch(uniqueViolation('structure_exists', 'A structure with this name already exists'));
      await this.writeLines(tx, id, input);
      await this.audit.record(tx, { action: 'salary_structure.updated', resourceType: 'salary_structure', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveStructure(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update salary_structures set archived_at = now() where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Salary structure');
      const left = await one<{ n: number }>(tx, 'select count(*)::int as n from salary_structures where archived_at is null');
      if (!left!.n) throw Errors.conflict('last_structure', 'Keep at least one salary structure');
      await this.audit.record(tx, { action: 'salary_structure.archived', resourceType: 'salary_structure', resourceId: id });
    });
  }

  // Statutory settings --------------------------------------------------------------------------------------

  /** Saved settings per legal entity (newest first) and the India starting values for a first review. */
  async statutory(legalEntityId?: string) {
    return this.db.tenant(async (tx) => {
      const pred = await this.authz.predicate('payroll:read', ENTITY_SCOPE('s.legal_entity_id'), [], tx);
      const rows = await many(
        tx,
        `select s.id, s.legal_entity_id as "legalEntityId", le.name as "legalEntityName", to_char(s.effective_from, 'YYYY-MM-DD') as "effectiveFrom",
                s.lop_source as "lopSource", s.settings, s.saved_at as "savedAt", u.full_name as "savedBy",
                exists (select 1 from payroll_runs r where r.statutory_settings_id = s.id) as "usedByRun"
           from statutory_settings s join legal_entities le on le.id = s.legal_entity_id left join users u on u.id = s.saved_by
          where ${pred} and ($1::uuid is null or s.legal_entity_id = $1)
          order by le.name, s.effective_from desc`,
        [legalEntityId ?? null],
      );
      return {
        settings: rows,
        startingValues: {
          countryCode: 'IN',
          settings: DEFAULT_IN_STATUTORY,
          notice:
            'Starting values for India from commonly published figures. CREW does not certify them as current law. Check every rate, ceiling and slab for the period you pay, and change them where needed, before saving.',
        },
      };
    });
  }

  saveStatutory(input: StatutoryInput) {
    const actor = requestContext.tenantActor();
    return this.db.tenant(async (tx) => {
      await this.authz.require('payroll:configure', { legalEntityId: input.legalEntityId }, tx);
      await legalEntity(tx, input.legalEntityId);
      checkSlabs(input.settings);
      const locked = await one(
        tx, `select 1 from payroll_runs where legal_entity_id = $1 and status in ('pending_approval', 'finalised') and period_end >= $2`, [input.legalEntityId, input.effectiveFrom],
      );
      if (locked) throw Errors.conflict('period_paid', 'Payroll for this date onwards is already finalised or waiting for approval. Choose a later effective date.');
      const row = (await one<{ id: string }>(
        tx,
        `insert into statutory_settings (tenant_id, legal_entity_id, effective_from, lop_source, settings, saved_by) values (app_tenant_id(), $1, $2, $3, $4, $5) returning id`,
        [input.legalEntityId, input.effectiveFrom, input.lopSource, JSON.stringify(input.settings), actor.userId],
      ).catch(uniqueViolation('settings_exist', 'Settings are already saved from that date. Remove them first if they were a mistake, or choose another date.')))!;
      await this.audit.record(tx, { action: 'statutory_settings.saved', resourceType: 'statutory_settings', resourceId: row.id, changes: input });
      return row;
    });
  }

  removeStatutory(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await one<{ legal_entity_id: string }>(tx, 'select legal_entity_id from statutory_settings where id = $1', [id]);
      if (!s) throw Errors.notFound('Statutory settings');
      await this.authz.require('payroll:configure', { legalEntityId: s.legal_entity_id }, tx);
      if (await one(tx, 'select 1 from payroll_runs where statutory_settings_id = $1', [id])) {
        throw Errors.conflict('settings_used', 'A payroll run used these settings, so they are kept. Save new settings with a later date instead.');
      }
      await tx.query('delete from statutory_settings where id = $1', [id]);
      await this.audit.record(tx, { action: 'statutory_settings.removed', resourceType: 'statutory_settings', resourceId: id });
    });
  }

  // Expense categories --------------------------------------------------------------------------------------

  listCategories(includeArchived = false) {
    return this.db.tenant((tx) =>
      many(tx, `select id, name, receipt_required as "receiptRequired", max_per_claim::text as "maxPerClaim", archived_at as "archivedAt"
                  from expense_categories where $1 or archived_at is null order by archived_at nulls first, name`, [includeArchived]),
    );
  }

  saveCategory(id: string | null, input: z.infer<typeof expenseCategoryInput>) {
    return this.db.tenant(async (tx) => {
      let catId = id;
      if (id) {
        const r = await tx.query('update expense_categories set name = $2, receipt_required = $3, max_per_claim = $4 where id = $1 and archived_at is null', [id, input.name, input.receiptRequired, input.maxPerClaim])
          .catch(uniqueViolation('category_exists', 'A category with this name already exists'));
        if (!r.rowCount) throw Errors.notFound('Expense category');
      } else {
        catId = (await one<{ id: string }>(tx, 'insert into expense_categories (tenant_id, name, receipt_required, max_per_claim) values (app_tenant_id(), $1, $2, $3) returning id', [input.name, input.receiptRequired, input.maxPerClaim])
          .catch(uniqueViolation('category_exists', 'A category with this name already exists')))!.id;
      }
      await this.audit.record(tx, { action: id ? 'expense_category.updated' : 'expense_category.created', resourceType: 'expense_category', resourceId: catId, changes: input });
      return { id: catId };
    });
  }

  archiveCategory(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await tx.query('update expense_categories set archived_at = now() where id = $1 and archived_at is null', [id]);
      if (!r.rowCount) throw Errors.notFound('Expense category');
      await this.audit.record(tx, { action: 'expense_category.archived', resourceType: 'expense_category', resourceId: id });
    });
  }
}

/** Slabs must rise and end with an open slab, or the engine cannot place every amount. */
function checkSlabs(s: StatutoryInput['settings']) {
  const check = (slabs: { upTo: string | null }[], what: string) => {
    if (slabs[slabs.length - 1]!.upTo !== null) throw Errors.badRequest('open_slab', `${what}: the last slab must have no upper limit`);
    let prev = -1;
    for (const sl of slabs.slice(0, -1)) {
      if (sl.upTo === null) throw Errors.badRequest('open_slab', `${what}: only the last slab can have no upper limit`);
      if (Number(sl.upTo) <= prev) throw Errors.badRequest('slab_order', `${what}: slab limits must rise`);
      prev = Number(sl.upTo);
    }
  };
  for (const [state, slabs] of Object.entries(s.pt.states)) check(slabs, `Professional tax for ${state}`);
  check(s.tds.slabs, 'Income tax slabs');
}

import { Injectable } from '@nestjs/common';
import { type ComponentInput, DEFAULT_IN_STATUTORY, type expenseCategoryInput, type StatutoryInput, type StructureInput } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { fieldById } from '../employees/employee-view';
import { Errors } from '../../platform/http/errors';
import { ENTITY_FIELDS, legalEntity } from './payroll-common';

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
    return this.db.tenant(async (tx) => {
      const comps = await tx.collection('pay_components').find({}, { sort: { archived_at: 1, is_basic: -1, kind: 1, code: 1 } });
      const active = await tx.collection('salary_structures').distinct<string>('id', { archived_at: null });
      const used = new Set(await tx.collection('salary_structure_lines').distinct<string>('component_id', { structure_id: { $in: active } }));
      return comps.map((c) => ({
        id: c.id, code: c.code, name: c.name, kind: c.kind, taxable: c.taxable, prorate: c.prorate, pfWage: c.pf_wage, isBasic: c.is_basic,
        isSystem: c.is_system, description: c.description ?? null, archivedAt: c.archived_at ?? null, inUse: used.has(c.id),
      }));
    });
  }

  createComponent(input: ComponentInput) {
    return this.db.tenant(async (tx) => {
      if (input.kind === 'deduction' && input.pfWage) throw Errors.badRequest('pf_wage_deduction', 'Only an earning can count as PF wages');
      const row = await tx.collection('pay_components').insert({
        code: input.code, name: input.name, kind: input.kind, taxable: input.kind === 'earning' ? input.taxable : false,
        prorate: input.kind === 'earning' ? input.prorate : false, pf_wage: input.pfWage, description: input.description ?? null,
      }).catch(uniqueViolation('component_exists', 'A component with this code already exists'));
      await this.audit.record(tx, { action: 'pay_component.created', resourceType: 'pay_component', resourceId: row.id, changes: input });
      return { id: row.id as string };
    });
  }

  updateComponent(id: string, input: ComponentInput) {
    return this.db.tenant(async (tx) => {
      const comps = tx.collection('pay_components');
      if (!(await comps.lock({ id }))) throw Errors.notFound('Component');
      const c = await comps.findOne({ id });
      if (!c) throw Errors.notFound('Component');
      if (input.code !== c.code) throw Errors.badRequest('code_fixed', 'A component’s code cannot change. Create a new component instead.');
      if (input.kind !== c.kind) throw Errors.badRequest('kind_fixed', 'A component cannot switch between earning and deduction');
      if (c.is_basic && !input.pfWage) throw Errors.badRequest('basic_pf_wage', 'Basic always counts as PF wages');
      if (input.kind === 'deduction' && input.pfWage) throw Errors.badRequest('pf_wage_deduction', 'Only an earning can count as PF wages');
      await comps.updateOne({ id }, {
        $set: { name: input.name, taxable: input.kind === 'earning' ? input.taxable : false, prorate: input.kind === 'earning' ? input.prorate : false, pf_wage: input.pfWage, description: input.description ?? null },
      });
      await this.audit.record(tx, { action: 'pay_component.updated', resourceType: 'pay_component', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveComponent(id: string) {
    return this.db.tenant(async (tx) => {
      const comps = tx.collection('pay_components');
      if (!(await comps.lock({ id, archived_at: null }))) throw Errors.notFound('Component');
      const c = (await comps.findOne({ id }))!;
      if (c.is_basic) throw Errors.conflict('basic_required', 'Basic is required by every structure and cannot be archived');
      const active = await tx.collection('salary_structures').distinct<string>('id', { archived_at: null });
      const used = await tx.collection('salary_structure_lines').exists({ component_id: id, structure_id: { $in: active } });
      if (used) throw Errors.conflict('component_in_use', 'Remove the component from every active salary structure first');
      await comps.updateOne({ id }, { $set: { archived_at: new Date() } });
      await this.audit.record(tx, { action: 'pay_component.archived', resourceType: 'pay_component', resourceId: id });
    });
  }

  // Structures ----------------------------------------------------------------------------------------------

  listStructures() {
    return this.db.tenant(async (tx) => {
      const structures = await tx.collection('salary_structures').find({}, { sort: { archived_at: 1, name: 1 } });
      const ids = structures.map((st) => st.id as string);
      const lines = await tx.collection('salary_structure_lines').find({ structure_id: { $in: ids } }, { sort: { position: 1 } });
      const comps = new Map((await tx.collection('pay_components').find({ id: { $in: [...new Set(lines.map((l) => l.component_id))] } })).map((c) => [c.id as string, c]));
      const salaries = await tx.collection('employee_salaries').find({ structure_id: { $in: ids } }, { projection: { structure_id: 1, employee_id: 1 } });
      return structures.map((st) => ({
        id: st.id, name: st.name, description: st.description ?? null, archivedAt: st.archived_at ?? null,
        employeeCount: new Set(salaries.filter((x) => x.structure_id === st.id).map((x) => x.employee_id)).size,
        lines: lines.filter((l) => l.structure_id === st.id).map((l) => {
          const c = comps.get(l.component_id)!;
          return { componentId: c.id, code: c.code, name: c.name, kind: c.kind, isBasic: c.is_basic, calc: l.calc, value: l.value };
        }),
      }));
    });
  }

  private async checkStructure(tx: TenantTx, input: StructureInput) {
    const comps = await tx.collection('pay_components').find({ id: { $in: input.lines.map((l) => l.componentId) } });
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

  private async writeLines(tx: TenantTx, structureId: string, input: StructureInput) {
    const lines = tx.collection('salary_structure_lines');
    await lines.delete({ structure_id: structureId });
    await lines.insertMany(input.lines.map((l, i) => ({ structure_id: structureId, component_id: l.componentId, position: i + 1, calc: l.calc, value: l.value })));
  }

  createStructure(input: StructureInput) {
    return this.db.tenant(async (tx) => {
      await this.checkStructure(tx, input);
      const inserted = await tx.collection('salary_structures').insert({ name: input.name, description: input.description ?? null })
        .catch(uniqueViolation('structure_exists', 'A structure with this name already exists'));
      const row = { id: inserted.id as string };
      await this.writeLines(tx, row.id, input);
      await this.audit.record(tx, { action: 'salary_structure.created', resourceType: 'salary_structure', resourceId: row.id, changes: input });
      return row;
    });
  }

  /** Changing a structure affects salaries assigned from now on; existing salaries keep the breakdown they were given. */
  updateStructure(id: string, input: StructureInput) {
    return this.db.tenant(async (tx) => {
      const structures = tx.collection('salary_structures');
      if (!(await structures.lock({ id, archived_at: null }))) throw Errors.notFound('Salary structure');
      await this.checkStructure(tx, input);
      await structures.updateOne({ id }, { $set: { name: input.name, description: input.description ?? null } })
        .catch(uniqueViolation('structure_exists', 'A structure with this name already exists'));
      await this.writeLines(tx, id, input);
      await this.audit.record(tx, { action: 'salary_structure.updated', resourceType: 'salary_structure', resourceId: id, changes: input });
      return { id };
    });
  }

  archiveStructure(id: string) {
    return this.db.tenant(async (tx) => {
      const structures = tx.collection('salary_structures');
      if (!(await structures.updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } }))) throw Errors.notFound('Salary structure');
      if (!(await structures.count({ archived_at: null }))) throw Errors.conflict('last_structure', 'Keep at least one salary structure');
      await this.audit.record(tx, { action: 'salary_structure.archived', resourceType: 'salary_structure', resourceId: id });
    });
  }

  // Statutory settings --------------------------------------------------------------------------------------

  /** Saved settings per legal entity (newest first) and the India starting values for a first review. */
  async statutory(legalEntityId?: string) {
    return this.db.tenant(async (tx) => {
      const scope = await this.authz.filter('payroll:read', ENTITY_FIELDS('legal_entity_id'), tx);
      const saved = await tx.collection('statutory_settings').find({ $and: [scope, legalEntityId ? { legal_entity_id: legalEntityId } : {}] }, { sort: { effective_from: -1 } });
      const entities = await fieldById(tx, 'legal_entities', saved.map((x) => x.legal_entity_id));
      const users = new Map((await (await usersTable(tx)).find({ id: { $in: saved.map((x) => x.saved_by).filter(Boolean) } }, { projection: { full_name: 1 } })).map((u) => [u.id as string, u.full_name as string]));
      const used = new Set(await tx.collection('payroll_runs').distinct<string>('statutory_settings_id', { statutory_settings_id: { $in: saved.map((x) => x.id) } }));
      const rows = saved
        .map((x) => ({
          id: x.id, legalEntityId: x.legal_entity_id, legalEntityName: entities.get(x.legal_entity_id) ?? null, effectiveFrom: x.effective_from,
          lopSource: x.lop_source, settings: x.settings, savedAt: x.saved_at, savedBy: (x.saved_by && users.get(x.saved_by)) ?? null, usedByRun: used.has(x.id),
        }))
        .sort((a, b) => String(a.legalEntityName).localeCompare(String(b.legalEntityName)));
      return {
        settings: rows,
        startingValues: {
          countryCode: 'IN',
          settings: DEFAULT_IN_STATUTORY,
          notice:
            'Starting values for India from commonly published figures. SampCrew does not certify them as current law. Check every rate, ceiling and slab for the period you pay, and change them where needed, before saving.',
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
      const locked = await tx.collection('payroll_runs').exists({ legal_entity_id: input.legalEntityId, status: { $in: ['pending_approval', 'finalised'] }, period_end: { $gte: input.effectiveFrom } });
      if (locked) throw Errors.conflict('period_paid', 'Payroll for this date onwards is already finalised or waiting for approval. Choose a later effective date.');
      const inserted = await tx.collection('statutory_settings')
        .insert({ legal_entity_id: input.legalEntityId, effective_from: input.effectiveFrom, lop_source: input.lopSource, settings: input.settings, saved_by: actor.userId })
        .catch(uniqueViolation('settings_exist', 'Settings are already saved from that date. Remove them first if they were a mistake, or choose another date.'));
      const row = { id: inserted.id as string };
      await this.audit.record(tx, { action: 'statutory_settings.saved', resourceType: 'statutory_settings', resourceId: row.id, changes: input });
      return row;
    });
  }

  removeStatutory(id: string) {
    return this.db.tenant(async (tx) => {
      const s = await tx.collection('statutory_settings').findOne({ id });
      if (!s) throw Errors.notFound('Statutory settings');
      await this.authz.require('payroll:configure', { legalEntityId: s.legal_entity_id }, tx);
      if (await tx.collection('payroll_runs').exists({ statutory_settings_id: id })) {
        throw Errors.conflict('settings_used', 'A payroll run used these settings, so they are kept. Save new settings with a later date instead.');
      }
      await tx.collection('statutory_settings').deleteOne({ id });
      await this.audit.record(tx, { action: 'statutory_settings.removed', resourceType: 'statutory_settings', resourceId: id });
    });
  }

  // Expense categories --------------------------------------------------------------------------------------

  listCategories(includeArchived = false) {
    return this.db.tenant(async (tx) =>
      (await tx.collection('expense_categories').find(includeArchived ? {} : { archived_at: null }, { sort: { archived_at: 1, name: 1 } })).map((c) => ({
        id: c.id, name: c.name, receiptRequired: c.receipt_required, maxPerClaim: c.max_per_claim ?? null, archivedAt: c.archived_at ?? null,
      })),
    );
  }

  saveCategory(id: string | null, input: z.infer<typeof expenseCategoryInput>) {
    return this.db.tenant(async (tx) => {
      let catId = id;
      if (id) {
        const n = await tx.collection('expense_categories')
          .updateOne({ id, archived_at: null }, { $set: { name: input.name, receipt_required: input.receiptRequired, max_per_claim: input.maxPerClaim ?? null } })
          .catch(uniqueViolation('category_exists', 'A category with this name already exists'));
        if (!n) throw Errors.notFound('Expense category');
      } else {
        catId = (await tx.collection('expense_categories').insert({ name: input.name, receipt_required: input.receiptRequired, max_per_claim: input.maxPerClaim ?? null })
          .catch(uniqueViolation('category_exists', 'A category with this name already exists'))).id as string;
      }
      await this.audit.record(tx, { action: id ? 'expense_category.updated' : 'expense_category.created', resourceType: 'expense_category', resourceId: catId, changes: input });
      return { id: catId };
    });
  }

  archiveCategory(id: string) {
    return this.db.tenant(async (tx) => {
      if (!(await tx.collection('expense_categories').updateOne({ id, archived_at: null }, { $set: { archived_at: new Date() } }))) throw Errors.notFound('Expense category');
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

import { Injectable } from '@nestjs/common';
import { suggestedDepartments, suggestedDesignations, type Industry, type SetupCompanyInput, type SetupStructureInput } from '@crew/contracts';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { OutboxService } from '../../platform/events/outbox.service';

interface CompanyRow {
  name: string;
  industry: Industry | null;
  companySize: string | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  setupStep: number;
  setupCompletedAt: string | null;
  legalEntityId: string;
  legalName: string | null;
  countryCode: string;
  currency: string;
  timezone: string;
  fiscalYearStartMonth: number;
  registrationNumber: string | null;
  taxId: string | null;
  address: string | null;
}

/**
 * The first-login company setup. A new workspace starts with a name and one legal entity; this fills in the company
 * profile (on the workspace and its main legal entity), then adds departments and designations from a ready-made list
 * for the industry, so the add-employee form has real choices before the first person is added.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private company(tx: Tx) {
    return one<CompanyRow>(
      tx,
      `select t.name, t.industry, t.company_size as "companySize", t.website, t.contact_email::text as "contactEmail", t.contact_phone as "contactPhone",
              t.setup_step as "setupStep", t.setup_completed_at as "setupCompletedAt",
              le.id as "legalEntityId", le.legal_name as "legalName", le.country_code as "countryCode", le.currency, le.timezone,
              le.fiscal_year_start_month as "fiscalYearStartMonth", le.registration_number as "registrationNumber", le.tax_id as "taxId", le.address
         from tenants t
         join lateral (select * from legal_entities where archived_at is null order by created_at limit 1) le on true
        where t.id = app_tenant_id()`,
    );
  }

  /** Where setup stands, what exists already, and the suggestions for the chosen industry. */
  async get() {
    return this.db.tenant(async (tx) => {
      const company = (await this.company(tx))!;
      const counts = (await one<Record<string, number>>(
        tx,
        `select (select count(*)::int from locations where archived_at is null) as locations,
                (select count(*)::int from departments where archived_at is null) as departments,
                (select count(*)::int from designations where archived_at is null) as designations,
                (select count(*)::int from employees where status <> 'exited') as employees`,
      ))!;
      const departments = await many<{ id: string; name: string; code: string | null }>(tx, 'select id, name, code from departments where archived_at is null order by name');
      const designations = await many<{ id: string; name: string; code: string | null; level: number | null }>(
        tx, 'select id, name, code, level from designations where archived_at is null order by level desc nulls last, name',
      );
      return {
        company,
        counts,
        departments,
        designations,
        suggestions: { departments: suggestedDepartments(company.industry), designations: suggestedDesignations(company.industry) },
      };
    });
  }

  async saveCompany(input: SetupCompanyInput) {
    return this.db.tenant(async (tx) => {
      const before = (await this.company(tx))!;
      // Once setup is finished, renaming the workspace is a workspace-settings change and needs that permission (and MFA).
      if (before.setupCompletedAt && input.name !== before.name) await this.authz.require('tenant:manage', undefined, tx);
      await tx.query(
        `update tenants set name = $1, industry = $2, company_size = $3, website = $4, contact_email = $5, contact_phone = $6,
                            setup_step = greatest(setup_step, 1)
          where id = app_tenant_id()`,
        [input.name, input.industry, input.companySize, input.website ?? null, input.contactEmail ?? null, input.contactPhone ?? null],
      );
      await tx.query(
        `update legal_entities set legal_name = $2, country_code = $3, currency = $4, timezone = $5, fiscal_year_start_month = $6,
                                   registration_number = $7, tax_id = $8, address = $9
          where id = $1`,
        [before.legalEntityId, input.legalName || input.name, input.countryCode, input.currency, input.timezone, input.fiscalYearStartMonth,
          input.registrationNumber ?? null, input.taxId ?? null, input.address ?? null],
      );
      const after = (await this.company(tx))!;
      const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      delete changes.setupStep;
      if (Object.keys(changes).length) {
        await this.audit.record(tx, { action: 'tenant.company_profile_updated', resourceType: 'tenant', resourceId: requestContext.tenantActor().tenantId, changes });
      }
      return after;
    });
  }

  /** Adds the chosen departments and designations. Names already in use (ignoring case) are skipped. */
  async addStructure(input: SetupStructureInput) {
    return this.db.tenant(async (tx) => {
      const created = { departments: [] as string[], designations: [] as string[] };
      const skipped = { departments: [] as string[], designations: [] as string[] };
      for (const d of input.departments) {
        const exists = await one(tx, 'select 1 from departments where parent_id is null and archived_at is null and lower(name) = lower($1)', [d.name]);
        // Department codes are unique too; a suggested code already taken is dropped rather than failing the batch.
        const codeTaken = d.code ? await one(tx, 'select 1 from departments where lower(code) = lower($1)', [d.code]) : null;
        if (exists) { skipped.departments.push(d.name); continue; }
        const row = (await one<{ id: string }>(
          tx, `insert into departments (tenant_id, name, code) values (app_tenant_id(), $1, $2) returning id`, [d.name, codeTaken ? null : d.code ?? null],
        ))!;
        await this.audit.record(tx, { action: 'department.created', resourceType: 'department', resourceId: row.id, changes: { name: d.name, via: 'setup' } });
        await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'org.department.created', { id: row.id });
        created.departments.push(d.name);
      }
      for (const d of input.designations) {
        const exists = await one(tx, 'select 1 from designations where archived_at is null and lower(name) = lower($1)', [d.name]);
        if (exists) { skipped.designations.push(d.name); continue; }
        const row = (await one<{ id: string }>(
          tx, `insert into designations (tenant_id, name, code, level) values (app_tenant_id(), $1, $2, $3) returning id`, [d.name, d.code ?? null, d.level ?? null],
        ))!;
        await this.audit.record(tx, { action: 'designation.created', resourceType: 'designation', resourceId: row.id, changes: { ...d, via: 'setup' } });
        created.designations.push(d.name);
      }
      return { created, skipped };
    });
  }

  async progress(step: number) {
    return this.db.tenant(async (tx) => {
      await tx.query('update tenants set setup_step = greatest(setup_step, $1) where id = app_tenant_id()', [step]);
      return { step };
    });
  }

  /** Finishes setup. It can be opened again from Settings at any time; finishing twice keeps the first date. */
  async complete() {
    return this.db.tenant(async (tx) => {
      const r = (await one<{ at: string }>(
        tx, `update tenants set setup_completed_at = coalesce(setup_completed_at, now()) where id = app_tenant_id() returning setup_completed_at as at`,
      ))!;
      await this.audit.record(tx, { action: 'tenant.setup_completed', resourceType: 'tenant', resourceId: requestContext.tenantActor().tenantId });
      return { setupCompletedAt: r.at };
    });
  }
}

import { Injectable } from '@nestjs/common';
import {
  COMPANY_LOCKED_FIELDS, LOCKED_FIELD_MESSAGE, lockedFieldChanges, normaliseIp, suggestedDepartments, suggestedDesignations,
  type CompanyRegistration, type Industry, type LocationTracking, type SetupCompanyInput, type SetupStructureInput,
} from '@crew/contracts';
import { Errors } from '../../platform/http/errors';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { requestContext } from '../../platform/context/request-context';
import { ieq, MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
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
  /** Registered information: what is locked, where the company registered from, location and office networks (issue #86). */
  registration: CompanyRegistration;
}

const localToday = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

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

  /** The workspace and its main (first, still current) legal entity. */
  private async company(tx: Tx): Promise<CompanyRow | undefined> {
    const t = await tx.collection('tenants').findOne({});
    const le = await tx.collection('legal_entities').findOne({ archived_at: null }, { sort: { created_at: 1 } });
    if (!t || !le) return undefined;
    return Promise.resolve<CompanyRow>({
      name: t.name, industry: t.industry ?? null, companySize: t.company_size ?? null, website: t.website ?? null, contactEmail: t.contact_email ?? null,
      contactPhone: t.contact_phone ?? null, setupStep: t.setup_step, setupCompletedAt: t.setup_completed_at ?? null,
      legalEntityId: le.id, legalName: le.legal_name ?? null, countryCode: le.country_code, currency: le.currency, timezone: le.timezone,
      fiscalYearStartMonth: le.fiscal_year_start_month, registrationNumber: le.registration_number ?? null, taxId: le.tax_id ?? null, address: le.address ?? null,
      registration: { lockedAt: null, lockedFields: [], registrationIp: t.registration_ip ?? null, locationTracking: 'punch', officeIps: [] },
    }).then(async (c) => {
      const wm = await tx.collection('work_mode_settings').findOne({});
      const lockedAt = (t.company_locked_at as Date | null | undefined) ?? null;
      c.registration = {
        lockedAt: lockedAt ? new Date(lockedAt).toISOString() : null,
        lockedFields: lockedAt ? COMPANY_LOCKED_FIELDS.filter((f) => { const v = (c as unknown as Record<string, unknown>)[f]; return v !== null && v !== undefined && String(v).trim() !== ''; }) : [],
        registrationIp: (t.registration_ip as string | null | undefined) ?? null,
        locationTracking: (wm?.location_tracking as LocationTracking | undefined) ?? 'punch',
        officeIps: (wm?.office_ips as string[] | undefined) ?? [],
      };
      return c;
    });
  }

  /** Where setup stands, what exists already, and the suggestions for the chosen industry. */
  async get() {
    return this.db.tenant(async (tx) => {
      const company = (await this.company(tx))!;
      const counts = {
        locations: await tx.collection('locations').count({ archived_at: null }),
        departments: await tx.collection('departments').count({ archived_at: null }),
        designations: await tx.collection('designations').count({ archived_at: null }),
        employees: await tx.collection('employees').count({ status: { $ne: 'exited' } }),
      };
      const departments = (await tx.collection('departments').find({ archived_at: null }, { sort: { name: 1 } })).map((d) => ({ id: d.id as string, name: d.name as string, code: (d.code as string | null) ?? null }));
      const designations = (await tx.collection('designations').find({ archived_at: null }))
        .map((d) => ({ id: d.id as string, name: d.name as string, code: (d.code as string | null) ?? null, level: (d.level as number | null) ?? null }))
        .sort((a, b) => (a.level === b.level ? 0 : a.level === null ? 1 : b.level === null ? -1 : b.level - a.level) || a.name.localeCompare(b.name));
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
      // Registered information is locked once setup is finished (issue #86): a field that holds a value cannot change;
      // an empty one can be filled in. SAMPLEDGE corrects locked fields from the Console.
      if (before.registration.lockedAt) {
        const locked = lockedFieldChanges(before as unknown as Record<string, unknown>, input as unknown as Record<string, unknown>, COMPANY_LOCKED_FIELDS);
        if (locked.length) throw Errors.validation(locked.map((path) => ({ path, message: LOCKED_FIELD_MESSAGE })));
      }
      // Once setup is finished, renaming the workspace is a workspace-settings change and needs that permission (and MFA).
      if (before.setupCompletedAt && input.name !== before.name) await this.authz.require('tenant:manage', undefined, tx);
      // Companies registered before the IP was recorded get it from the first save of the company details.
      if (!before.registration.registrationIp) {
        const ip = normaliseIp(requestContext.get()?.ip);
        if (ip) await tx.collection('tenants').updateOne({ registration_ip: null }, { $set: { registration_ip: ip } });
      }
      if (input.locationTracking || input.officeIps) {
        if (!(await tx.collection('work_mode_settings').exists({}))) {
          const tz = input.timezone || before.timezone;
          await tx.collection('work_mode_settings').insert({ classify_from: localToday(tz) }).catch(() => undefined);
        }
        const set: Record<string, unknown> = {};
        if (input.locationTracking) set.location_tracking = input.locationTracking;
        if (input.officeIps) set.office_ips = input.officeIps;
        await tx.collection('work_mode_settings').updateOne({}, { $set: set });
      }
      await tx.collection('tenants').updateOne({}, {
        $set: { name: input.name, industry: input.industry, company_size: input.companySize, website: input.website ?? null, contact_email: input.contactEmail ?? null, contact_phone: input.contactPhone ?? null },
        $max: { setup_step: 1 },
      });
      await tx.collection('legal_entities').updateOne({ id: before.legalEntityId }, { $set: {
        legal_name: input.legalName || input.name, country_code: input.countryCode, currency: input.currency, timezone: input.timezone,
        fiscal_year_start_month: input.fiscalYearStartMonth, registration_number: input.registrationNumber ?? null, tax_id: input.taxId ?? null, address: input.address ?? null,
      } });
      const after = (await this.company(tx))!;
      const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      delete changes.setupStep;
      delete changes.registration;
      if (JSON.stringify(before.registration) !== JSON.stringify(after.registration)) changes.registration = { from: before.registration, to: after.registration };
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
        const exists = await tx.collection('departments').exists({ parent_id: null, archived_at: null, name: ieq(d.name) });
        // Department codes are unique too; a suggested code already taken is dropped rather than failing the batch.
        const codeTaken = d.code ? await tx.collection('departments').exists({ code: ieq(d.code) }) : false;
        if (exists) { skipped.departments.push(d.name); continue; }
        const row = (await tx.collection('departments').insert({ name: d.name, code: codeTaken ? null : d.code ?? null })) as { id: string };
        await this.audit.record(tx, { action: 'department.created', resourceType: 'department', resourceId: row.id, changes: { name: d.name, via: 'setup' } });
        await this.outbox.publish(tx, requestContext.tenantActor().tenantId, 'org.department.created', { id: row.id });
        created.departments.push(d.name);
      }
      for (const d of input.designations) {
        const exists = await tx.collection('designations').exists({ archived_at: null, name: ieq(d.name) });
        if (exists) { skipped.designations.push(d.name); continue; }
        const row = (await tx.collection('designations').insert({ name: d.name, code: d.code ?? null, level: d.level ?? null })) as { id: string };
        await this.audit.record(tx, { action: 'designation.created', resourceType: 'designation', resourceId: row.id, changes: { ...d, via: 'setup' } });
        created.designations.push(d.name);
      }
      return { created, skipped };
    });
  }

  async progress(step: number) {
    return this.db.tenant(async (tx) => {
      await tx.collection('tenants').updateOne({}, { $max: { setup_step: step } });
      return { step };
    });
  }

  /** Finishes setup. It can be opened again from Settings at any time; finishing twice keeps the first date. */
  async complete() {
    return this.db.tenant(async (tx) => {
      await tx.collection('tenants').update({ setup_completed_at: null }, { $set: { setup_completed_at: new Date() } });
      // Finishing setup locks the registered information (issue #86).
      await tx.collection('tenants').update({ company_locked_at: null }, { $set: { company_locked_at: new Date() } });
      const r = { at: (await tx.collection('tenants').findOne({}))!.setup_completed_at as Date };
      await this.audit.record(tx, { action: 'tenant.setup_completed', resourceType: 'tenant', resourceId: requestContext.tenantActor().tenantId });
      return { setupCompletedAt: r.at };
    });
  }
}

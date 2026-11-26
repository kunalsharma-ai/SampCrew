import { Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import {
  DEFAULT_EMPLOYEE_FORM, employeeFormSettingsInput, missingEmployeeFields, resolveEmployeeForm, workEmailDomainError,
  type EmployeeFormSettings, type EmployeeFormSettingsInput,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { isSuperWorkspace } from '../communication/identity';

const FORM = 'employee_create';

/** The Add Employee form's configuration as stored (defaults filled in). */
export async function employeeFormOf(tx: TenantTx): Promise<EmployeeFormSettingsInput & { updatedAt: Date | null; updatedBy: string | null }> {
  const row = await tx.collection('form_settings').findOne({ form_key: FORM });
  const parsed = employeeFormSettingsInput.safeParse(row?.settings ?? DEFAULT_EMPLOYEE_FORM);
  return { ...(parsed.success ? parsed.data : DEFAULT_EMPLOYEE_FORM), updatedAt: (row?.updated_at as Date | undefined) ?? null, updatedBy: (row?.updated_by_membership_id as string | undefined) ?? null };
}

/**
 * Refuses a new employee the Super Workspace's form rules do not accept (issue #89): a work email outside the company
 * domains when they are required, or a field it made required left empty. The same rules the form shows.
 */
export async function checkEmployeeForm(tx: TenantTx, values: Record<string, unknown>) {
  const s = await employeeFormOf(tx);
  const fields: Record<string, string> = { ...missingEmployeeFields(values, s, { designationTyped: !!values.designationName }) };
  const domain = workEmailDomainError(values.workEmail as string | undefined, s);
  if (domain) fields.workEmail = domain;
  if (Object.keys(fields).length) {
    throw Errors.validation(Object.entries(fields).map(([path, message]) => ({ path, message })));
  }
}

@Injectable()
export class EmployeeFormService {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  get(): Promise<EmployeeFormSettings> {
    return this.db.tenant(async (tx) => {
      const s = await employeeFormOf(tx);
      const by = s.updatedBy ? (await membershipUserNames(tx, [s.updatedBy])).get(s.updatedBy) ?? null : null;
      return {
        workEmailDomains: s.workEmailDomains, enforceWorkEmailDomain: s.enforceWorkEmailDomain, fields: s.fields, resolved: resolveEmployeeForm(s),
        updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null, updatedBy: by, canChange: await isSuperWorkspace(tx, requestContext.tenantActor().membershipId),
      };
    });
  }

  async save(input: EmployeeFormSettingsInput) {
    await this.db.tenant(async (tx) => {
      const me = requestContext.tenantActor().membershipId;
      if (!(await isSuperWorkspace(tx, me))) throw Errors.forbidden('Only the Super Workspace configures the Add Employee form');
      const before = await employeeFormOf(tx);
      await tx.collection('form_settings').upsert({ form_key: FORM }, { form_key: FORM, settings: input, updated_by_membership_id: me }, { $set: { settings: input, updated_by_membership_id: me }, $inc: { version: 1 } });
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (JSON.stringify(before.workEmailDomains) !== JSON.stringify(input.workEmailDomains)) changes.workEmailDomains = { from: before.workEmailDomains, to: input.workEmailDomains };
      if (before.enforceWorkEmailDomain !== input.enforceWorkEmailDomain) changes.enforceWorkEmailDomain = { from: before.enforceWorkEmailDomain, to: input.enforceWorkEmailDomain };
      for (const k of new Set([...Object.keys(before.fields), ...Object.keys(input.fields)])) {
        const a = JSON.stringify(before.fields[k as keyof typeof before.fields] ?? null);
        const b = JSON.stringify(input.fields[k as keyof typeof input.fields] ?? null);
        if (a !== b) changes[`field.${k}`] = { from: JSON.parse(a), to: JSON.parse(b) };
      }
      await this.audit.record(tx, { action: 'employee_form.changed', resourceType: 'form_settings', resourceId: FORM, changes });
    });
    return this.get();
  }
}

/** The Add Employee form's configuration (Super Workspace Admin): work email domains and each field's rule. */
@Controller('employee-form')
export class EmployeeFormController {
  constructor(private readonly form: EmployeeFormService) {}

  @Get()
  @Doc({ summary: 'The Add Employee form: company work email domains and which fields are shown, required, renamed' })
  get() {
    return this.form.get();
  }

  @Put()
  @Doc({ summary: 'Configure the Add Employee form (Super Workspace only)', body: employeeFormSettingsInput })
  save(@Body(new ZodPipe(employeeFormSettingsInput)) body: EmployeeFormSettingsInput) {
    return this.form.save(body);
  }
}

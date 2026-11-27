import { Body, Controller, forwardRef, Get, Inject, Injectable, Param, Put } from '@nestjs/common';
import {
  employeeFormSettingsInput, FORM_KEYS, FORMS, formDefinition, formRulesError, formSettingsInput, resolveEmployeeForm, resolveForm,
  type FormKey, type FormSettingsInput, type FormSummary, type FormView, type ResolvedFormField,
} from '@crew/contracts';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, membershipUserNames, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { isSuperWorkspace } from '../communication/identity';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { EmployeeFormService, employeeFormOf } from './employee-form';

const storeKey = (key: FormKey) => `form:${key}`;

/** A form's stored rules (defaults: every field shown and optional). Add Employee is read from its own settings. */
async function storedRules(tx: TenantTx, key: FormKey): Promise<{ fields: FormSettingsInput['fields']; updatedAt: Date | null; updatedBy: string | null }> {
  if (key === 'add_employee') {
    const s = await employeeFormOf(tx);
    return { fields: s.fields as FormSettingsInput['fields'], updatedAt: s.updatedAt, updatedBy: s.updatedBy };
  }
  const row = await tx.collection('form_settings').findOne({ form_key: storeKey(key) });
  const parsed = formSettingsInput.safeParse(row?.settings ?? { fields: {} });
  return { fields: parsed.success ? parsed.data.fields : {}, updatedAt: (row?.updated_at as Date | undefined) ?? null, updatedBy: (row?.updated_by_membership_id as string | undefined) ?? null };
}

/** A form's built-in fields as the Super Workspace set them, for the services that check what is submitted. */
export async function formRulesOf(tx: TenantTx, key: FormKey): Promise<ResolvedFormField[]> {
  const def = formDefinition(key)!;
  const s = await storedRules(tx, key);
  return resolveForm(def, s.fields);
}

/** Refuses values a form's rules do not accept: a required field left empty (only the keys given are checked). */
export async function checkFormRules(tx: TenantTx, key: FormKey, values: Record<string, unknown>, keys: readonly string[]) {
  const rules = await formRulesOf(tx, key);
  const problems = rules
    .filter((f) => f.required && keys.includes(f.key))
    .filter((f) => { const v = values[f.key]; return v === undefined || v === null || (typeof v === 'string' && !v.trim()); })
    .map((f) => ({ path: f.key, message: `${f.label} is required` }));
  if (problems.length) throw Errors.validation(problems);
}

/**
 * Form management (issue #91): the Super Workspace sets up every form from one page. Built-in field rules are kept in
 * form_settings; custom fields are the custom_fields of the form's record type, managed through /custom-fields.
 */
@Injectable()
export class FormsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => CustomFieldsService)) private readonly fields: CustomFieldsService,
    private readonly employeeForm: EmployeeFormService,
  ) {}

  async list(): Promise<FormSummary[]> {
    const defs = await this.fields.definitions(undefined, false);
    return this.db.tenant(async (tx) => {
      const out: FormSummary[] = [];
      for (const f of FORMS) {
        const s = await storedRules(tx, f.key);
        const resolved = resolveForm(f, s.fields);
        // Employee custom fields belong to the profile and show on Add Employee too.
        out.push({
          key: f.key, label: f.label, where: f.where, usedBy: f.usedBy, builtInFields: resolved.length,
          hiddenFields: resolved.filter((r) => !r.visible).length + defs.filter((d) => d.entity === f.entity && !d.enabled).length,
          requiredFields: resolved.filter((r) => r.required).length + defs.filter((d) => d.entity === f.entity && d.enabled && d.required).length,
          customFields: defs.filter((d) => d.entity === f.entity).length,
          updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
        });
      }
      return out;
    });
  }

  async get(key: FormKey): Promise<FormView> {
    const form = formDefinition(key);
    if (!form) throw Errors.notFound('Form');
    const customFields = await this.fields.definitions(form.entity, true);
    return this.db.tenant(async (tx) => {
      const canChange = await isSuperWorkspace(tx, requestContext.tenantActor().membershipId);
      const s = await storedRules(tx, key);
      const by = s.updatedBy ? (await membershipUserNames(tx, [s.updatedBy])).get(s.updatedBy) ?? null : null;
      const extra = key === 'add_employee' ? await employeeFormOf(tx) : null;
      return {
        form,
        resolved: key === 'add_employee' ? resolveEmployeeForm({ fields: s.fields as never }).map((r) => ({ key: r.key, builtInLabel: r.builtInLabel, label: r.label, section: r.step, locked: r.locked, visible: r.visible, required: r.required, hint: r.hint, placeholder: r.placeholder, fallback: r.fallback })) : resolveForm(form, s.fields),
        // Archived fields only for the Super Workspace, which can bring them back.
        customFields: canChange ? customFields : customFields.filter((f) => !f.archivedAt),
        ...(extra ? { workEmailDomains: extra.workEmailDomains, enforceWorkEmailDomain: extra.enforceWorkEmailDomain } : {}),
        updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null,
        updatedBy: by,
        canChange,
      };
    });
  }

  async save(key: FormKey, body: unknown): Promise<FormView> {
    const form = formDefinition(key);
    if (!form) throw Errors.notFound('Form');
    if (key === 'add_employee') {
      const parsed = employeeFormSettingsInput.safeParse(body);
      if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      await this.employeeForm.save(parsed.data);
      return this.get(key);
    }
    const parsed = formSettingsInput.safeParse(body);
    if (!parsed.success) throw Errors.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const input = parsed.data;
    const bad = formRulesError(form, input.fields);
    if (bad) throw Errors.validation([{ path: 'fields', message: bad }]);
    await this.db.tenant(async (tx) => {
      const me = requestContext.tenantActor().membershipId;
      if (!(await isSuperWorkspace(tx, me))) throw Errors.forbidden('Only the Super Workspace sets up forms');
      const before = await storedRules(tx, key);
      await tx.collection('form_settings').upsert(
        { form_key: storeKey(key) },
        { form_key: storeKey(key), settings: input, updated_by_membership_id: me },
        { $set: { settings: input, updated_by_membership_id: me }, $inc: { version: 1 } },
      );
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of new Set([...Object.keys(before.fields), ...Object.keys(input.fields)])) {
        const a = JSON.stringify(before.fields[k] ?? null);
        const b = JSON.stringify(input.fields[k] ?? null);
        if (a !== b) changes[`field.${k}`] = { from: JSON.parse(a), to: JSON.parse(b) };
      }
      await this.audit.record(tx, { action: 'form.changed', resourceType: 'form_settings', resourceId: storeKey(key), changes });
    });
    return this.get(key);
  }
}

const keyParam = z.enum(FORM_KEYS);

/** Form management: every form's fields, set up by the Super Workspace and read by every form that shows them. */
@Controller('forms')
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Get()
  @Doc({ summary: 'Every form that can be set up, with its field counts' })
  list() {
    return this.forms.list();
  }

  @Get(':key')
  @Doc({ summary: "One form: its built-in fields' rules and its custom fields" })
  get(@Param('key', new ZodPipe(keyParam)) key: FormKey) {
    return this.forms.get(key);
  }

  @Put(':key')
  @Doc({ summary: "Set up a form's built-in fields (Super Workspace only)", body: formSettingsInput })
  save(@Param('key', new ZodPipe(keyParam)) key: FormKey, @Body() body: unknown) {
    return this.forms.save(key, body);
  }
}

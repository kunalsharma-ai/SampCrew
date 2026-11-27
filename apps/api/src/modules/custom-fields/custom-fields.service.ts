import { Injectable } from '@nestjs/common';
import {
  checkFieldValue,
  CUSTOM_FIELD_ENTITY_LABEL,
  type CustomFieldDefinition,
  type CustomFieldEntity,
  type customFieldInput,
  type customFieldReorder,
  type customFieldUpdate,
  fieldKeyFromLabel,
  fieldValueText,
  OPTION_TYPES, impliedLevelKeys, levelRoleKeyFor } from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { grantCovers, grantsFor, type ResourceAttributes, type Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { StorageService } from '../../platform/storage/storage.service';
import { storeUpload, type UploadedFile } from '../../platform/storage/uploads';
import { employeeAttrs } from '../employees/employee-attrs';
import { listEntries } from '../master-data/master-data.service';
import { candidateScopeFilter } from '../recruitment/recruitment-common';
import { isSuperWorkspace } from '../communication/identity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const actorMembership = () => {
  const a = requestContext.get()?.actor;
  return a?.kind === 'user' ? a.membershipId : null;
};

/** For each kind of record: who may see it, who may change it, and how to find its ABAC attributes. */
interface EntityRule {
  view: string;
  edit: string;
  feature?: string;
  /** The record's attributes for scope checks, or null when the record does not exist. */
  attrs(tx: TenantTx, id: string): Promise<{ attrs?: ResourceAttributes; country?: string | null; selfEmployeeId?: string | null } | null>;
}

const employeeOf = async (tx: TenantTx, employeeId: string) => {
  const e = await tx.collection('employees').findOne({ id: employeeId });
  if (!e) return null;
  const le = e.current_legal_entity_id ? await tx.collection('legal_entities').findOne({ id: e.current_legal_entity_id }, { projection: { country_code: 1 } }) : undefined;
  return {
    attrs: employeeAttrs({ id: e.id, membershipId: e.membership_id ?? null, legalEntityId: e.current_legal_entity_id ?? null, departmentId: e.current_department_id ?? null, locationId: e.current_location_id ?? null }),
    country: le?.country_code ?? null,
    selfEmployeeId: e.id as string,
  };
};

const RULES: Record<CustomFieldEntity, EntityRule> = {
  employee: { view: 'employees:read', edit: 'employees:update', attrs: employeeOf },
  asset: {
    view: 'assets:view', edit: 'assets:edit', feature: 'asset_management',
    attrs: async (tx, id) => ((await tx.collection('assets').exists({ id })) ? {} : null),
  },
  bgv_case: {
    view: 'bgv:view', edit: 'bgv:edit', feature: 'background_verification',
    attrs: async (tx, id) => {
      const c = await tx.collection('bgv_cases').findOne({ id }, { projection: { employee_id: 1 } });
      const e = c ? await employeeOf(tx, c.employee_id) : null;
      return e ? { attrs: e.attrs, country: e.country } : null;
    },
  },
  candidate: {
    view: 'candidates:read', edit: 'candidates:manage', feature: 'recruitment',
    attrs: async (tx, id) => ((await tx.collection('candidates').exists({ id })) ? {} : null),
  },
  client: {
    view: 'bids:read', edit: 'bids:manage', feature: 'staffing_bids',
    attrs: async (tx, id) => ((await tx.collection('clients').exists({ id })) ? {} : null),
  },
  leave_request: {
    view: 'leave:read', edit: 'leave:request', feature: 'leave',
    attrs: async (tx, id) => {
      const r = await tx.collection('leave_requests').findOne({ id }, { projection: { employee_id: 1 } });
      return r ? employeeOf(tx, r.employee_id) : null;
    },
  },
};

export function definitionView(d: Doc): CustomFieldDefinition {
  return {
    id: d.id, entity: d.entity, key: d.key, label: d.label, type: d.type, helpText: d.help_text ?? null, required: !!d.required, defaultValue: d.default_value ?? null,
    options: d.options ?? [], position: d.position ?? 0, section: d.section ?? null, enabled: !!d.enabled, archivedAt: d.archived_at ? new Date(d.archived_at).toISOString() : null,
    viewRoles: d.view_roles ?? [], editRoles: d.edit_roles ?? [], employeeEditable: !!d.employee_editable, config: d.config ?? {},
    searchable: !!d.searchable, importable: d.importable !== false,
  };
}

/**
 * Fields whose options come from a Master data list get that list's values as options (disabled values stay as
 * archived options, so records holding them keep showing them). Changes the rows in place and returns them.
 */
export async function withListOptions(tx: TenantTx, rows: Doc[]): Promise<Doc[]> {
  const lists = [...new Set(rows.map((r) => r.config?.masterList).filter(Boolean))] as string[];
  for (const list of lists) {
    const entries = await listEntries(tx, list as never);
    const options = entries.map((e) => ({ value: e.key, label: e.label, ...(e.disabled ? { archived: true } : {}) }));
    for (const r of rows) if (r.config?.masterList === list) r.options = options;
  }
  return rows;
}

/**
 * Custom fields. HR Workspace Admin (fields:manage) defines them per kind of record; the record's own pages read and
 * write the values through this service, with the record's permissions plus each field's own view and edit roles.
 * Nothing is deleted: archiving a field (or an option) hides it from forms and keeps every value; a field that
 * never held a value can be deleted outright. Every change to a definition and to a value is audited.
 */
@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------------------------------------------------
  // Definitions
  // ---------------------------------------------------------------------------------------------------------

  async definitions(entity?: CustomFieldEntity, includeArchived = false) {
    return this.db.tenant(async (tx) => {
      const filter: Doc = {};
      if (entity) filter.entity = entity;
      const manage = await this.canManage(tx);
      if (!includeArchived || !manage) filter.archived_at = null;
      const reach = fieldReach(await this.authz.subject(tx));
      const rows = (await withListOptions(tx, await tx.collection('custom_fields').find(filter, { sort: { entity: 1, position: 1, created_at: 1 } }))).filter((r) => !r.hr_workspace_id || !reach || reach.has(r.hr_workspace_id));
      const usage = manage ? new Map((await tx.collection('custom_field_values').aggregate<{ _id: string; n: number }>([{ $match: { field_id: { $in: rows.map((r) => r.id) }, value: { $ne: null } } }, { $group: { _id: '$field_id', n: { $sum: 1 } } }])).map((x) => [x._id, x.n])) : new Map();
      return rows.map((r) => ({ ...definitionView(r), ...(manage ? { valueCount: usage.get(r.id) ?? 0 } : {}) }));
    });
  }

  /** A Candidate CRM field made by one HR Workspace can be changed only by Super Workspace or that HR Workspace. */
  private async ownField(tx: TenantTx, f: Doc) {
    const reach = fieldReach(await this.authz.subject(tx));
    if (f.hr_workspace_id && reach && !reach.has(f.hr_workspace_id)) throw Errors.notFound('Field');
  }

  private async canManage(tx: TenantTx) {
    const s = await this.authz.subject(tx);
    return s.grants.some((g) => g.permission === 'fields:manage');
  }

  private async validateRoles(tx: TenantTx, keys: string[]) {
    if (!keys.length) return;
    const found = await tx.collection('roles').distinct<string>('key', { key: { $in: keys } });
    const missing = keys.filter((k) => !found.includes(k));
    if (missing.length) throw Errors.validation([{ path: 'viewRoles', message: `Unknown role: ${missing.join(', ')}` }]);
  }

  private checkDefault(d: { type: string; options: { value: string; label: string; archived?: boolean }[]; config: Doc; label: string; defaultValue?: unknown }) {
    if (d.defaultValue === undefined || d.defaultValue === null || d.defaultValue === '') return null;
    if (d.type === 'file') throw Errors.validation([{ path: 'defaultValue', message: 'A file field cannot have a default' }]);
    const r = checkFieldValue({ ...d, required: false, type: d.type as never, config: d.config }, d.defaultValue);
    if (!r.ok) throw Errors.validation([{ path: 'defaultValue', message: r.error }]);
    return r.value;
  }

  async create(input: z.infer<typeof customFieldInput>) {
    return this.db.tenant(async (tx) => {
      await this.requireSuper(tx);
      return this.createIn(tx, input);
    });
  }

  /**
   * Form management (issue #91): the Super Workspace is the one place forms are set up, so only it adds, changes,
   * hides, orders or removes fields. HR Workspaces fill the fields in. (A data import that adds a column as a new
   * field goes through createIn, under the import's own permission.)
   */
  private async requireSuper(tx: TenantTx) {
    await this.authz.require('fields:manage', undefined, tx);
    const actor = requestContext.get()?.actor;
    if (!actor || actor.kind !== 'user' || !(await isSuperWorkspace(tx, requestContext.tenantActor().membershipId))) {
      throw Errors.forbidden('Only the Super Workspace sets up forms and their fields (Settings > Form management)');
    }
  }

  /** create() inside a transaction the caller holds (a data import adds a field while it saves the column mapping). */
  async createIn(tx: TenantTx, input: z.infer<typeof customFieldInput>, via?: string) {
    {
      await this.authz.require('fields:manage', undefined, tx);
      const key = input.key ?? fieldKeyFromLabel(input.label);
      if (await tx.collection('custom_fields').exists({ entity: input.entity, key })) throw Errors.validation([{ path: input.key ? 'key' : 'label', message: `A field with the key ${key} already exists on ${CUSTOM_FIELD_ENTITY_LABEL[input.entity]}` }]);
      await this.validateRoles(tx, [...input.viewRoles, ...input.editRoles]);
      if (input.employeeEditable && input.entity !== 'employee') throw Errors.validation([{ path: 'employeeEditable', message: 'Only employee profile fields can be filled in by employees' }]);
      if (input.config.masterList && !OPTION_TYPES.includes(input.type)) throw Errors.validation([{ path: 'config.masterList', message: 'Only dropdown, radio and multi-select fields take their options from a list' }]);
      const ownOptions = OPTION_TYPES.includes(input.type) && !input.config.masterList ? input.options : [];
      const [probe] = await withListOptions(tx, [{ config: input.config, options: ownOptions }]);
      const defaultValue = this.checkDefault({ ...input, options: probe!.options });
      const position = await tx.collection('custom_fields').count({ entity: input.entity });
      const row = await tx.collection('custom_fields').insert({
        entity: input.entity, key, label: input.label, type: input.type, help_text: input.helpText ?? null, required: input.required, default_value: defaultValue,
        options: ownOptions, position, section: input.section ?? null, enabled: input.enabled,
        view_roles: asLevels(input.viewRoles), edit_roles: asLevels(input.editRoles), employee_editable: input.employeeEditable, config: input.config,
        searchable: input.searchable, importable: input.importable,
        created_by_membership_id: actorMembership(), updated_by_membership_id: actorMembership(),
      });
      await this.audit.record(tx, { action: 'custom_field.created', resourceType: 'custom_field', resourceId: row.id, changes: { after: definitionView(row) }, ...(via ? { metadata: { via } } : {}) });
      return definitionView((await withListOptions(tx, [row]))[0]!);
    }
  }

  async update(id: string, input: z.infer<typeof customFieldUpdate>) {
    return this.db.tenant(async (tx) => {
      await this.requireSuper(tx);
      const before = await tx.collection('custom_fields').findOne({ id });
      if (!before) throw Errors.notFound('Field');
      await this.ownField(tx, before);
      if (before.archived_at) throw Errors.conflict('field_archived', 'Restore the field before changing it');
      const type = input.type ?? before.type;
      let options = input.options ?? before.options ?? [];
      if (OPTION_TYPES.includes(type) && input.options) {
        // An option in use cannot disappear: it is archived instead, so records that hold it keep showing it.
        const used = new Set((await tx.collection('custom_field_values').find({ field_id: id }, { projection: { value: 1 } })).flatMap((v) => (Array.isArray(v.value) ? v.value : [v.value])).filter((x) => typeof x === 'string'));
        const kept = new Set(options.map((o: { value: string }) => o.value));
        const dropped = (before.options ?? []).filter((o: { value: string }) => !kept.has(o.value) && used.has(o.value)).map((o: Doc) => ({ ...o, archived: true }));
        options = [...options, ...dropped];
      }
      if (OPTION_TYPES.includes(type) && !(input.config ?? before.config ?? {}).masterList && !options.some((o: { archived?: boolean }) => !o.archived)) throw Errors.validation([{ path: 'options', message: 'Add at least one option' }]);
      await this.validateRoles(tx, [...(input.viewRoles ?? []), ...(input.editRoles ?? [])]);
      if (input.employeeEditable && before.entity !== 'employee') throw Errors.validation([{ path: 'employeeEditable', message: 'Only employee profile fields can be filled in by employees' }]);
      const config = input.config ?? before.config ?? {};
      const set: Doc = { updated_by_membership_id: actorMembership() };
      if (input.label !== undefined) set.label = input.label;
      if (input.type !== undefined) set.type = input.type;
      if (input.helpText !== undefined) set.help_text = input.helpText;
      if (input.required !== undefined) set.required = input.required;
      if (input.section !== undefined) set.section = input.section;
      if (input.enabled !== undefined) set.enabled = input.enabled;
      if (input.viewRoles !== undefined) set.view_roles = asLevels(input.viewRoles);
      if (input.editRoles !== undefined) set.edit_roles = asLevels(input.editRoles);
      if (input.employeeEditable !== undefined) set.employee_editable = input.employeeEditable;
      if (input.searchable !== undefined) set.searchable = input.searchable;
      if (input.importable !== undefined) set.importable = input.importable;
      if (input.config !== undefined) set.config = input.config;
      if (config.masterList && !OPTION_TYPES.includes(type)) throw Errors.validation([{ path: 'config.masterList', message: 'Only dropdown, radio and multi-select fields take their options from a list' }]);
      set.options = OPTION_TYPES.includes(type) && !config.masterList ? options : [];
      if (input.defaultValue !== undefined || input.type !== undefined || input.options !== undefined || input.config !== undefined) {
        const [probe] = await withListOptions(tx, [{ config, options: set.options }]);
        set.default_value = this.checkDefault({ type, options: probe!.options, config, label: input.label ?? before.label, defaultValue: input.defaultValue !== undefined ? input.defaultValue : before.default_value });
      }
      const after = (await withListOptions(tx, [(await tx.collection('custom_fields').updateAndGet({ id }, { $set: set }))!]))[0];
      await withListOptions(tx, [before]);
      const b = definitionView(before);
      const a = definitionView(after!);
      const changes = Object.fromEntries(Object.keys(a).filter((k) => JSON.stringify((a as never)[k]) !== JSON.stringify((b as never)[k])).map((k) => [k, { from: (b as never)[k], to: (a as never)[k] }]));
      // A type change keeps every stored value; how many no longer fit is reported so HR can fix them.
      let mismatched = 0;
      if (input.type && input.type !== before.type) {
        for (const v of await tx.collection('custom_field_values').find({ field_id: id, value: { $ne: null } })) if (!checkFieldValue({ ...a, required: false }, v.value).ok) mismatched++;
      }
      await this.audit.record(tx, { action: 'custom_field.updated', resourceType: 'custom_field', resourceId: id, changes, metadata: mismatched ? { valuesNotMatchingNewType: mismatched } : undefined });
      return { ...a, valuesNotMatchingType: mismatched };
    });
  }

  async archive(id: string, archived: boolean) {
    return this.db.tenant(async (tx) => {
      await this.requireSuper(tx);
      const f = await tx.collection('custom_fields').findOne({ id });
      if (!f) throw Errors.notFound('Field');
      await this.ownField(tx, f);
      await tx.collection('custom_fields').updateOne({ id }, { $set: { archived_at: archived ? f.archived_at ?? new Date() : null, updated_by_membership_id: actorMembership() } });
      await this.audit.record(tx, { action: archived ? 'custom_field.archived' : 'custom_field.restored', resourceType: 'custom_field', resourceId: id, changes: { key: f.key, label: f.label, entity: f.entity } });
      return definitionView((await tx.collection('custom_fields').findOne({ id }))!);
    });
  }

  /** Deletes a field that never held a value. Fields with values must be archived, so no history is lost. */
  async remove(id: string) {
    return this.db.tenant(async (tx) => {
      await this.requireSuper(tx);
      const f = await tx.collection('custom_fields').findOne({ id });
      if (!f) throw Errors.notFound('Field');
      await this.ownField(tx, f);
      const used = await tx.collection('custom_field_values').count({ field_id: id, value: { $ne: null } });
      if (used || (await tx.collection('custom_field_files').exists({ field_id: id }))) throw Errors.conflict('field_in_use', `${used} record${used === 1 ? ' holds' : 's hold'} a value in this field. Archive it instead: it disappears from forms and the values are kept.`);
      await tx.collection('custom_field_values').delete({ field_id: id });
      await tx.collection('custom_fields').deleteOne({ id });
      await this.audit.record(tx, { action: 'custom_field.deleted', resourceType: 'custom_field', resourceId: id, changes: { before: definitionView(f) } });
    });
  }

  async reorder(input: z.infer<typeof customFieldReorder>) {
    return this.db.tenant(async (tx) => {
      await this.requireSuper(tx);
      const rows = await tx.collection('custom_fields').find({ entity: input.entity }, { projection: { _id: 1 } });
      const known = new Set(rows.map((r) => r.id as string));
      if (input.ids.some((x) => !known.has(x)) || new Set(input.ids).size !== input.ids.length) throw Errors.badRequest('invalid_order', 'The list must name fields of this form, once each');
      // Fields left out keep their order after the ones listed.
      const rest = rows.map((r) => r.id as string).filter((x) => !input.ids.includes(x));
      for (const [i, fid] of [...input.ids, ...rest].entries()) await tx.collection('custom_fields').updateOne({ id: fid }, { $set: { position: i } });
      await this.audit.record(tx, { action: 'custom_field.reordered', resourceType: 'custom_field', changes: { entity: input.entity, order: input.ids } });
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Values
  // ---------------------------------------------------------------------------------------------------------

  /** The access levels the person counts as (Super Workspace also counts as HR Workspace). */
  private roleKeys(s: Subject) {
    const keys = new Set(s.grants.map((g) => g.roleKey));
    return new Set(impliedLevelKeys(keys.has('super_workspace') ? 'super' : keys.has('hr_workspace') ? 'hr' : 'employee'));
  }

  private async access(tx: TenantTx, entity: CustomFieldEntity, recordId: string) {
    const rule = RULES[entity];
    const rec = await rule.attrs(tx, recordId);
    if (!rec) throw Errors.notFound('Record');
    const s = await this.authz.subject(tx);
    const covers = (perm: string) => grantsFor(s, perm).some((g) => !rec.attrs || grantCovers(s, g, rec.attrs));
    const isSelf = !!rec.selfEmployeeId && s.employeeId === rec.selfEmployeeId;
    if (!covers(rule.view)) throw Errors.notFound('Record');
    // Candidates: the ATS and Candidate CRM rules on whose candidates a person may see; an HR Workspace's own fields
    // apply only to its own candidates.
    let owner: string | null = null;
    if (entity === 'candidate') {
      const c = await tx.collection('candidates').findOne({ $and: [{ id: recordId }, await candidateScopeFilter(tx, s, rule.view)] }, { projection: { crm_hr_workspace_id: 1 } });
      if (!c) throw Errors.notFound('Record');
      owner = (c.crm_hr_workspace_id as string | null) ?? null;
    }
    return { rec, s, canEditRecord: covers(rule.edit), isSelf, roles: this.roleKeys(s), applies: (d: Doc) => !d.hr_workspace_id || d.hr_workspace_id === owner };
  }

  private visible(d: Doc, roles: Set<string>) {
    return !d.view_roles?.length || d.view_roles.some((r: string) => roles.has(levelRoleKeyFor(r)));
  }

  private editable(d: Doc, a: { canEditRecord: boolean; isSelf: boolean; roles: Set<string> }) {
    if (d.archived_at || !d.enabled) return false;
    // The employee themself: only fields HR opened to them.
    if (a.isSelf && !a.canEditRecord) return !!d.employee_editable;
    if (a.isSelf && d.employee_editable) return true;
    if (!a.canEditRecord) return false;
    return !d.edit_roles?.length || d.edit_roles.some((r: string) => a.roles.has(levelRoleKeyFor(r)));
  }

  /** The fields of one record with their values, as the record's page shows them. Archived fields appear only when they hold a value. */
  async values(entity: CustomFieldEntity, recordId: string) {
    return this.db.tenant(async (tx) => {
      const a = await this.access(tx, entity, recordId);
      const defs = (await withListOptions(tx, await tx.collection('custom_fields').find({ entity }, { sort: { position: 1, created_at: 1 } }))).filter(a.applies);
      const vals = new Map((await tx.collection('custom_field_values').find({ entity, record_id: recordId })).map((v) => [v.field_id as string, v.value]));
      return defs
        .filter((d) => this.visible(d, a.roles) && (d.enabled || vals.has(d.id)) && (!d.archived_at || (vals.get(d.id) !== undefined && vals.get(d.id) !== null)))
        .map((d) => {
          const def = definitionView(d);
          const value = vals.has(d.id) ? vals.get(d.id) : null;
          const fits = value === null || checkFieldValue({ ...def, required: false }, value, { allowedArchived: value }).ok;
          return { field: def, value, text: fieldValueText(def, value), editable: this.editable(d, a), fits };
        });
    });
  }

  /**
   * Saves values for one record. Only fields the member may change are accepted; a required field must have a value
   * (its default when it was never filled in). Values of fields not named stay as they are.
   */
  async save(entity: CustomFieldEntity, recordId: string, values: Record<string, unknown>, opts: { tx?: TenantTx; creating?: boolean } = {}) {
    const run = async (tx: TenantTx) => {
      const a = await this.access(tx, entity, recordId);
      const defs = (await withListOptions(tx, await tx.collection('custom_fields').find({ entity, archived_at: null, enabled: true }))).filter(a.applies);
      const byKey = new Map(defs.map((d) => [d.key as string, d]));
      const existing = new Map((await tx.collection('custom_field_values').find({ entity, record_id: recordId })).map((v) => [v.field_id as string, v]));
      const problems: { path: string; message: string }[] = [];
      const writes: { d: Doc; value: unknown }[] = [];
      for (const [key, raw] of Object.entries(values)) {
        const d = byKey.get(key);
        if (!d) { problems.push({ path: `customFields.${key}`, message: 'Unknown or archived field' }); continue; }
        if (!this.editable(d, a) || !this.visible(d, a.roles)) { problems.push({ path: `customFields.${key}`, message: 'You cannot change this field' }); continue; }
        const prev = existing.get(d.id)?.value;
        const r = checkFieldValue(definitionView(d), raw, { country: a.rec.country ?? null, allowedArchived: prev });
        if (!r.ok) { problems.push({ path: `customFields.${key}`, message: r.error }); continue; }
        if (d.type === 'file' && r.value) {
          const fv = r.value as { fileId: string };
          if (!(await tx.collection('custom_field_files').exists({ id: fv.fileId, field_id: d.id, record_id: recordId }))) { problems.push({ path: `customFields.${key}`, message: 'Upload the file again' }); continue; }
        }
        writes.push({ d, value: r.value });
      }
      // Required fields the member can fill in must not end up empty.
      for (const d of defs) {
        if (!d.required || !this.editable(d, a)) continue;
        const w = writes.find((x) => x.d.id === d.id);
        const now = w ? w.value : existing.get(d.id)?.value ?? (opts.creating ? d.default_value : undefined);
        if ((now === undefined || now === null || now === '' || now === false || (Array.isArray(now) && !now.length)) && (opts.creating || w || values[d.key] !== undefined || existing.has(d.id) === false)) {
          if (opts.creating && d.default_value !== null && d.default_value !== undefined && !w) { writes.push({ d, value: d.default_value }); continue; }
          if (w || opts.creating) problems.push({ path: `customFields.${d.key}`, message: `${d.label} is required` });
        }
      }
      if (problems.length) throw Errors.validation(problems);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const w of writes) {
        const prev = existing.get(w.d.id)?.value ?? null;
        if (JSON.stringify(prev) === JSON.stringify(w.value)) continue;
        await tx.collection('custom_field_values').upsert({ field_id: w.d.id, record_id: recordId }, { field_id: w.d.id, entity, record_id: recordId, value: w.value, updated_by_membership_id: actorMembership() }, { $set: { value: w.value, updated_by_membership_id: actorMembership() } });
        changes[w.d.key] = { from: prev, to: w.value };
      }
      if (Object.keys(changes).length) await this.audit.record(tx, { action: 'custom_field.values_changed', resourceType: entity, resourceId: recordId, changes });
      return Object.keys(changes);
    };
    if (opts.tx) return run(opts.tx);
    return this.db.tenant(async (tx) => {
      await run(tx);
      return null;
    }).then(() => this.values(entity, recordId));
  }

  async uploadFile(entity: CustomFieldEntity, recordId: string, key: string, file: UploadedFile | undefined) {
    const actor = requestContext.tenantActor();
    const fieldId = await this.db.tenant(async (tx) => {
      const a = await this.access(tx, entity, recordId);
      const d = (await tx.collection('custom_fields').find({ entity, key, archived_at: null, enabled: true, type: 'file' })).find(a.applies);
      if (!d) throw Errors.notFound('Field');
      if (!this.editable(d, a)) throw Errors.forbidden('You cannot change this field');
      return d.id as string;
    });
    const stored = await storeUpload(this.storage, actor.tenantId, file);
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('custom_field_files').insert({ field_id: fieldId, record_id: recordId, uploaded_by_membership_id: actor.membershipId, ...stored });
      await this.audit.record(tx, { action: 'custom_field.file_uploaded', resourceType: entity, resourceId: recordId, metadata: { field: key, fileId: f.id, sha256: stored.sha256 } });
      return { fileId: f.id as string, fileName: stored.file_name };
    });
  }

  async fileLink(fileId: string) {
    return this.db.tenant(async (tx) => {
      const f = await tx.collection('custom_field_files').findOne({ id: fileId });
      if (!f) throw Errors.notFound('File');
      const d = await tx.collection('custom_fields').findOne({ id: f.field_id });
      const a = await this.access(tx, d!.entity, f.record_id);
      if (!this.visible(d!, a.roles)) throw Errors.notFound('File');
      await this.audit.record(tx, { action: 'custom_field.file_downloaded', resourceType: d!.entity, resourceId: f.record_id, metadata: { fileId } });
      return this.storage.sign(fileId, 300, 'fields');
    });
  }

  async openFile(fileId: string, exp: number, sig: string) {
    if (!this.storage.verify(fileId, exp, sig, 'fields')) throw Errors.notFound('File');
    const f = await this.db.platform((tx) => tx.collection('custom_field_files').findOne({ id: fileId }));
    if (!f) throw Errors.notFound('File');
    return { ...(await this.storage.open(f.storage_key)), fileName: f.file_name as string, contentType: f.content_type as string };
  }

  /** The audit trail of field definition changes, for HR Workspace Admin. */
  async history(limit = 100) {
    return this.db.tenant(async (tx) => {
      await this.authz.require('fields:manage', undefined, tx);
      const rows = await tx.collection('audit_events').find({ resource_type: 'custom_field' }, { sort: { created_at: -1 }, limit });
      return rows.map((r) => ({ id: r.id as string, action: r.action as string, fieldId: r.resource_id ?? null, by: r.actor_label ?? null, at: r.created_at, changes: r.changes }));
    });
  }
}

/**
 * The HR Workspaces whose own Candidate CRM fields a person may see and change: null for everyone's (Super Workspace
 * and company-wide HR), otherwise the HR Workspaces they run.
 */
function fieldReach(s: Subject): Set<string> | null {
  if (s.grants.some((g) => g.roleKey === 'super_workspace')) return null;
  const hr = s.grants.filter((g) => g.roleKey === 'hr_workspace');
  if (hr.some((g) => !g.constraints.hrWorkspaceIds?.length)) return null;
  return new Set(hr.flatMap((g) => g.constraints.hrWorkspaceIds ?? []));
}

/** Fields are shown or editable by access level; a role key from before the levels is saved as the level it became. */
function asLevels(keys: string[]): string[] {
  return [...new Set(keys.map(levelRoleKeyFor))].sort();
}

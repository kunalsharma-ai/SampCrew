import { Injectable } from '@nestjs/common';
import {
  checkFieldValue, CRM_CENTRAL, CRM_FIELD_FLAGS, type CrmFieldFlag, type CrmFieldInput, type crmFieldUpdate, type CustomFieldDefinition, fieldKeyFromLabel,
  fieldValueText, isOptionField,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { definitionView } from '../custom-fields/custom-fields.service';
import { type CrmActor, CrmAccessService } from './crm-access.service';
import { actorMembership, type Doc } from './crm-common';

export interface CrmFieldView extends CustomFieldDefinition {
  name: string;
  description: string | null;
  placeholder: string | null;
  flags: CrmFieldFlag[];
  hrWorkspaceId: string | null;
  hrWorkspaceName: string | null;
  valueCount?: number;
  canEdit: boolean;
}

/**
 * Candidate CRM custom fields. They are the shared custom fields of candidates (custom_fields, entity "candidate"),
 * so the ATS profile and the CRM read the same values. A field is company-wide (made by Super Workspace) or belongs to
 * one HR Workspace and is used only on that HR Workspace's candidates. Each field says where it appears: the form, the
 * profile, import mapping, filters and export. Nothing is hard-coded in the pages: they render what this returns.
 */
@Injectable()
export class CrmFieldsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly access: CrmAccessService,
    private readonly audit: AuditService,
  ) {}

  /** The fields that apply to candidates owned by `owner` (null: company-wide), optionally only those with a flag. */
  async definitionsFor(tx: TenantTx, owner: string | null, flag?: CrmFieldFlag, includeInactive = false): Promise<Doc[]> {
    const rows = await tx.collection('custom_fields').find({ entity: 'candidate', archived_at: null, ...(includeInactive ? {} : { enabled: true }), $or: [{ hr_workspace_id: null }, ...(owner ? [{ hr_workspace_id: owner }] : [])] }, { sort: { position: 1, created_at: 1 } });
    return flag ? rows.filter((r) => flagsOf(r).includes(flag)) : rows;
  }

  /** Fields across every HR Workspace the person works in (for the list's filters and the export picker). */
  async definitionsForActor(tx: TenantTx, a: CrmActor, flag?: CrmFieldFlag): Promise<Doc[]> {
    const own = a.level === 'super' ? null : a.keys.filter((k) => k !== CRM_CENTRAL);
    const rows = await tx.collection('custom_fields').find({ entity: 'candidate', archived_at: null, enabled: true, ...(own ? { $or: [{ hr_workspace_id: null }, { hr_workspace_id: { $in: own } }] } : {}) }, { sort: { position: 1, created_at: 1 } });
    return flag ? rows.filter((r) => flagsOf(r).includes(flag)) : rows;
  }

  view(d: Doc, names: Map<string, string>, a: CrmActor, count?: number): CrmFieldView {
    const base = definitionView(d);
    return {
      ...base, name: d.key, description: d.help_text ?? null, placeholder: d.config?.placeholder ?? null, flags: flagsOf(d), hrWorkspaceId: d.hr_workspace_id ?? null,
      hrWorkspaceName: d.hr_workspace_id ? names.get(d.hr_workspace_id) ?? null : null, ...(count !== undefined ? { valueCount: count } : {}),
      canEdit: this.canEditField(a, d),
    };
  }

  private canEditField(a: CrmActor, d: Doc) {
    if (a.level === 'super') return true;
    if (!d.hr_workspace_id) return false;
    return a.keys.includes(d.hr_workspace_id) && !!a.caps.get(d.hr_workspace_id)?.has('fields');
  }

  async list() {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const own = a.level === 'super' ? null : a.keys.filter((k) => k !== CRM_CENTRAL);
      const rows = await tx.collection('custom_fields').find({ entity: 'candidate', ...(own ? { $or: [{ hr_workspace_id: null }, { hr_workspace_id: { $in: own } }] } : {}) }, { sort: { position: 1, created_at: 1 } });
      const counts = new Map((await tx.collection('custom_field_values').aggregate<{ id: string; n: number }>([{ $match: { field_id: { $in: rows.map((r) => r.id) }, value: { $ne: null } } }, { $group: { _id: '$field_id', n: { $sum: 1 } } }])).map((x) => [x.id, x.n]));
      const names = await this.spaceNames(tx);
      return {
        fields: rows.map((r) => ({ ...this.view(r, names, a, counts.get(r.id) ?? 0), archivedAt: r.archived_at ?? null })),
        canCreate: this.access.has(a, 'fields'),
        /** Where a new field can be made: company-wide (Super Workspace) and/or the HR Workspaces allowed to. */
        owners: a.level === 'super'
          ? [{ id: null, name: 'Company-wide (every HR Workspace)' }, ...[...names.entries()].map(([id, name]) => ({ id, name }))]
          : a.keys.filter((k) => k !== CRM_CENTRAL && a.caps.get(k)?.has('fields')).map((k) => ({ id: k, name: names.get(k) ?? 'HR Workspace' })),
      };
    });
  }

  /** The fields the candidate form shows for a record owned by `owner` (the person's own HR Workspace by default). */
  async formFields(owner: string | null | undefined) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx);
      const o = this.access.ownerFor(a, owner);
      const names = await this.spaceNames(tx);
      return (await this.definitionsFor(tx, o, 'form')).map((d) => this.view(d, names, a));
    });
  }

  private async spaceNames(tx: TenantTx) {
    return new Map((await tx.collection('hr_workspaces').find({}, { projection: { name: 1 } })).map((w) => [w.id as string, w.name as string]));
  }

  async create(input: CrmFieldInput) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      let owner: string | null;
      if (a.level === 'super') owner = input.hrWorkspaceId ?? null;
      else {
        const allowed = a.keys.filter((k) => k !== CRM_CENTRAL && a.caps.get(k)?.has('fields'));
        owner = input.hrWorkspaceId ?? allowed[0] ?? null;
        if (!owner || !allowed.includes(owner)) throw Errors.forbiddenCode('crm_cap_missing', 'Your Super Workspace has not given your HR Workspace "Create custom fields" in Candidate CRM.');
      }
      if (owner && !(await tx.collection('hr_workspaces').exists({ id: owner, status: { $ne: 'archived' } }))) throw Errors.badRequest('unknown_hr_workspace', 'Choose an HR Workspace');
      const key = input.name ?? fieldKeyFromLabel(input.label);
      await this.checkKey(tx, key, owner);
      const options = isOptionField(input.type) ? input.options : [];
      const config = configOf(input);
      const def = { type: input.type, options, config, label: input.label, required: false };
      let defaultValue: unknown = null;
      if (input.defaultValue !== undefined && input.defaultValue !== null && input.defaultValue !== '') {
        const r = checkFieldValue(def as never, input.defaultValue);
        if (!r.ok) throw Errors.validation([{ path: 'defaultValue', message: r.error }]);
        defaultValue = r.value;
      }
      const position = input.position ?? (await tx.collection('custom_fields').count({ entity: 'candidate' }));
      const row = await tx.collection('custom_fields').insert({
        entity: 'candidate', key, label: input.label, type: input.type, help_text: input.description, required: input.required, default_value: defaultValue, options,
        position, section: input.group, enabled: input.active, view_roles: [], edit_roles: [], employee_editable: false, config, hr_workspace_id: owner,
        created_by_membership_id: actorMembership(), updated_by_membership_id: actorMembership(),
      });
      await this.audit.record(tx, { action: 'custom_field.created', resourceType: 'custom_field', resourceId: row.id, changes: { after: definitionView(row), hrWorkspaceId: owner, module: 'candidate_crm' } });
      return this.view(row, await this.spaceNames(tx), a);
    });
  }

  /** Keys are unique among the fields that can apply to the same candidate (company-wide plus one HR Workspace's). */
  private async checkKey(tx: TenantTx, key: string, owner: string | null) {
    const clash = await tx.collection('custom_fields').exists({ entity: 'candidate', key, ...(owner ? { $or: [{ hr_workspace_id: null }, { hr_workspace_id: owner }] } : {}) });
    if (clash) throw Errors.validation([{ path: 'name', message: `A candidate field named ${key} already exists. Choose another name.` }]);
  }

  async update(id: string, input: z.infer<typeof crmFieldUpdate>) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const before = await this.editable(tx, a, id);
      const type = input.type ?? before.type;
      let options = input.options ?? before.options ?? [];
      if (isOptionField(type) && input.options) {
        // An option in use is archived instead of removed, so candidates holding it keep showing it.
        const used = new Set((await tx.collection('custom_field_values').find({ field_id: id }, { projection: { value: 1 } })).flatMap((v) => (Array.isArray(v.value) ? v.value : [v.value])).filter((x) => typeof x === 'string'));
        const kept = new Set(options.map((o: { value: string }) => o.value));
        options = [...options, ...(before.options ?? []).filter((o: Doc) => !kept.has(o.value) && used.has(o.value)).map((o: Doc) => ({ ...o, archived: true }))];
      }
      if (isOptionField(type) && !options.some((o: Doc) => !o.archived)) throw Errors.validation([{ path: 'options', message: 'Add at least one option' }]);
      const merged = { ...{ description: before.help_text, placeholder: before.config?.placeholder, validation: before.config ?? {}, flags: flagsOf(before) }, ...input };
      const set: Doc = { updated_by_membership_id: actorMembership(), options: isOptionField(type) ? options : [], config: configOf(merged as never) };
      if (input.label !== undefined) set.label = input.label;
      if (input.type !== undefined) set.type = input.type;
      if (input.description !== undefined) set.help_text = input.description;
      if (input.required !== undefined) set.required = input.required;
      if (input.group !== undefined) set.section = input.group;
      if (input.active !== undefined) set.enabled = input.active;
      if (input.position !== undefined) set.position = input.position;
      if (input.defaultValue !== undefined) {
        const r = input.defaultValue === null || input.defaultValue === '' ? { ok: true as const, value: null } : checkFieldValue({ type, options: set.options, config: set.config, label: input.label ?? before.label, required: false } as never, input.defaultValue);
        if (!r.ok) throw Errors.validation([{ path: 'defaultValue', message: r.error }]);
        set.default_value = r.value;
      }
      const after = (await tx.collection('custom_fields').updateAndGet({ id }, { $set: set }))!;
      const b = definitionView(before);
      const v = definitionView(after);
      await this.audit.record(tx, {
        action: 'custom_field.updated', resourceType: 'custom_field', resourceId: id,
        changes: Object.fromEntries(Object.keys(v).filter((k) => JSON.stringify((v as never)[k]) !== JSON.stringify((b as never)[k])).map((k) => [k, { from: (b as never)[k], to: (v as never)[k] }])),
      });
      return this.view(after, await this.spaceNames(tx), a);
    });
  }

  async archive(id: string, archived: boolean) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      const f = await this.editable(tx, a, id);
      await tx.collection('custom_fields').updateOne({ id }, { $set: { archived_at: archived ? f.archived_at ?? new Date() : null, updated_by_membership_id: actorMembership() } });
      await this.audit.record(tx, { action: archived ? 'custom_field.archived' : 'custom_field.restored', resourceType: 'custom_field', resourceId: id, changes: { key: f.key, label: f.label, entity: 'candidate' } });
      return { archived };
    });
  }

  async reorder(ids: string[]) {
    return this.db.tenant(async (tx) => {
      const a = await this.access.actor(tx, 'manage');
      for (const [i, id] of ids.entries()) {
        await this.editable(tx, a, id);
        await tx.collection('custom_fields').updateOne({ id }, { $set: { position: i } });
      }
      await this.audit.record(tx, { action: 'custom_field.reordered', resourceType: 'custom_field', changes: { entity: 'candidate', order: ids } });
      return { ok: true };
    });
  }

  private async editable(tx: TenantTx, a: CrmActor, id: string) {
    const f = await tx.collection('custom_fields').findOne({ id, entity: 'candidate' });
    if (!f) throw Errors.notFound('Field');
    if (f.hr_workspace_id && a.level !== 'super' && !a.keys.includes(f.hr_workspace_id)) throw Errors.notFound('Field');
    if (!this.canEditField(a, f)) throw Errors.forbiddenCode('crm_cap_missing', f.hr_workspace_id ? 'Your Super Workspace has not given your HR Workspace "Create custom fields".' : 'Company-wide fields are changed by Super Workspace.');
    return f;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Values
  // ------------------------------------------------------------------------------------------------------------

  /**
   * Checks custom field values for a candidate owned by `owner`. Returns the values to store (by field id) or throws
   * a validation error naming each field. `creating`: required fields must be filled (defaults apply).
   */
  async check(tx: TenantTx, owner: string | null, values: Record<string, unknown>, opts: { creating?: boolean; existing?: Map<string, unknown>; flag?: CrmFieldFlag } = {}) {
    const defs = await this.definitionsFor(tx, owner);
    const byKey = new Map(defs.map((d) => [d.key as string, d]));
    const problems: { path: string; message: string }[] = [];
    const writes = new Map<string, { d: Doc; value: unknown }>();
    for (const [key, raw] of Object.entries(values)) {
      const d = byKey.get(key);
      if (!d) { problems.push({ path: `customFields.${key}`, message: 'This field is not used for this candidate' }); continue; }
      if (d.type === 'file') continue; // files are uploaded on the profile
      const r = checkFieldValue(definitionView(d), raw, { allowedArchived: opts.existing?.get(d.id) });
      if (!r.ok) { problems.push({ path: `customFields.${key}`, message: r.error }); continue; }
      writes.set(d.id, { d, value: r.value });
    }
    if (opts.creating) {
      for (const d of defs) {
        if (writes.has(d.id) || d.type === 'file') continue;
        if (d.default_value !== null && d.default_value !== undefined) writes.set(d.id, { d, value: d.default_value });
        else if (d.required && (!opts.flag || flagsOf(d).includes(opts.flag))) problems.push({ path: `customFields.${d.key}`, message: `${d.label} is required` });
      }
    } else {
      for (const w of writes.values()) if (w.d.required && (w.value === null || (Array.isArray(w.value) && !w.value.length))) problems.push({ path: `customFields.${w.d.key}`, message: `${w.d.label} is required` });
    }
    return { writes: [...writes.values()], problems };
  }

  async write(tx: TenantTx, candidateId: string, writes: { d: Doc; value: unknown }[]) {
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const w of writes) {
      const prev = (await tx.collection('custom_field_values').findOne({ field_id: w.d.id, record_id: candidateId }))?.value ?? null;
      if (JSON.stringify(prev) === JSON.stringify(w.value)) continue;
      await tx.collection('custom_field_values').upsert(
        { field_id: w.d.id, record_id: candidateId },
        { field_id: w.d.id, entity: 'candidate', record_id: candidateId, value: w.value, updated_by_membership_id: actorMembership() },
        { $set: { value: w.value, updated_by_membership_id: actorMembership() } },
      );
      changed[w.d.key] = { from: prev, to: w.value };
    }
    return changed;
  }

  /** Values of the given fields for candidates, as { candidateId: { key: { value, text } } }. */
  async values(tx: TenantTx, candidateIds: string[], defs: Doc[]) {
    const out = new Map<string, Record<string, { value: unknown; text: string }>>();
    if (!candidateIds.length || !defs.length) return out;
    const byId = new Map(defs.map((d) => [d.id as string, d]));
    const rows = await tx.collection('custom_field_values').find({ entity: 'candidate', record_id: { $in: candidateIds }, field_id: { $in: [...byId.keys()] } });
    for (const r of rows) {
      const d = byId.get(r.field_id)!;
      const m = out.get(r.record_id) ?? {};
      m[d.key] = { value: r.value, text: fieldValueText(definitionView(d), r.value) };
      out.set(r.record_id, m);
    }
    return out;
  }
}

export function flagsOf(d: Doc): CrmFieldFlag[] {
  const f = d.config?.flags as string[] | undefined;
  return f ? CRM_FIELD_FLAGS.filter((x) => f.includes(x)) : [...CRM_FIELD_FLAGS];
}

function configOf(input: { validation?: Doc; placeholder?: string | null; flags?: string[]; description?: string | null }): Doc {
  const v = input.validation ?? {};
  const out: Doc = {};
  for (const k of ['min', 'max', 'minLength', 'maxLength', 'pattern', 'patternMessage', 'currency']) if (v[k] !== undefined && v[k] !== null && v[k] !== '') out[k] = v[k];
  if (input.placeholder) out.placeholder = input.placeholder;
  out.flags = input.flags ?? [...CRM_FIELD_FLAGS];
  return out;
}
